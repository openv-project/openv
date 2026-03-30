import type { LoggingAdapter } from "./adapters.js";

export interface InstallOptions {
  overwrite?: boolean;
  force?: boolean;
  logger?: LoggingAdapter;
  skipDependencies?: boolean;
  asDeps?: boolean;
  batchSequential?: boolean;
  rootPath?: string;
  dbPath?: string;
  inMemoryDb?: boolean;
}

export interface UninstallOptions {
  cascade?: boolean;
  force?: boolean;
  logger?: LoggingAdapter;
  keepBackups?: boolean;
  rootPath?: string;
  dbPath?: string;
}

export interface VerifyOptions {
  logger?: LoggingAdapter;
  deep?: boolean;
  rootPath?: string;
}

export interface ListOptions {
  includeAnonymous?: boolean;
  filterByGroup?: string;
}
