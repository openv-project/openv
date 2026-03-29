import type { Manifest } from "./manifest.js";

export interface PackageInfo {
  name: string;
  version: string;
  manifest: Manifest;
  files: PackageFile[];
  installedAt: number;
  isAnonymous: boolean;
  mtreeHash?: string;
}

export interface PackageFile {
  path: string;
  type: "file" | "dir" | "link";
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  sha256?: string;
  linkTarget?: string;
  time?: number;
}

export interface InstallResult {
  packageName: string;
  isAnonymous: boolean;
  filesInstalled: number;
  status: "installed" | "upgraded" | "failed";
  message?: string;
}

export interface UninstallResult {
  packageName: string;
  filesRemoved: number;
  status: "removed" | "failed";
  message?: string;
}

export interface VerifyResult {
  packageName: string;
  valid: boolean;
  issues: VerifyIssue[];
}

export interface VerifyIssue {
  path: string;
  type: "missing" | "modified" | "size-mismatch" | "hash-mismatch" | "permissions";
  expected?: string | number;
  actual?: string | number;
}

export interface QueryResult {
  found: boolean;
  package?: PackageInfo;
}
