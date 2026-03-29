import type { PackageDatabase, DatabaseQuery } from "../types/database.js";
import type { PackageInfo } from "../types/package.js";
import type { FileSystemAdapter } from "../types/adapters.js";
import { normalizePath } from "../utils/path.js";

const DB_VERSION = "1.0.0";

export class Database implements DatabaseQuery {
  private data: PackageDatabase;
  private dbPath: string | null;
  private fs: FileSystemAdapter | null;
  private inMemory: boolean;

  constructor(dbPath: string | null, fs: FileSystemAdapter | null, inMemory: boolean = false) {
    this.dbPath = dbPath;
    this.fs = fs;
    this.inMemory = inMemory;
    this.data = {
      packages: {},
      fileOwnership: {},
      repositories: [],
      version: DB_VERSION,
    };
  }

  async load(): Promise<void> {
    if (this.inMemory) {
      return;
    }

    if (!this.dbPath || !this.fs) {
      throw new Error("Database path and filesystem required for non-memory mode");
    }

    try {
      const exists = await this.fs.exists(this.dbPath);
      if (!exists) {
        await this.save();
        return;
      }

      const data = await this.fs.readFile(this.dbPath);
      const text = new TextDecoder().decode(data);
      this.data = JSON.parse(text);

      if (this.data.version !== DB_VERSION) {
        console.warn(`Database version mismatch: ${this.data.version} != ${DB_VERSION}`);
      }
    } catch (error) {
      throw new Error(`Failed to load package database: ${error}`);
    }
  }

  async save(): Promise<void> {
    if (this.inMemory) {
      return;
    }

    if (!this.dbPath || !this.fs) {
      throw new Error("Database path and filesystem required for non-memory mode");
    }

    try {
      const text = JSON.stringify(this.data, null, 2);
      const data = new TextEncoder().encode(text);
      await this.fs.writeFile(this.dbPath, data);
    } catch (error) {
      throw new Error(`Failed to save package database: ${error}`);
    }
  }

  isInstalled(packageName: string): boolean {
    return packageName in this.data.packages;
  }

  getPackage(packageName: string): PackageInfo | null {
    return this.data.packages[packageName] || null;
  }

  listPackages(anonymous?: boolean): PackageInfo[] {
    const packages = Object.values(this.data.packages);
    if (anonymous === undefined) return packages;
    return packages.filter(p => p.isAnonymous === anonymous);
  }

  getFileOwner(filePath: string): string | null {
    const normalized = normalizePath(filePath);
    return this.data.fileOwnership[normalized] || null;
  }

  hasConflict(filePath: string, packageName: string): boolean {
    const owner = this.getFileOwner(filePath);
    return owner !== null && owner !== packageName;
  }

  async addPackage(pkg: PackageInfo): Promise<void> {
    this.data.packages[pkg.name] = pkg;

    for (const file of pkg.files) {
      const normalized = normalizePath(file.path);
      this.data.fileOwnership[normalized] = pkg.name;
    }

    await this.save();
  }

  async removePackage(packageName: string): Promise<PackageInfo | null> {
    const pkg = this.data.packages[packageName];
    if (!pkg) return null;

    delete this.data.packages[packageName];

    for (const file of pkg.files) {
      const normalized = normalizePath(file.path);
      if (this.data.fileOwnership[normalized] === packageName) {
        delete this.data.fileOwnership[normalized];
      }
    }

    await this.save();
    return pkg;
  }

  async updatePackage(pkg: PackageInfo): Promise<void> {
    const old = this.data.packages[pkg.name];
    if (old) {
      for (const file of old.files) {
        const normalized = normalizePath(file.path);
        if (this.data.fileOwnership[normalized] === pkg.name) {
          delete this.data.fileOwnership[normalized];
        }
      }
    }

    await this.addPackage(pkg);
  }

  getRepositories(): typeof this.data.repositories {
    return this.data.repositories;
  }

  async addRepository(name: string, uri: string, priority: number = 0): Promise<void> {
    const existing = this.data.repositories.find(r => r.name === name);
    if (existing) {
      throw new Error(`Repository '${name}' already exists`);
    }

    this.data.repositories.push({ name, uri, priority, enabled: true });
    this.data.repositories.sort((a, b) => b.priority - a.priority);
    await this.save();
  }

  async removeRepository(name: string): Promise<void> {
    const index = this.data.repositories.findIndex(r => r.name === name);
    if (index === -1) {
      throw new Error(`Repository '${name}' not found`);
    }

    this.data.repositories.splice(index, 1);
    await this.save();
  }
}
