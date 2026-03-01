import type { FileSystemEvent, FileMode, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, FsStats, FileSystemCoreComponent, OpenFlags } from "../../../../syscall/index.ts";
import type { OpEnv } from "../../../../openv.ts";
import type { API } from "../../../api.ts";

export default class FsApi implements API<"party.openv.api.filesystem"> {

  name = "party.openv.api.filesystem" as const;

  openv!: OpEnv<FileSystemCoreComponent & Partial<FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemVirtualComponent>>;

  async initialize(openv: OpEnv<FileSystemCoreComponent & Partial<FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemVirtualComponent>>) {
    this.openv = openv;
    if (!await this.openv.system.supports("party.openv.filesystem")) {
      throw new Error("Filesystem is not supported in this environment.");
    }
  
  }

  async mount(id: string, path: string): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.virtual")) {
      throw new Error("Virtual filesystems are not supported in this environment.");
    }
    await this.openv.system["party.openv.filesystem.virtual.mount"]!(id, path);
  }

  async umount(path: string): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.virtual")) {
      throw new Error("Virtual filesystems are not supported in this environment.");
    }
    await this.openv.system["party.openv.filesystem.virtual.unmount"]!(path);
  }

  async open(path: string, flags: OpenFlags, mode: FileMode): Promise<number> {
    if (["w", "a", "x", "+"].some(flag => flags.includes(flag))) {
      if (!await this.openv.system.supports("party.openv.filesystem.write")) {
        throw new Error("Write operations are not supported in this environment.");
      }
    }
    return await this.openv.system["party.openv.filesystem.open"](path, flags, mode);
  }

  async create(path: string, mode: FileMode = 0o666): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    await this.openv.system["party.openv.filesystem.write.create"]!(path, mode);
  }

  async read(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number> {
    return await this.openv.system["party.openv.filesystem.read.read"]!(fd, buffer, offset, length, position);
  }

  async write(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    return await this.openv.system["party.openv.filesystem.write.write"]!(fd, buffer, offset, length, position);
  }

  async close(fd: number): Promise<void> {
    await this.openv.system["party.openv.filesystem.close"](fd);
  }

  async watch(path: string, options?: { recursive?: boolean; }): Promise<{ events: AsyncIterable<FileSystemEvent>; abort: () => Promise<void>; }> {
    return await this.openv.system["party.openv.filesystem.read.watch"]!(path, options);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const fd = await this.open(path, "r", 0o666);
    try {
      const stats = await this.stat(path);
      const buffer = new Uint8Array(stats.size);
      await this.read(fd, buffer, 0, stats.size, 0);
      return buffer;
    } finally {
      await this.close(fd);
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const fd = await this.open(path, "w", 0o666);
    try {
      await this.write(fd, data, 0, data.length, 0);
    } finally {
      await this.close(fd);
    }
  }
  async unlink(path: string): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    await this.openv.system["party.openv.filesystem.write.unlink"]!(path);
  }

  // TODO: symlink management (waiting on syscall)
  // async symlink(target: string, path: string): Promise<void> {
    
  // }
  // async readlink(path: string): Promise<string> {
    
  // }

  async readdir(path: string): Promise<string[]> {
    return await this.openv.system["party.openv.filesystem.read.readdir"]!(path);
  }
  async mkdir(path: string, recursive: boolean = false): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    if (recursive) {
      throw new Error("TODO: recursive");
    }
    await this.openv.system["party.openv.filesystem.write.mkdir"]!(path, 0o777);
  }
  async rmdir(path: string, recursive: boolean = false): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    if (recursive) {
      throw new Error("TODO: recursive");
    }
    await this.openv.system["party.openv.filesystem.write.rmdir"]!(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw new Error("Write operations are not supported in this environment.");
    }
    try {
      // Rename will throw across the vfs boundary, so we have a copy-and-delete fallback
      await this.openv.system["party.openv.filesystem.write.rename"]!(oldPath, newPath);
    } catch {
      const data = await this.readFile(oldPath);
      await this.writeFile(newPath, data);
      await this.unlink(oldPath);
    }
  }

  async stat(path: string): Promise<FsStats> {
    return await this.openv.system["party.openv.filesystem.read.stat"]!(path);
  }

  // TODO: permissions management (waiting on syscall)
  // async chown(path: string, uid: number, gid = uid): Promise<void> {
  // }
  // async chmod(path: string, mode: number): Promise<void> {
    
  // }

  // TODO: path resolution (waiting on process syscalls)
  // async resolve(path: string): Promise<string>
}
