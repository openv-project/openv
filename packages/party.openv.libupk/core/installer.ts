import type { FileSystemAdapter, LoggingAdapter, ContainerHandle } from "../types/adapters.js";
import type { PackageInfo, PackageFile } from "../types/package.js";
import type { InstallOptions } from "../types/options.js";
import type { Manifest } from "../types/manifest.js";
import { Database } from "./database.js";
import { MtreeParser } from "./mtree.js";
import { NoOpLogger } from "../adapters/logging/base.js";
import { sha256 } from "../utils/hash.js";
import { normalizePath, joinPath, dirname } from "../utils/path.js";

export class Installer {
  private static readonly EXTRACT_CONCURRENCY = 8;

  constructor(
    private db: Database,
    private fs: FileSystemAdapter,
    private rootPath: string = ""
  ) {}

  async install(
    handle: ContainerHandle,
    manifest: Manifest,
    packageName: string,
    options: InstallOptions = {}
  ): Promise<PackageInfo> {
    const logger = options.logger || new NoOpLogger();
    const isUpgrade = this.db.isInstalled(packageName);

    logger.info(`${isUpgrade ? "Upgrading" : "Installing"} package: ${packageName}`);

    const mtreeData = await handle.getMtree();
    let files: PackageFile[] = [];

    if (mtreeData) {
      logger.debug("Parsing MTREE for file metadata");
      const parser = new MtreeParser();
      const entries = await parser.parse(mtreeData);
      files = parser.toPackageFiles(entries);
    } else {
      logger.debug("No MTREE found, using container metadata");
      const fileList = await handle.listFiles();
      for (const path of fileList) {
        const info = await handle.getFileInfo(path);
        if (info) {
          files.push(info);
        }
      }
    }

    const oldPackage = isUpgrade ? this.db.getPackage(packageName) : null;
    const backupPaths = new Set(manifest.backup || []);

    await this.checkConflicts(files, packageName, options, logger);

    if (isUpgrade && oldPackage) {
      await this.handleBackups(oldPackage, backupPaths, logger);
    }

    logger.info(`Extracting ${files.length} files...`);
    await this.extractFiles(handle, files, logger);

    if (mtreeData) {
      logger.debug("Verifying file integrity with MTREE");
      await this.verifyExtractedFiles(files, logger);
    }

    const packageInfo: PackageInfo = {
      name: packageName,
      version: manifest.version || "unknown",
      manifest,
      files,
      installedAt: Date.now() / 1000,
      isAnonymous: !manifest.name,
      mtreeHash: mtreeData ? await sha256(mtreeData) : undefined,
    };

    if (isUpgrade) {
      await this.db.updatePackage(packageInfo);
    } else {
      await this.db.addPackage(packageInfo);
    }

    logger.info(`Successfully ${isUpgrade ? "upgraded" : "installed"} ${packageName}`);
    return packageInfo;
  }

  private async checkConflicts(
    files: PackageFile[],
    packageName: string,
    options: InstallOptions,
    logger: LoggingAdapter
  ): Promise<void> {
    const conflicts: string[] = [];

    for (const file of files) {
      if (file.type === "dir") continue;

      const fullPath = joinPath(this.rootPath, file.path);
      
      if (await this.fs.exists(fullPath)) {
        const owner = this.db.getFileOwner(file.path);
        
        if (owner && owner !== packageName && !options.overwrite) {
          conflicts.push(`${file.path} (owned by ${owner})`);
        }
      }
    }

    if (conflicts.length > 0) {
      throw new Error(
        `File conflicts detected:\n${conflicts.join("\n")}\n\nUse overwrite: true to force installation.`
      );
    }
  }

  private async handleBackups(
    oldPackage: PackageInfo,
    backupPaths: Set<string>,
    logger: LoggingAdapter
  ): Promise<void> {
    for (const file of oldPackage.files) {
      if (backupPaths.has(file.path)) {
        const fullPath = joinPath(this.rootPath, file.path);
        const backupPath = `${fullPath}.backup-${Date.now()}`;
        
        try {
          const data = await this.fs.readFile(fullPath);
          await this.fs.writeFile(backupPath, data);
          logger.info(`Backed up: ${file.path}`);
        } catch (error) {
          logger.warn(`Failed to backup ${file.path}: ${error}`);
        }
      }
    }
  }

  private async extractFiles(
    handle: ContainerHandle,
    files: PackageFile[],
    logger: LoggingAdapter
  ): Promise<void> {
    const directories = files.filter(f => f.type === "dir").sort((a, b) => a.path.localeCompare(b.path));
    const regularFiles = files.filter(f => f.type === "file");
    const links = files.filter(f => f.type === "link");
    const explicitDirByPath = new Map<string, PackageFile>();
    for (const dir of directories) {
      explicitDirByPath.set(normalizePath(dir.path), dir);
    }

    const allDirs = new Set<string>();
    for (const dir of directories) {
      const normalized = normalizePath(dir.path);
      if (normalized) allDirs.add(normalized);
    }
    for (const file of regularFiles) {
      const parent = normalizePath(dirname(file.path));
      if (parent) allDirs.add(parent);
    }
    for (const link of links) {
      const parent = normalizePath(dirname(link.path));
      if (parent) allDirs.add(parent);
    }

    const byDepth = new Map<number, string[]>();
    for (const dirPath of allDirs) {
      const depth = dirPath.split("/").filter(Boolean).length;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(dirPath);
    }
    const orderedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);
    for (const depth of orderedDepths) {
      const group = byDepth.get(depth)!.sort((a, b) => a.localeCompare(b));
      await Promise.all(group.map(async (dirPath) => {
        const fullPath = joinPath(this.rootPath, dirPath);
        const explicit = explicitDirByPath.get(dirPath);
        await this.fs.mkdir(fullPath, { recursive: true, mode: explicit?.mode });
        if (explicit?.mode !== undefined) {
          await this.applyChmod(fullPath, explicit.mode, logger);
        }
        if (explicit && (explicit.uid !== undefined || explicit.gid !== undefined)) {
          await this.applyChown(fullPath, explicit.uid ?? 0, explicit.gid ?? 0, logger);
        }
      }));
    }

    await this.runWithConcurrencyLimit(regularFiles, Installer.EXTRACT_CONCURRENCY, async (file) => {
      const fullPath = joinPath(this.rootPath, file.path);
      const data = await handle.extractFile(file.path);
      await this.fs.writeFile(fullPath, data);

      if (file.mode !== undefined) {
        await this.applyChmod(fullPath, file.mode, logger);
      }
      if (file.uid !== undefined || file.gid !== undefined) {
        await this.applyChown(fullPath, file.uid ?? 0, file.gid ?? 0, logger);
      }
    });

    const symlinks = links.filter((link): link is PackageFile & { linkTarget: string } => !!link.linkTarget);
    await this.runWithConcurrencyLimit(symlinks, Installer.EXTRACT_CONCURRENCY, async (link) => {
      const fullPath = joinPath(this.rootPath, link.path);
      await this.fs.symlink(link.linkTarget, fullPath);
      if (link.mode !== undefined) {
        await this.applyChmod(fullPath, link.mode, logger);
      }
      if (link.uid !== undefined || link.gid !== undefined) {
        await this.applyChown(fullPath, link.uid ?? 0, link.gid ?? 0, logger);
      }
    });
  }

  private async runWithConcurrencyLimit<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) return;
    const concurrency = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;
    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) return;
        await worker(items[idx]!);
      }
    });
    await Promise.all(runners);
  }

  private isUnsupportedMetadataOperation(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    if (code === "ENOSYS") return true;
    const message = error.message.toLowerCase();
    return message.startsWith("enosys:");
  }

  private async applyChmod(path: string, mode: number, logger: LoggingAdapter): Promise<void> {
    try {
      await this.fs.chmod(path, mode);
    } catch (error) {
      if (this.isUnsupportedMetadataOperation(error)) {
        logger.debug(`Skipping chmod for ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  private async applyChown(path: string, uid: number, gid: number, logger: LoggingAdapter): Promise<void> {
    try {
      await this.fs.chown(path, uid, gid);
    } catch (error) {
      if (this.isUnsupportedMetadataOperation(error)) {
        logger.debug(`Skipping chown for ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  private async verifyExtractedFiles(files: PackageFile[], logger: LoggingAdapter): Promise<void> {
    for (const file of files) {
      if (file.type !== "file" || !file.sha256) continue;

      const fullPath = joinPath(this.rootPath, file.path);
      try {
        const data = await this.fs.readFile(fullPath);
        const hash = await sha256(data);

        if (hash !== file.sha256) {
          throw new Error(`Hash mismatch for ${file.path}: expected ${file.sha256}, got ${hash}`);
        }
      } catch (error) {
        logger.warn(`Failed to verify ${file.path}: ${error}`);
      }
    }
  }
}
