import type {
  FileMode,
  FileSystemReadOnlyComponent,
  FileSystemReadWriteComponent,
  FileSystemVirtualComponent,
  FsStats,
  FileSystemCoreComponent,
  OpenFlags,
  API,
  OpEnv,
} from "@openv-project/openv-api";

export type BufferEncoding =
  | "ascii" | "utf8" | "utf-8" | "utf16le" | "ucs2" | "ucs-2"
  | "base64" | "base64url" | "latin1" | "binary" | "hex";

export interface RmOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: FileMode;
}

export interface RmdirOptions {
  recursive?: boolean;
}

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
  flag?: string;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding | null;
  mode?: FileMode;
  flag?: string;
}

export interface ReaddirOptions {
  withFileTypes?: boolean;
  recursive?: boolean;
}

export interface WatchOptions {
  recursive?: boolean;
  encoding?: BufferEncoding;
}

export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface Stats extends FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export interface FileHandle {
  readonly fd: number;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  writeFile(data: string | Uint8Array, options?: WriteFileOptions): Promise<void>;
  readFile(options?: ReadFileOptions & { encoding?: null }): Promise<Uint8Array>;
  readFile(options: ReadFileOptions & { encoding: BufferEncoding }): Promise<string>;
  readFile(options?: ReadFileOptions): Promise<Uint8Array | string>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_EXCL: 128,
} as const;

function wrapStats(raw: FsStats): Stats {
  return {
    ...raw,
    isFile: () => (raw.mode & 0o170000) === 0o100000,
    isDirectory: () => (raw.mode & 0o170000) === 0o040000,
    isSymbolicLink: () => (raw.mode & 0o170000) === 0o120000,
    isBlockDevice: () => (raw.mode & 0o170000) === 0o060000,
    isCharacterDevice: () => (raw.mode & 0o170000) === 0o020000,
    isFIFO: () => (raw.mode & 0o170000) === 0o010000,
    isSocket: () => (raw.mode & 0o170000) === 0o140000,
  };
}

function decode(data: Uint8Array, encoding?: BufferEncoding | null): string {
  return new TextDecoder(encoding ?? "utf-8").decode(data);
}

type CapableOpEnv = OpEnv<
  FileSystemCoreComponent &
  Partial<FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemVirtualComponent>
>;

export default class FsApi implements API<"party.openv.api.filesystem"> {
  name = "party.openv.api.filesystem" as const;
  readonly constants = constants;

  openv!: CapableOpEnv;

  async initialize(openv: CapableOpEnv): Promise<void> {
    this.openv = openv;
    if (!await this.openv.system.supports("party.openv.filesystem")) {
      throw new Error("Filesystem is not supported in this environment.");
    }
  }

  async open(path: string, flags: OpenFlags | number, mode: FileMode = 0o666): Promise<FileHandle> {
    const flagStr = typeof flags === "number" ? flagsFromNumber(flags) : flags;

    if (["w", "a", "x", "+"].some(f => flagStr.includes(f))) {
      await this.#requireWrite();
    }

    const fd = await this.openv.system["party.openv.filesystem.open"](path, flagStr, mode);
    return this.#makeFileHandle(fd, path);
  }

  #makeFileHandle(fd: number, path: string): FileHandle {
    const sys = this.openv.system;
    const self = this;

    function readFile(options?: ReadFileOptions & { encoding?: null }): Promise<Uint8Array>;
    function readFile(options: ReadFileOptions & { encoding: BufferEncoding }): Promise<string>;
    function readFile(options?: ReadFileOptions): Promise<Uint8Array | string>;
    async function readFile(options?: ReadFileOptions): Promise<Uint8Array | string> {
      const stats = await self.stat(path);
      const chunk = await sys["party.openv.filesystem.read.read"]!(fd, stats.size);
      const enc = options?.encoding;
      return enc ? decode(chunk, enc) : chunk;
    }

    return {
      fd,
      readFile,

      async read(buffer, offset = 0, length = buffer.byteLength, position) {
        const chunk = await sys["party.openv.filesystem.read.read"]!(fd, length, position ?? undefined);
        buffer.set(chunk, offset);
        return { bytesRead: chunk.byteLength, buffer };
      },

      async write(buffer, offset = 0, length = buffer.byteLength, position) {
        const slice = buffer.subarray(offset, offset + length);
        const bytesWritten = await sys["party.openv.filesystem.write.write"]!(fd, slice, 0, slice.byteLength, position);
        return { bytesWritten, buffer };
      },

      async writeFile(data, _options) {
        const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;
        await sys["party.openv.filesystem.write.write"]!(fd, encoded, 0, encoded.byteLength, 0);
      },

      async stat() {
        return wrapStats(await sys["party.openv.filesystem.read.stat"]!(path));
      },

      async close() {
        await sys["party.openv.filesystem.close"](fd);
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, options: ReadFileOptions & { encoding?: null }): Promise<Uint8Array>;
  async readFile(path: string, options: ReadFileOptions & { encoding: BufferEncoding }): Promise<string>;
  async readFile(path: string, options: BufferEncoding): Promise<string>;
  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding
  ): Promise<Uint8Array | string> {
    const encoding = typeof options === "string"
      ? options
      : (options as ReadFileOptions | undefined)?.encoding ?? null;

    const stats = await this.stat(path);
    const fd = await this.openv.system["party.openv.filesystem.open"](path, "r", 0o444);

    try {
      const data = await this.openv.system["party.openv.filesystem.read.read"]!(fd, stats.size);
      return encoding ? decode(data, encoding) : data;
    } finally {
      await this.openv.system["party.openv.filesystem.close"](fd);
    }
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this.#requireWrite();

    const flag = (typeof options === "object" ? options.flag : undefined) ?? "w";
    const fd = await this.openv.system["party.openv.filesystem.open"](path, flag as OpenFlags, 0o666);
    const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;

    try {
      await this.openv.system["party.openv.filesystem.write.write"]!(fd, encoded, 0, encoded.byteLength, 0);
    } finally {
      await this.openv.system["party.openv.filesystem.close"](fd);
    }
  }

  async appendFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this.writeFile(path, data, {
      ...(typeof options === "object" ? options : {}),
      flag: "a",
    });
  }

  async truncate(path: string, len = 0): Promise<void> {
    await this.#requireWrite();
    const data = await this.readFile(path);
    await this.writeFile(path, data.subarray(0, len));
  }

  async stat(path: string): Promise<Stats> {
    return wrapStats(await this.openv.system["party.openv.filesystem.read.stat"]!(path));
  }

  async lstat(path: string): Promise<Stats> {
    const lstat = this.openv.system["party.openv.filesystem.read.lstat"];
    if (!lstat) {
      return this.stat(path);
    }
    return wrapStats(await lstat(path));
  }

  async readlink(path: string): Promise<string> {
    const readlink = this.openv.system["party.openv.filesystem.read.readlink"];
    if (!readlink) {
      throw new Error("ENOTSUP: readlink is not supported");
    }
    return readlink(path);
  }

  async access(path: string, mode = constants.F_OK): Promise<void> {
    await this.stat(path); // throws if not found

    if (mode & constants.W_OK) {
      await this.#requireWrite();
    }
  }

  async readdir(path: string): Promise<string[]>;
  async readdir(path: string, options: ReaddirOptions & { withFileTypes: true }): Promise<Dirent[]>;
  async readdir(
    path: string,
    options?: ReaddirOptions
  ): Promise<string[] | Dirent[]> {
    const names = await this.openv.system["party.openv.filesystem.read.readdir"]!(path);

    if (options?.withFileTypes) {
      return Promise.all(
        names.map(async (name): Promise<Dirent> => {
          const s = await this.stat(`${path}/${name}`);
          return {
            name,
            isFile: s.isFile,
            isDirectory: s.isDirectory,
            isSymbolicLink: s.isSymbolicLink,
          };
        })
      );
    }

    return names;
  }

  async mkdir(path: string, options?: MkdirOptions | FileMode): Promise<void> {
    await this.#requireWrite();

    const mode = (typeof options === "number" ? options : options?.mode) ?? 0o777;
    const recursive = typeof options === "object" ? (options.recursive ?? false) : false;

    if (recursive) {
      await this.#mkdirRecursive(path, mode);
    } else {
      await this.openv.system["party.openv.filesystem.write.mkdir"]!(path, mode);
    }
  }

  async mkfifo(path: string, mode: FileMode = 0o666): Promise<void> {
    await this.#requireWrite();
    await this.openv.system["party.openv.filesystem.write.mkfifo"]!(path, mode);
  }

  async #mkdirRecursive(path: string, mode: FileMode): Promise<void> {
    const parts = path.replace(/\/+$/, "").split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        await this.openv.system["party.openv.filesystem.write.mkdir"]!(current, mode);
      } catch {
        const s = await this.stat(current);
        if (!s.isDirectory()) throw new Error(`ENOTDIR: not a directory: '${current}'`);
      }
    }
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    await this.#requireWrite();

    if (options?.recursive) {
      await this.rm(path, { recursive: true });
      return;
    }

    await this.openv.system["party.openv.filesystem.write.rmdir"]!(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.#requireWrite();

    let stat: Stats;
    try {
      stat = await this.stat(path);
    } catch (e) {
      if (options?.force) return;
      throw e;
    }

    if (stat.isDirectory()) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
      }

      const entries = await this.openv.system["party.openv.filesystem.read.readdir"]!(path);
      await Promise.all(entries.map(e => this.rm(`${path}/${e}`, { recursive: true, force: options.force })));
      await this.openv.system["party.openv.filesystem.write.rmdir"]!(path);
    } else {
      await this.openv.system["party.openv.filesystem.write.unlink"]!(path);
    }
  }

  async unlink(path: string): Promise<void> {
    await this.#requireWrite();
    await this.openv.system["party.openv.filesystem.write.unlink"]!(path);
  }

  async symlink(target: string, path: string, mode: FileMode = 0o777): Promise<void> {
    await this.#requireWrite();
    const symlink = this.openv.system["party.openv.filesystem.write.symlink"];
    if (!symlink) {
      throw new Error("ENOTSUP: symlink is not supported");
    }
    await symlink(target, path, mode);
  }

  async chmod(path: string, mode: FileMode): Promise<void> {
    await this.#requireWrite();
    const chmod = this.openv.system["party.openv.filesystem.write.chmod"];
    if (!chmod) {
      throw new Error("ENOTSUP: chmod is not supported");
    }
    await chmod(path, mode);
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    await this.#requireWrite();
    const chown = this.openv.system["party.openv.filesystem.write.chown"];
    if (!chown) {
      throw new Error("ENOTSUP: chown is not supported");
    }
    await chown(path, uid, gid);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.#requireWrite();

    try {
      await this.openv.system["party.openv.filesystem.write.rename"]!(oldPath, newPath);
    } catch {
      const data = await this.readFile(oldPath);
      await this.writeFile(newPath, data);
      await this.openv.system["party.openv.filesystem.write.unlink"]!(oldPath);
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const data = await this.readFile(src);
    await this.writeFile(dest, data);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.#requireWrite();
    const s = await this.stat(src);

    if (s.isDirectory()) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: '${src}' is a directory (use { recursive: true })`);
      }
      await this.mkdir(dest, { recursive: true });
      const entries = await this.openv.system["party.openv.filesystem.read.readdir"]!(src);
      await Promise.all(entries.map(e => this.cp(`${src}/${e}`, `${dest}/${e}`, options)));
    } else {
      await this.copyFile(src, dest);
    }
  }

  async watch(
    path: string,
    options?: WatchOptions
  ): Promise<AsyncIterable<{ eventType: "rename" | "change"; filename: string | null }>> {
    const { events, abort } = await this.openv.system["party.openv.filesystem.read.watch"]!(path, options);

    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          try {
            for await (const event of events) {
              yield {
                eventType: event.type === "rename" ? "rename" : "change",
                filename: event.filename ?? null,
              } as { eventType: "rename" | "change"; filename: string | null };
            }
          } finally {
            await abort();
          }
        })();
      },
    };
  }

  async mount(id: string, path: string): Promise<void> {
    await this.#requireVirtual();
    await this.openv.system["party.openv.filesystem.virtual.mount"]!(id, path);
  }

  async umount(path: string): Promise<void> {
    await this.#requireVirtual();
    await this.openv.system["party.openv.filesystem.virtual.unmount"]!(path);
  }

  async #requireWrite(): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.write")) {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    }
  }

  async #requireVirtual(): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.virtual")) {
      throw Object.assign(new Error("ENOTSUP: virtual filesystems are not supported"), { code: "ENOTSUP" });
    }
  }
}

function flagsFromNumber(flags: number): OpenFlags {
  const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL } = constants;

  const write = flags & O_WRONLY || flags & O_RDWR;
  const read = !write || flags & O_RDWR;

  if (flags & O_APPEND) return (read ? "a+" : "a") as OpenFlags;
  if (flags & O_EXCL) return "wx" as OpenFlags;
  if (flags & O_CREAT && flags & O_TRUNC) return (read ? "w+" : "w") as OpenFlags;
  if (flags & O_CREAT) return (read ? "a+" : "a") as OpenFlags;

  return (read && write ? "r+" : write ? "w" : "r") as OpenFlags;
}
