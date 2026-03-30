import type { API, OpEnv, FileSystemReadWriteComponent } from "@openv-project/openv-api";
import type { InstallOptions, UninstallOptions, VerifyOptions } from "./types/options.js";
import type { InstallResult, UninstallResult, VerifyResult, QueryResult, PackageInfo, BatchInstallResult } from "./types/package.js";
import type { FileSystemAdapter } from "./types/adapters.js";
import { PackageManager } from "./core/manager.js";
import { TarAdapter } from "./adapters/containers/tar.js";
import { GzipAdapter } from "./adapters/compression/gzip.js";
import { ConsoleLogger } from "./adapters/logging/console.js";
import { StdoutLogger } from "./adapters/logging/stdout.js";

export * from "./types/manifest.js";
export * from "./types/package.js";
export * from "./types/options.js";
export * from "./types/adapters.js";
export * from "./adapters/logging/console.js";
export * from "./adapters/logging/stdout.js";

export default class UpkApi implements API<"party.openv.libupk"> {
  name = "party.openv.libupk" as const;

  openv!: OpEnv<FileSystemReadWriteComponent>;
  private managers = new Map<string, PackageManager>();
  private initialized = false;
  
  // Default configuration
  private defaultRootPath: string = "/";
  private defaultDbPath: string = "/var/lib/upk/packages.db";
  private defaultInMemoryDb: boolean = false;

  setDefaultRootPath(path: string): this {
    this.defaultRootPath = path;
    return this;
  }
  
  setDefaultDbPath(path: string): this {
    this.defaultDbPath = path;
    return this;
  }

  setDefaultInMemoryDb(inMemory: boolean): this {
    this.defaultInMemoryDb = inMemory;
    return this;
  }

  configure(options: {
    rootPath?: string;
    dbPath?: string;
    inMemoryDb?: boolean;
  }): this {
    if (options.rootPath !== undefined) this.defaultRootPath = options.rootPath;
    if (options.dbPath !== undefined) this.defaultDbPath = options.dbPath;
    if (options.inMemoryDb !== undefined) this.defaultInMemoryDb = options.inMemoryDb;
    return this;
  }

  getDefaultRootPath(): string {
    return this.defaultRootPath;
  }

  getDefaultDbPath(): string {
    return this.defaultDbPath;
  }

  getDefaultInMemoryDb(): boolean {
    return this.defaultInMemoryDb;
  }

  async initialize(openv: OpEnv<FileSystemReadWriteComponent>): Promise<void> {
    this.openv = openv;

    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("UPK requires write access to the filesystem");
    }

    this.initialized = true;
  }

  private async getManager(
    rootPath: string,
    dbPath: string | null,
    inMemoryDb: boolean
  ): Promise<PackageManager> {
    const key = `${rootPath}:${dbPath}:${inMemoryDb}`;
    
    if (this.managers.has(key)) {
      return this.managers.get(key)!;
    }

    const fsAdapter = this.createFileSystemAdapter(rootPath);
    const manager = new PackageManager(dbPath, fsAdapter, rootPath, inMemoryDb);

    const tarAdapter = new TarAdapter();
    const gzipAdapter = new GzipAdapter();
    tarAdapter.registerCompression(gzipAdapter);
    manager.registerContainerAdapter(tarAdapter);

    await manager.initialize();
    
    this.managers.set(key, manager);
    return manager;
  }

  async install(source: string | Uint8Array, options: InstallOptions = {}): Promise<InstallResult> {
    this.ensureInitialized();

    const rootPath = options.rootPath ?? this.defaultRootPath;
    const inMemoryDb = options.inMemoryDb ?? this.defaultInMemoryDb;
    const dbPath = inMemoryDb ? null : (options.dbPath ?? this.defaultDbPath);

    const manager = await this.getManager(rootPath, dbPath, inMemoryDb);
    const resolvedSource = typeof source === "string" ? await this.readPackageSource(source) : source;
    return await manager.install(resolvedSource, options);
  }

  async installBatch(sources: Array<string | Uint8Array>, options: InstallOptions = {}): Promise<BatchInstallResult> {
    this.ensureInitialized();

    const rootPath = options.rootPath ?? this.defaultRootPath;
    const inMemoryDb = options.inMemoryDb ?? this.defaultInMemoryDb;
    const dbPath = inMemoryDb ? null : (options.dbPath ?? this.defaultDbPath);

    const manager = await this.getManager(rootPath, dbPath, inMemoryDb);
    const resolvedSources = await Promise.all(
      sources.map((source) => typeof source === "string" ? this.readPackageSource(source) : source)
    );
    return await manager.installBatch(resolvedSources, options);
  }

  async uninstall(packageName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    this.ensureInitialized();
    
    const rootPath = options.rootPath ?? this.defaultRootPath;
    const dbPath = options.dbPath ?? this.defaultDbPath;
    
    const manager = await this.getManager(rootPath, dbPath, false);
    return await manager.uninstall(packageName, options);
  }

  async verify(packageName: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    this.ensureInitialized();
    
    const rootPath = options.rootPath ?? this.defaultRootPath;
    const dbPath = this.defaultDbPath;
    
    const manager = await this.getManager(rootPath, dbPath, false);
    return await manager.verify(packageName, options);
  }

  async query(packageName: string, options: { rootPath?: string; dbPath?: string } = {}): Promise<QueryResult> {
    this.ensureInitialized();
    
    const rootPath = options.rootPath ?? this.defaultRootPath;
    const dbPath = options.dbPath ?? this.defaultDbPath;
    
    const manager = await this.getManager(rootPath, dbPath, false);
    return await manager.query(packageName);
  }

  async list(options: { includeAnonymous?: boolean; rootPath?: string; dbPath?: string } = {}): Promise<PackageInfo[]> {
    this.ensureInitialized();
    
    const rootPath = options.rootPath ?? this.defaultRootPath;
    const dbPath = options.dbPath ?? this.defaultDbPath;
    
    const manager = await this.getManager(rootPath, dbPath, false);
    return await manager.list(options);
  }

  createConsoleLogger(): ConsoleLogger {
    return new ConsoleLogger();
  }

  createStdoutLogger(): StdoutLogger {
    return new StdoutLogger();
  }

  private async readPackageSource(path: string): Promise<Uint8Array> {
    const fs = this.openv.system;
    const stat = await fs["party.openv.filesystem.read.stat"]!(path);
    const fd = await fs["party.openv.filesystem.open"](path, "r", 0o444);
    try {
      return await fs["party.openv.filesystem.read.read"]!(fd, stat.size);
    } finally {
      await fs["party.openv.filesystem.close"](fd);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("UPK API not initialized. Call initialize() first.");
    }
  }

  private createFileSystemAdapter(rootPath: string): FileSystemAdapter {
    const fs = this.openv.system;
    const enosys = (operation: string): never => {
      const error = new Error(`ENOSYS: ${operation} not implemented`) as Error & { code?: string };
      error.code = "ENOSYS";
      throw error;
    };
    
    const joinWithRoot = (path: string): string => {
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      if (rootPath === "/") return normalizedPath.replace(/\/+/g, "/");
      const normalizedRoot = rootPath.startsWith("/") ? rootPath : `/${rootPath}`;
      const relative = normalizedPath.replace(/^\/+/, "");
      return `${normalizedRoot}/${relative}`.replace(/\/+/g, "/");
    };
    const normalizePath = (path: string): string => {
      if (!path || path === "") return "/";
      const withSlash = path.startsWith("/") ? path : `/${path}`;
      if (withSlash === "/") return "/";
      return withSlash.replace(/\/+/g, "/").replace(/\/+$/, "");
    };
    const parentPath = (path: string): string => {
      const normalized = normalizePath(path);
      if (normalized === "/") return "/";
      const idx = normalized.lastIndexOf("/");
      return idx <= 0 ? "/" : normalized.slice(0, idx);
    };
    const joinPath = (base: string, child: string): string => {
      const left = normalizePath(base);
      const right = child.replace(/^\/+/, "");
      return normalizePath(`${left}/${right}`);
    };
    const resolveSymlinkedPath = async (path: string): Promise<string> => {
      let current = normalizePath(path);
      const parts = current.split("/").filter(Boolean);
      let resolved = "/";
      for (const part of parts) {
        const candidate = joinPath(resolved, part);
        let linkTarget: string | null = null;
        try {
          if (fs["party.openv.filesystem.read.readlink"]) {
            linkTarget = await fs["party.openv.filesystem.read.readlink"](candidate);
          }
        } catch {
          linkTarget = null;
        }
        if (linkTarget) {
          resolved = linkTarget.startsWith("/")
            ? normalizePath(linkTarget)
            : joinPath(parentPath(candidate), linkTarget);
          continue;
        }
        resolved = candidate;
      }
      return resolved;
    };

    return {
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const fd = await fs["party.openv.filesystem.open"](fullPath, "w", 0o644);
        try {
          await fs["party.openv.filesystem.write.write"]!(fd, data, 0, data.length, 0);
        } finally {
          await fs["party.openv.filesystem.close"](fd);
        }
      },

      async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
        const fullPath = joinWithRoot(path);
        const isAlreadyExists = (error: unknown): boolean => {
          if (!(error instanceof Error)) return false;
          const code = (error as Error & { code?: unknown }).code;
          if (code === "EEXIST") return true;
          return error.message.toUpperCase().includes("EEXIST");
        };
        const ensureDirectoryExists = async (targetPath: string): Promise<boolean> => {
          try {
            const stat = await fs["party.openv.filesystem.read.stat"]!(targetPath);
            return stat.type === "DIRECTORY";
          } catch {
            return false;
          }
        };
        if (options?.recursive) {
          const parts = fullPath.split("/").filter(p => p);
          let current = "";
          for (const part of parts) {
            current = current ? `${current}/${part}` : `/${part}`;
            const resolvedCurrent = await resolveSymlinkedPath(current);
            try {
              await fs["party.openv.filesystem.write.mkdir"]!(resolvedCurrent, options.mode || 0o755);
            } catch (error) {
              if (!isAlreadyExists(error)) {
                if (!await ensureDirectoryExists(resolvedCurrent)) {
                  throw error;
                }
              }
            }
          }
        } else {
          const resolvedPath = await resolveSymlinkedPath(fullPath);
          await fs["party.openv.filesystem.write.mkdir"]!(resolvedPath, options?.mode || 0o755);
        }
      },

      async symlink(target: string, path: string): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const symlink = fs["party.openv.filesystem.write.symlink"];
        if (!symlink) {
          enosys("symlink");
          return;
        }
        await symlink(target, fullPath, 0o777);
      },

      async chmod(path: string, mode: number): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const chmod = fs["party.openv.filesystem.write.chmod"];
        if (!chmod) {
          enosys("chmod");
          return;
        }
        await chmod(fullPath, mode);
      },

      async chown(path: string, uid: number, gid: number): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const chown = fs["party.openv.filesystem.write.chown"];
        if (!chown) {
          enosys("chown");
          return;
        }
        await chown(fullPath, uid, gid);
      },

      async stat(path: string): Promise<{ size: number; mode: number; mtime: Date }> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const stat = await fs["party.openv.filesystem.read.stat"]!(fullPath);
        return {
          size: stat.size,
          mode: stat.mode,
          mtime: new Date(stat.mtime * 1000),
        };
      },

      async exists(path: string): Promise<boolean> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        try {
          await fs["party.openv.filesystem.read.stat"]!(fullPath);
          return true;
        } catch {
          return false;
        }
      },

      async readFile(path: string): Promise<Uint8Array> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        const stat = await fs["party.openv.filesystem.read.stat"]!(fullPath);
        const fd = await fs["party.openv.filesystem.open"](fullPath, "r", 0o444);
        try {
          return await fs["party.openv.filesystem.read.read"]!(fd, stat.size);
        } finally {
          await fs["party.openv.filesystem.close"](fd);
        }
      },

      async unlink(path: string): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        await fs["party.openv.filesystem.write.unlink"]!(fullPath);
      },

      async rmdir(path: string): Promise<void> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        await fs["party.openv.filesystem.write.rmdir"]!(fullPath);
      },

      async readdir(path: string): Promise<string[]> {
        const fullPath = await resolveSymlinkedPath(joinWithRoot(path));
        return await fs["party.openv.filesystem.read.readdir"]!(fullPath);
      },
    };
  }
}
