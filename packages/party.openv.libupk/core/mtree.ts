import type { PackageFile } from "../types/package.js";
import { gunzipSync } from "fflate";
import { normalizePath } from "../utils/path.js";

export interface MtreeEntry {
  path: string;
  type: "file" | "dir" | "link";
  uid?: number;
  gid?: number;
  mode?: number;
  time?: number;
  size?: number;
  md5?: string;
  sha256?: string;
  link?: string;
}

export class MtreeParser {
  async parse(data: Uint8Array): Promise<MtreeEntry[]> {
    let content: string;
    
    try {
      const decompressed = gunzipSync(data);
      content = new TextDecoder().decode(decompressed);
    } catch {
      content = new TextDecoder().decode(data);
    }
    
    return this.parseContent(content);
  }

  private parseContent(content: string): MtreeEntry[] {
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    const entries: MtreeEntry[] = [];
    const defaults: Partial<MtreeEntry> = {};

    for (const line of lines) {
      if (line.startsWith("/set ")) {
        this.parseDefaults(line.substring(5), defaults);
        continue;
      }

      if (line.startsWith("./")) {
        const entry = this.parseEntry(line, defaults);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    return entries;
  }

  private parseDefaults(line: string, defaults: Partial<MtreeEntry>): void {
    const parts = line.split(/\s+/);
    
    for (const part of parts) {
      const [key, value] = part.split("=");
      this.applyField(defaults, key, value);
    }
  }

  private parseEntry(line: string, defaults: Partial<MtreeEntry>): MtreeEntry | null {
    const parts = line.split(/\s+/);
    if (parts.length === 0) return null;

    const path = normalizePath(parts[0].substring(2)); // Remove "./"
    const entry: MtreeEntry = { 
      path,
      type: "file",
      ...defaults
    };

    for (let i = 1; i < parts.length; i++) {
      const [key, value] = parts[i].split("=");
      this.applyField(entry, key, value);
    }

    return entry;
  }

  private applyField(entry: Partial<MtreeEntry>, key: string, value: string): void {
    switch (key) {
      case "type":
        if (value === "dir" || value === "file" || value === "link") {
          entry.type = value;
        }
        break;
      case "uid":
        entry.uid = parseInt(value, 10);
        break;
      case "gid":
        entry.gid = parseInt(value, 10);
        break;
      case "mode":
        entry.mode = parseInt(value, 8);
        break;
      case "time":
        entry.time = parseFloat(value);
        break;
      case "size":
        entry.size = parseInt(value, 10);
        break;
      case "md5digest":
      case "md5":
        entry.md5 = value;
        break;
      case "sha256digest":
      case "sha256":
        entry.sha256 = value;
        break;
      case "link":
        entry.link = value;
        break;
    }
  }

  toPackageFiles(entries: MtreeEntry[]): PackageFile[] {
    return entries.map(e => ({
      path: e.path,
      type: e.type,
      size: e.size,
      mode: e.mode,
      uid: e.uid,
      gid: e.gid,
      sha256: e.sha256,
      linkTarget: e.link,
      time: e.time,
    }));
  }
}
