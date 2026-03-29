import type { FileSystemAdapter, LoggingAdapter } from "../types/adapters.js";
import type { UninstallOptions } from "../types/options.js";
import type { UninstallResult } from "../types/package.js";
import { Database } from "./database.js";
import { NoOpLogger } from "../adapters/logging/base.js";
import { joinPath, dirname } from "../utils/path.js";

export class Uninstaller {
  constructor(
    private db: Database,
    private fs: FileSystemAdapter,
    private rootPath: string = ""
  ) {}

  async uninstall(packageName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    const logger = options.logger || new NoOpLogger();

    const pkg = this.db.getPackage(packageName);
    if (!pkg) {
      return {
        packageName,
        filesRemoved: 0,
        status: "failed",
        message: `Package not found: ${packageName}`,
      };
    }

    logger.info(`Uninstalling package: ${packageName}`);

    const backupPaths = new Set(pkg.manifest.backup || []);
    const filesToRemove = pkg.files.filter(f => f.type === "file" || f.type === "link");
    const dirsToRemove = pkg.files.filter(f => f.type === "dir");

    let filesRemoved = 0;

    for (const file of filesToRemove) {
      if (!options.keepBackups && backupPaths.has(file.path)) {
        logger.info(`Preserving backup file: ${file.path}`);
        continue;
      }

      const fullPath = joinPath(this.rootPath, file.path);
      
      try {
        const exists = await this.fs.exists(fullPath);
        if (exists) {
          await this.fs.unlink(fullPath);
          filesRemoved++;
          logger.debug(`Removed: ${file.path}`);
        }
      } catch (error) {
        if (options.force) {
          logger.warn(`Failed to remove ${file.path}: ${error}`);
        } else {
          throw new Error(`Failed to remove ${file.path}: ${error}`);
        }
      }
    }

    dirsToRemove.sort((a, b) => b.path.length - a.path.length);

    for (const dir of dirsToRemove) {
      const fullPath = joinPath(this.rootPath, dir.path);
      
      try {
        const exists = await this.fs.exists(fullPath);
        if (exists) {
          const entries = await this.fs.readdir(fullPath);
          if (entries.length === 0) {
            await this.fs.rmdir(fullPath);
            logger.debug(`Removed empty directory: ${dir.path}`);
          } else {
            logger.debug(`Skipping non-empty directory: ${dir.path}`);
          }
        }
      } catch (error) {
        logger.debug(`Could not remove directory ${dir.path}: ${error}`);
      }
    }

    await this.cleanupEmptyParentDirs(pkg.files.map(f => f.path), logger);

    await this.db.removePackage(packageName);

    logger.info(`Successfully uninstalled ${packageName} (${filesRemoved} files removed)`);

    return {
      packageName,
      filesRemoved,
      status: "removed",
    };
  }

  private async cleanupEmptyParentDirs(paths: string[], logger: LoggingAdapter): Promise<void> {
    const parentDirs = new Set<string>();

    for (const path of paths) {
      let current = dirname(path);
      while (current) {
        parentDirs.add(current);
        current = dirname(current);
      }
    }

    const sortedDirs = Array.from(parentDirs).sort((a, b) => b.length - a.length);

    for (const dir of sortedDirs) {
      const fullPath = joinPath(this.rootPath, dir);
      
      try {
        const exists = await this.fs.exists(fullPath);
        if (exists) {
          const entries = await this.fs.readdir(fullPath);
          if (entries.length === 0 && !this.db.getFileOwner(dir)) {
            await this.fs.rmdir(fullPath);
            logger.debug(`Cleaned up empty directory: ${dir}`);
          }
        }
      } catch {
        // Ignore errors during cleanup
      }
    }
  }
}
