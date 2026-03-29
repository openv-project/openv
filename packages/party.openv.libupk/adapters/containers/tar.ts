import type { ContainerAdapter, ContainerHandle, FileSystemAdapter, CompressionAdapter } from "../../types/adapters.js";
import type { Manifest } from "../../types/manifest.js";
import type { PackageFile } from "../../types/package.js";
import { parseManifest } from "../../core/manifest.js";
import { sha256 } from "../../utils/hash.js";
import { normalizePath, joinPath } from "../../utils/path.js";
import { parseTar } from "nanotar";

export class TarAdapter implements ContainerAdapter {
  readonly name = "tar";
  private compressionAdapters: CompressionAdapter[] = [];

  registerCompression(adapter: CompressionAdapter): void {
    this.compressionAdapters.push(adapter);
  }

  async supports(source: string | Uint8Array): Promise<boolean> {
    if (!(source instanceof Uint8Array)) return false;

    try {
      const data = await this.prepareData(source);
      return this.isTar(data);
    } catch {
      return false;
    }
  }

  private isTar(data: Uint8Array): boolean {
    if (data.length < 512) return false;
    const ustarMagic = new TextDecoder().decode(data.slice(257, 263));
    return ustarMagic.startsWith("ustar");
  }

  private async prepareData(data: Uint8Array): Promise<Uint8Array> {
    for (const adapter of this.compressionAdapters) {
      if (adapter.supports(data)) {
        return await adapter.decompress(data);
      }
    }
    return data;
  }

  async open(source: string | Uint8Array): Promise<ContainerHandle> {
    if (!(source instanceof Uint8Array)) {
      throw new Error("TarAdapter requires Uint8Array source");
    }

    const data = await this.prepareData(source);
    return new TarHandle(data);
  }

  async generateHash(source: string | Uint8Array): Promise<string> {
    if (!(source instanceof Uint8Array)) {
      throw new Error("TarAdapter requires Uint8Array source");
    }
    return sha256(source);
  }
}

class TarHandle implements ContainerHandle {
  private entries: Map<string, Uint8Array> = new Map();
  private fileInfo: Map<string, any> = new Map();

  constructor(tarData: Uint8Array) {
    this.parseTar(tarData);
  }

  private parseTar(data: Uint8Array): void {
    const extracted = parseTar(data);
    for (const entry of extracted) {
      const normalized = normalizePath(entry.name);
      if (!normalized || normalized.endsWith("/")) continue;
      if (!(entry.data instanceof Uint8Array)) continue;
      this.entries.set(normalized, entry.data);
    }
  }

  async getManifest(): Promise<Manifest | null> {
    const manifestData = this.entries.get(".manifest");
    if (!manifestData) return null;

    const text = new TextDecoder().decode(manifestData);
    return await parseManifest(text);
  }

  async getMtree(): Promise<Uint8Array | null> {
    return this.entries.get(".MTREE") || null;
  }

  async listFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const path of this.entries.keys()) {
      if (!path.startsWith(".MTREE") && !path.startsWith(".manifest")) {
        files.push(path);
      }
    }
    return files.sort();
  }

  async extractFile(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const data = this.entries.get(normalized);
    if (!data) {
      throw new Error(`File not found in tar: ${path}`);
    }
    return data;
  }

  async getFileInfo(path: string): Promise<PackageFile | null> {
    const normalized = normalizePath(path);
    if (!this.entries.has(normalized)) return null;

    const data = this.entries.get(normalized)!;

    return {
      path: normalized,
      type: "file",
      size: data.length,
      mode: 0o644,
    };
  }

  async extractAll(targetPath: string, fs: FileSystemAdapter): Promise<void> {
    const files = await this.listFiles();

    for (const file of files) {
      const targetFile = joinPath(targetPath, file);
      const data = await this.extractFile(file);

      await fs.mkdir(joinPath(targetPath, file.split("/").slice(0, -1).join("/")), { recursive: true });
      await fs.writeFile(targetFile, data);
    }
  }

  async close(): Promise<void> {
    this.entries.clear();
    this.fileInfo.clear();
  }
}
