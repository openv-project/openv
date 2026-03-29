import type { ContainerAdapter, FileSystemAdapter, LoggingAdapter } from "../types/adapters.js";
import type { InstallOptions, UninstallOptions, VerifyOptions } from "../types/options.js";
import type { InstallResult, UninstallResult, VerifyResult, QueryResult, PackageInfo } from "../types/package.js";
import type { Manifest } from "../types/manifest.js";
import { Database } from "./database.js";
import { Installer } from "./installer.js";
import { Uninstaller } from "./uninstaller.js";
import { Verifier } from "./verifier.js";
import { isAnonymousPackage } from "../types/manifest.js";
import { NoOpLogger } from "../adapters/logging/base.js";

export class PackageManager {
  private containerAdapters: ContainerAdapter[] = [];
  private db: Database;
  private installer: Installer;
  private uninstaller: Uninstaller;
  private verifier: Verifier;

  constructor(
    dbPath: string | null,
    private fs: FileSystemAdapter,
    private rootPath: string = "",
    inMemoryDb: boolean = false
  ) {
    this.db = new Database(dbPath, inMemoryDb ? null : fs, inMemoryDb);
    this.installer = new Installer(this.db, fs, rootPath);
    this.uninstaller = new Uninstaller(this.db, fs, rootPath);
    this.verifier = new Verifier(this.db, fs, rootPath);
  }

  registerContainerAdapter(adapter: ContainerAdapter): void {
    this.containerAdapters.push(adapter);
  }

  async initialize(): Promise<void> {
    await this.db.load();
  }

  async install(source: string | Uint8Array, options: InstallOptions = {}): Promise<InstallResult> {
    const logger = options.logger || new NoOpLogger();

    try {
      const adapter = await this.selectAdapter(source);
      if (!adapter) {
        throw new Error("No suitable container adapter found for package source");
      }

      logger.debug(`Using container adapter: ${adapter.name}`);

      const handle = await adapter.open(source);
      try {
        const manifest = await handle.getManifest();
        
        let packageName: string;
        let isAnonymous = false;

        if (isAnonymousPackage(manifest)) {
          logger.info("Package is anonymous, generating hash-based name");
          const hash = await adapter.generateHash(source);
          packageName = `anon-${hash.substring(0, 16)}`;
          isAnonymous = true;
        } else {
          packageName = manifest!.name!;
        }

        const effectiveManifest: Manifest = manifest || {
          name: packageName,
          version: "unknown",
        };

        const isUpgrade = this.db.isInstalled(packageName);

        const packageInfo = await this.installer.install(
          handle,
          effectiveManifest,
          packageName,
          options
        );

        return {
          packageName,
          isAnonymous,
          filesInstalled: packageInfo.files.length,
          status: isUpgrade ? "upgraded" : "installed",
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      logger.error(`Installation failed: ${error}`);
      return {
        packageName: "unknown",
        isAnonymous: false,
        filesInstalled: 0,
        status: "failed",
        message: String(error),
      };
    }
  }

  async uninstall(packageName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    return await this.uninstaller.uninstall(packageName, options);
  }

  async verify(packageName: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    return await this.verifier.verify(packageName, options);
  }

  async query(packageName: string): Promise<QueryResult> {
    const pkg = this.db.getPackage(packageName);
    return {
      found: pkg !== null,
      package: pkg || undefined,
    };
  }

  async list(options: { includeAnonymous?: boolean } = {}): Promise<PackageInfo[]> {
    return this.db.listPackages(
      options.includeAnonymous === false ? false : undefined
    );
  }

  private async selectAdapter(source: string | Uint8Array): Promise<ContainerAdapter | null> {
    for (const adapter of this.containerAdapters) {
      if (await adapter.supports(source)) {
        return adapter;
      }
    }
    return null;
  }

  getDatabase(): Database {
    return this.db;
  }
}
