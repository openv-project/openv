import type { ContainerAdapter, ContainerHandle, FileSystemAdapter } from "../../types/adapters.js";
import type { Manifest } from "../../types/manifest.js";
import type { PackageFile } from "../../types/package.js";

export class DirectoryAdapter implements ContainerAdapter {
  readonly name = "directory";

  async supports(_source: string | Uint8Array): Promise<boolean> {
    return false;
  }

  async open(_source: string | Uint8Array): Promise<ContainerHandle> {
    throw new Error("DirectoryAdapter is not supported in Openv runtime. Pass package bytes or a filesystem path to UpkApi.install().");
  }

  async generateHash(_source: string | Uint8Array): Promise<string> {
    throw new Error("DirectoryAdapter is not supported in Openv runtime");
  }
}

export class DirectoryHandle implements ContainerHandle {
  async getManifest(): Promise<Manifest | null> { return null; }
  async getMtree(): Promise<Uint8Array | null> { return null; }
  async listFiles(): Promise<string[]> { return []; }
  async extractFile(_path: string): Promise<Uint8Array> { throw new Error("Not supported"); }
  async getFileInfo(_path: string): Promise<PackageFile | null> { return null; }
  async extractAll(_targetPath: string, _fs: FileSystemAdapter): Promise<void> { }
  async close(): Promise<void> { }
}
