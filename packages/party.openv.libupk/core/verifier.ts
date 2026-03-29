import type { FileSystemAdapter, LoggingAdapter } from "../types/adapters.js";
import type { VerifyResult, VerifyIssue } from "../types/package.js";
import type { VerifyOptions } from "../types/options.js";
import { Database } from "./database.js";
import { NoOpLogger } from "../adapters/logging/base.js";
import { sha256 } from "../utils/hash.js";
import { joinPath } from "../utils/path.js";

export class Verifier {
  constructor(
    private db: Database,
    private fs: FileSystemAdapter,
    private rootPath: string = ""
  ) {}

  async verify(packageName: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    const logger = options.logger || new NoOpLogger();
    const issues: VerifyIssue[] = [];

    const pkg = this.db.getPackage(packageName);
    if (!pkg) {
      return {
        packageName,
        valid: false,
        issues: [{
          path: "",
          type: "missing",
          expected: "package metadata",
        }],
      };
    }

    logger.info(`Verifying package: ${packageName}`);

    for (const file of pkg.files) {
      if (file.type === "dir") continue;

      const fullPath = joinPath(this.rootPath, file.path);

      try {
        const exists = await this.fs.exists(fullPath);
        if (!exists) {
          issues.push({
            path: file.path,
            type: "missing",
          });
          continue;
        }

        const stat = await this.fs.stat(fullPath);

        if (file.size !== undefined && stat.size !== file.size) {
          issues.push({
            path: file.path,
            type: "size-mismatch",
            expected: file.size,
            actual: stat.size,
          });
        }

        if (options.deep && file.type === "file" && file.sha256) {
          const data = await this.fs.readFile(fullPath);
          const hash = await sha256(data);

          if (hash !== file.sha256) {
            issues.push({
              path: file.path,
              type: "hash-mismatch",
              expected: file.sha256,
              actual: hash,
            });
          }
        }

        if (file.mode !== undefined && stat.mode !== file.mode) {
          issues.push({
            path: file.path,
            type: "permissions",
            expected: file.mode.toString(8),
            actual: stat.mode.toString(8),
          });
        }
      } catch (error) {
        logger.warn(`Error verifying ${file.path}: ${error}`);
        issues.push({
          path: file.path,
          type: "modified",
          expected: "accessible",
          actual: String(error),
        });
      }
    }

    const valid = issues.length === 0;
    logger.info(`Verification ${valid ? "passed" : `failed with ${issues.length} issues`}`);

    return {
      packageName,
      valid,
      issues,
    };
  }
}
