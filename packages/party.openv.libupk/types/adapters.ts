import type { PackageFile } from "./package.js";
import type { Manifest } from "./manifest.js";

export interface ContainerAdapter {
  readonly name: string;
  
  supports(source: string | Uint8Array): Promise<boolean>;
  
  open(source: string | Uint8Array): Promise<ContainerHandle>;
  
  generateHash(source: string | Uint8Array): Promise<string>;
}

export interface ContainerHandle {
  getManifest(): Promise<Manifest | null>;
  
  getMtree(): Promise<Uint8Array | null>;
  
  listFiles(): Promise<string[]>;
  
  extractFile(path: string): Promise<Uint8Array>;
  
  getFileInfo(path: string): Promise<PackageFile | null>;
  
  extractAll(targetPath: string, fs: FileSystemAdapter): Promise<void>;
  
  close(): Promise<void>;
}

export interface CompressionAdapter {
  readonly name: string;
  
  supports(data: Uint8Array): boolean;
  
  decompress(data: Uint8Array): Promise<Uint8Array>;
  
  compress(data: Uint8Array): Promise<Uint8Array>;
}

export interface LoggingAdapter {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface FileSystemAdapter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ size: number; mode: number; mtime: Date }>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}
