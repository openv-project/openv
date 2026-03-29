import type { PackageInfo } from "./package.js";

export interface PackageDatabase {
  packages: Record<string, PackageInfo>;
  fileOwnership: Record<string, string>;
  repositories: Repository[];
  version: string;
}

export interface Repository {
  name: string;
  uri: string;
  priority: number;
  enabled: boolean;
}

export interface DatabaseQuery {
  isInstalled(packageName: string): boolean;
  getPackage(packageName: string): PackageInfo | null;
  listPackages(anonymous?: boolean): PackageInfo[];
  getFileOwner(filePath: string): string | null;
  hasConflict(filePath: string, packageName: string): boolean;
}
