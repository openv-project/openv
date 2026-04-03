import SyncAPI, { SyncBlockingClient } from "@openv-project/api-sync";
import { FileSystemCoreComponent, FileSystemLocalComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemSyncComponent, OpEnv, ProcessLocalComponent } from "@openv-project/openv-api";

const WASI_ERRNO = {
    ESUCCESS: 0,
    EACCES: 2,
    EBADF: 8,
    EEXIST: 20,
    EINVAL: 28,
    EIO: 29,
    ENOENT: 44,
    ENOSYS: 52,
    ENOTDIR: 54,
    EPERM: 63,
    ESPIPE: 70,
};

const WASI_CLOCK = {
    REALTIME: 0,
    MONOTONIC: 1,
};

const WASI_FILETYPE = {
    UNKNOWN: 0,
    CHARACTER_DEVICE: 2,
    DIRECTORY: 3,
    REGULAR_FILE: 4,
    SYMBOLIC_LINK: 7,
};

const WASI_OFLAGS = {
    CREAT: 1,
    DIRECTORY: 2,
    EXCL: 4,
    TRUNC: 8,
};

const WASI_WHENCE = {
    SET: 0,
    CUR: 1,
    END: 2,
};

export class WasiRuntime {
    #openv: OpEnv<FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent>;
    #client: SyncBlockingClient;
    #readClient: SyncBlockingClient;
    #getmemory: () => WebAssembly.Memory;
    #encoder: TextEncoder;
    #pathByFd = new Map<number, string>();
    #preopenPathByFd = new Map<number, string>();
    #traceImports = false;

    constructor(openv: OpEnv<any>, getmemory: () => WebAssembly.Memory) {
        this.#openv = openv;
        this.#getmemory = getmemory;
        this.#encoder = new TextEncoder();
    }

    async init(): Promise<void> {
        this.#client = await (this.#openv.api["party.openv.api.sync"] as SyncAPI).createBlockingClient();
        // stdin reads can legitimately block indefinitely; use a dedicated no-timeout client for reads.
        this.#readClient = await (this.#openv.api["party.openv.api.sync"] as SyncAPI).createBlockingClient({ timeoutMs: null });
        this.#pathByFd.set(0, "/dev/stdin");
        this.#pathByFd.set(1, "/dev/stdout");
        this.#pathByFd.set(2, "/dev/stderr");
        try {
            this.#traceImports = this.#client.call<ProcessLocalComponent>("party.openv.process.local.getenv", "OPENV_WASI_TRACE_IMPORTS") === "1";
        } catch {
            this.#traceImports = false;
        }

        // for now force traceimports just for testing
        this.#traceImports = true;

        try {
            const preopenFd = this.#client.call<FileSystemCoreComponent>("party.openv.filesystem.open", "/", "r", 0o444) as number;
            this.#pathByFd.set(preopenFd, "/");
            this.#preopenPathByFd.set(preopenFd, "/");
        } catch {
            // If preopen cannot be created, path-based syscalls that require a preopen fd will return EBADF/ENOTDIR.
        }
    }

    args_get(args_ptr: number, args_buf_ptr: number): number {
        try {
            const args = this.#client.call<ProcessLocalComponent>("party.openv.process.local.getargs") as string[];
            args.shift(); // remove wasm shim bin
            const view = new DataView(this.#getmemory().buffer);

            let offsetOffset = args_ptr;
            let bufferOffset = args_buf_ptr;
            for (const arg of args) {
                view.setUint32(offsetOffset, bufferOffset, true);
                offsetOffset += 4;
                bufferOffset += this.#writeString(view, `${arg}\0`, bufferOffset);
            }

            return 0;
        } catch (e) {
            console.error("Error in args_get:", e);
            return 1;
        }
    }

    args_sizes_get(argc_ptr: number, argv_buf_size_ptr: number): number {
        try {
            const args = this.#client.call<ProcessLocalComponent>("party.openv.process.local.getargs") as string[];
            args.shift();
            const view = new DataView(this.#getmemory().buffer);

            view.setUint32(argc_ptr, args.length, true);
            const bufferSize = args.reduce((acc, arg) => acc + this.#byteLength(arg) + 1, 0);
            view.setUint32(argv_buf_size_ptr, bufferSize, true);

            return 0;
        } catch (e) {
            console.error("Error in args_sizes_get:", e);
            return 1;
        }
    }

    environ_get(environ_ptr: number, environ_buf_ptr: number): number {
        try {
            const names = this.#client.call<ProcessLocalComponent>("party.openv.process.local.listenv") as string[];
            const view = new DataView(this.#getmemory().buffer);

            let offsetOffset = environ_ptr;
            let bufferOffset = environ_buf_ptr;
            for (const name of names) {
                const value = this.#client.call<ProcessLocalComponent>("party.openv.process.local.getenv", name) as string | null;
                if (value === null) {
                    continue;
                }
                view.setUint32(offsetOffset, bufferOffset, true);
                offsetOffset += 4;
                bufferOffset += this.#writeString(view, `${name}=${value}\0`, bufferOffset);
            }

            return 0;
        } catch (e) {
            console.error("Error in environ_get:", e);
            return 1;
        }
    }

    environ_sizes_get(environ_ptr: number, environ_buf_size_ptr: number): number {
        try {
            const names = this.#client.call<ProcessLocalComponent>("party.openv.process.local.listenv") as string[];
            const view = new DataView(this.#getmemory().buffer);

            let envCount = 0;
            let bufferSize = 0;
            for (const name of names) {
                const value = this.#client.call<ProcessLocalComponent>("party.openv.process.local.getenv", name) as string | null;
                if (value === null) {
                    continue;
                }
                envCount += 1;
                bufferSize += this.#byteLength(name) + 1 + this.#byteLength(value) + 1;
            }

            view.setUint32(environ_ptr, envCount, true);
            view.setUint32(environ_buf_size_ptr, bufferSize, true);

            return 0;
        } catch (e) {
            console.error("Error in environ_sizes_get:", e);
            return 1;
        }
    }

    clock_res_get(clock_id: number, resolution_ptr: number): number {
        let resolutionValue: number;
        switch (clock_id) {
            case WASI_CLOCK.MONOTONIC:
                resolutionValue = 5000;
                break;
            case WASI_CLOCK.REALTIME:
                resolutionValue = 1000;
                break;
            default:
                return WASI_ERRNO.ENOSYS;
        }

        const view = new DataView(this.#getmemory().buffer);
        view.setUint32(resolution_ptr, resolutionValue, true);
        return WASI_ERRNO.ESUCCESS;
    }

    clock_time_get(clock_id: number, _precision: number, time_ptr: number): number {
        let nowMs = 0;
        switch (clock_id) {
            case WASI_CLOCK.MONOTONIC:
                nowMs = performance.now();
                break;
            case WASI_CLOCK.REALTIME:
                nowMs = Date.now();
                break;
            default:
                return WASI_ERRNO.ENOSYS;
        }

        const view = new DataView(this.#getmemory().buffer);
        const msInt = Math.trunc(nowMs);
        const decimalNs = BigInt(Math.round((nowMs - msInt) * 1_000_000));
        const ns = BigInt(msInt) * 1_000_000n + decimalNs;
        view.setBigUint64(time_ptr, ns, true);
        return WASI_ERRNO.ESUCCESS;
    }

    fd_advice(...args: unknown[]): number {
        console.debug("call to unimplemented fd_advice(", ...args, ")");
        return WASI_ERRNO.ESUCCESS;
    }

    fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number): number {
        try {
            const memory = this.#getmemory();
            const view = new DataView(memory.buffer);
            let totalRead = 0;

            for (const buf of this.#iovViews(view, iovs_ptr, iovs_len)) {
                if (buf.byteLength === 0) continue;
                const chunk = this.#readClient.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.read", fd, buf.byteLength) as Uint8Array;
                console.debug(`fd_read chunk: requested=${buf.byteLength}, actual=${chunk.byteLength}`, chunk);
                if (chunk.byteLength === 0) break;
                buf.set(chunk.subarray(0, Math.min(buf.byteLength, chunk.byteLength)));
                totalRead += Math.min(buf.byteLength, chunk.byteLength);
                if (chunk.byteLength < buf.byteLength) break;
            }

            console.debug(`fd_read: fd=${fd}, requested=${this.#iovViews(view, iovs_ptr, iovs_len).reduce((acc, buf) => acc + buf.byteLength, 0)}, totalRead=${totalRead}`);

            view.setUint32(nread_ptr, totalRead, true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_read:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_readdir(fd: number, buf_ptr: number, buf_len: number, cookie: bigint, bufused_ptr: number): number {
        throw new Error("fd_readdir is not implemented");
    }

    fd_renumber(from: number, to: number): number {
        try {
            if (this.#preopenPathByFd.has(from)) {
                return WASI_ERRNO.EBADF;
            }
            const path = this.#pathByFd.get(from);
            if (!path) return WASI_ERRNO.EBADF;
            this.#client.call<FileSystemLocalComponent>("party.openv.filesystem.local.dup2", from, to);
            this.#pathByFd.set(to, path);
            this.#pathByFd.delete(from);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_renumber:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_sync(fd: number): number {
        try {
            this.#client.call<FileSystemSyncComponent>("party.openv.filesystem.sync.sync", fd);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_sync:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number): number {
        try {
            const memory = this.#getmemory();
            const view = new DataView(memory.buffer);
            let nwritten = 0;
            for (const chunk of this.#iovViews(view, iovs_ptr, iovs_len)) {
                this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.write", fd, chunk);
                nwritten += chunk.byteLength;
            }
            view.setUint32(nwritten_ptr, nwritten, true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_write:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_close(fd: number): number {
        try {
            if (this.#preopenPathByFd.has(fd)) {
                return WASI_ERRNO.ESUCCESS;
            }
            this.#client.call<FileSystemCoreComponent>("party.openv.filesystem.close", fd);
            this.#pathByFd.delete(fd);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_close:", e);
            return WASI_ERRNO.EBADF;
        }
    }

    fd_seek(fd: number, offset: bigint, whence: number, new_offset_ptr: number): number {
        try {
            const mapped = this.#mapWasiWhence(whence);
            const next = this.#client.call<FileSystemCoreComponent>("party.openv.filesystem.lseek", fd, Number(offset), mapped) as number;
            const view = new DataView(this.#getmemory().buffer);
            view.setBigUint64(new_offset_ptr, BigInt(next), true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            return this.#toWasiErrno(e, WASI_ERRNO.EIO);
        }
    }

    fd_tell(fd: number, offset_ptr: number): number {
        try {
            const next = this.#client.call<FileSystemCoreComponent>("party.openv.filesystem.lseek", fd, 0, "cur") as number;
            const view = new DataView(this.#getmemory().buffer);
            view.setBigUint64(offset_ptr, BigInt(next), true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            return this.#toWasiErrno(e, WASI_ERRNO.EIO);
        }
    }

    fd_fdstat_get(fd: number, buf_ptr: number): number {
        try {
            const view = new DataView(this.#getmemory().buffer);
            const filetype = this.#filetypeForFd(fd);
            this.#writeFdstat(view, buf_ptr, filetype, 0);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_fdstat_get:", e);
            return WASI_ERRNO.EBADF;
        }
    }

    fd_fdstat_set_flags(fd: number, flags: number): number {
        try {
            const view = new DataView(this.#getmemory().buffer);
            const filetype = this.#filetypeForFd(fd);
            this.#writeFdstat(view, 0, filetype, flags);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_fdstat_set_flags:", e);
            return WASI_ERRNO.EBADF;
        }
    }

    fd_filestat_get(fd: number, buf_ptr: number): number {
        try {
            const view = new DataView(this.#getmemory().buffer);
            const path = this.#pathByFd.get(fd);

            if (fd <= 2 || path === undefined) {
                this.#writeFilestat(view, buf_ptr, WASI_FILETYPE.CHARACTER_DEVICE, 0);
                return WASI_ERRNO.ESUCCESS;
            }

            const stat = this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.stat", path) as { type: "DIRECTORY" | "FILE" | "SYMLINK"; size: number; atime: number; mtime: number; ctime: number };
            this.#writeFilestat(view, buf_ptr, this.#filetypeFromStatType(stat.type), stat.size);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_filestat_get:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_filestat_set_size(fd: number, size: bigint): number {
        try {
            const path = this.#pathByFd.get(fd);
            if (!path) return WASI_ERRNO.EBADF;
            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.truncate", path, Number(size));
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in fd_filestat_set_size:", e);
            return WASI_ERRNO.EIO;
        }
    }

    fd_prestat_get(fd: number, buf_ptr: number): number {
        const path = this.#preopenPathByFd.get(fd);
        if (!path) return WASI_ERRNO.EBADF;

        const view = new DataView(this.#getmemory().buffer);
        view.setUint8(buf_ptr, 0);
        view.setUint32(buf_ptr + 4, this.#byteLength(path), true);
        return WASI_ERRNO.ESUCCESS;
    }

    fd_prestat_dir_name(fd: number, path_ptr: number, path_len: number): number {
        const path = this.#preopenPathByFd.get(fd);
        if (!path) return WASI_ERRNO.EBADF;

        const expectedLen = this.#byteLength(path);
        if (path_len !== expectedLen) return WASI_ERRNO.EINVAL;

        const view = new DataView(this.#getmemory().buffer);
        this.#writeString(view, path, path_ptr);
        return WASI_ERRNO.ESUCCESS;
    }

    path_open(
        dirfd: number,
        _dirflags: number,
        path_ptr: number,
        path_len: number,
        oflags: number,
        _fs_rights_base: bigint,
        _fs_rights_inheriting: bigint,
        _fdflags: number,
        opened_fd_ptr: number,
    ): number {
        try {
            const basePath = this.#preopenPathByFd.get(dirfd) ?? this.#pathByFd.get(dirfd);
            if (!basePath) return WASI_ERRNO.ENOTDIR;

            const view = new DataView(this.#getmemory().buffer);
            const relPath = this.#readString(view, path_ptr, path_len);
            const fullPath = this.#normalizePath(`${basePath}/${relPath}`);

            let flags: "r" | "w" | "w+" | "a" | "r+" = "r";
            const create = (oflags & WASI_OFLAGS.CREAT) !== 0;
            const trunc = (oflags & WASI_OFLAGS.TRUNC) !== 0;
            if (create && trunc) {
                flags = "w+";
            } else if (create) {
                flags = "a";
            } else if (trunc) {
                flags = "w";
            }

            if ((oflags & WASI_OFLAGS.DIRECTORY) !== 0) {
                const st = this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.stat", fullPath) as { type: string };
                if (st.type !== "DIRECTORY") return WASI_ERRNO.ENOTDIR;
            }

            if ((oflags & WASI_OFLAGS.EXCL) !== 0 && create) {
                try {
                    this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.stat", fullPath);
                    return WASI_ERRNO.EEXIST;
                } catch {
                    // file does not exist, continue
                }
            }

            const fd = this.#client.call<FileSystemCoreComponent>("party.openv.filesystem.open", fullPath, flags, 0o666) as number;
            this.#pathByFd.set(fd, fullPath);
            view.setUint32(opened_fd_ptr, fd, true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_open:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_create_directory(fd: number, path_ptr: number, path_len: number): number {
        try {
            const path = this.#resolvePathFromFd(fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;
            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.mkdir", path, 0o777);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_create_directory:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_rename(old_fd: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number): number {
        try {
            const oldPath = this.#resolvePathFromFd(old_fd, old_path_ptr, old_path_len); 
            if (!oldPath) return WASI_ERRNO.ENOTDIR;
            // read new path from memory not fd
            const view = new DataView(this.#getmemory().buffer);
            const newPathRel = this.#readString(view, new_path_ptr, new_path_len);
            const newPath = this.#normalizePath(`${this.#resolvePathFromFd(new_fd, new_path_ptr, new_path_len)}/${newPathRel}`);

            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.rename", oldPath, newPath);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_rename:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_symlink(old_fd: number, old_flags: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number): number {
        try {
            const oldPath = this.#resolvePathFromFd(old_fd, old_path_ptr, old_path_len);
            if (!oldPath) return WASI_ERRNO.ENOTDIR;
            // read new path from memory not fd
            const view = new DataView(this.#getmemory().buffer);
            const newPathRel = this.#readString(view, new_path_ptr, new_path_len);
            const newPath = this.#normalizePath(`${this.#resolvePathFromFd(new_fd, new_path_ptr, new_path_len)}/${newPathRel}`);

            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.symlink", oldPath, newPath);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_link:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_unlink_file(fd: number, path_ptr: number, path_len: number): number {
        try {
            const path = this.#resolvePathFromFd(fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;
            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.unlink", path);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_unlink_file:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_remove_directory(fd: number, path_ptr: number, path_len: number): number {
        try {
            const path = this.#resolvePathFromFd(fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;
            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.rmdir", path);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_remove_directory:", e);
            return WASI_ERRNO.EIO;
        }
    }

    path_filestat_get(fd: number, _flags: number, path_ptr: number, path_len: number, buf_ptr: number): number {
        try {
            const path = this.#resolvePathFromFd(fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;

            const stat = this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.stat", path) as { type: "DIRECTORY" | "FILE" | "SYMLINK"; size: number };
            const view = new DataView(this.#getmemory().buffer);
            this.#writeFilestat(view, buf_ptr, this.#filetypeFromStatType(stat.type), stat.size);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_filestat_get:", e);
            return WASI_ERRNO.ENOENT;
        }
    }

    path_filestat_set_times(fd: number, path_ptr: number, path_len: number, atim: bigint, mtim: bigint, ctim: bigint): number {
        try {
            const path = this.#resolvePathFromFd(fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;
            this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.settimes", path, Number(atim), Number(mtim), Number(ctim));
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_filestat_set_times:", e);
            return WASI_ERRNO.ENOENT;
        }
    }

    poll_oneoff(...args: unknown[]): number {
        console.debug("call to unimplemented poll_oneoff(", ...args, ")");
        return WASI_ERRNO.ENOSYS;
    }

    path_readlink(dir_fd: number, path_ptr: number, path_len: number, buf_ptr: number, buf_len: number, bufused_ptr: number): number {
        try {            
            const path = this.#resolvePathFromFd(dir_fd, path_ptr, path_len);
            if (!path) return WASI_ERRNO.ENOTDIR;
            const target = this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.readlink", path) as string;
            const view = new DataView(this.#getmemory().buffer);
            const bytesWritten = this.#writeString(view, target, buf_ptr);
            view.setUint32(bufused_ptr, bytesWritten, true);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in path_readlink:", e);
            return WASI_ERRNO.ENOENT;
        }
    }

    proc_exit(code: number)  {
        this.#client.call<ProcessLocalComponent>("party.openv.process.local.exit", code);
    }

    random_get(buf_ptr: number, buf_len: number): number {
        try {
            const buffer = new Uint8Array(this.#getmemory().buffer, buf_ptr, buf_len);
            crypto.getRandomValues(buffer);
            return WASI_ERRNO.ESUCCESS;
        } catch (e) {
            console.error("Error in random_get:", e);
            return WASI_ERRNO.EIO;
        }
    }
    
    sched_yield(): number {
       if ("scheduler" in globalThis && "yield" in (globalThis as any).scheduler) {
            globalThis.scheduler.yield();
            return WASI_ERRNO.ESUCCESS;
       } else {
            console.warn("sched_yield called but scheduler.yield is not available");
            return WASI_ERRNO.ENOSYS;
       }
    }

    #writeString(memory: DataView, value: string, offset: number): number {
        const bytes = this.#encoder.encode(value);
        const buffer = new Uint8Array(memory.buffer, offset, bytes.length);
        buffer.set(bytes);
        return bytes.length;
    }

    #readString(memory: DataView, ptr: number, len: number): string {
        const buffer = new Uint8Array(memory.buffer, ptr, len);
        return new TextDecoder().decode(buffer);
    }

    #byteLength(value: string): number {
        return this.#encoder.encode(value).length;
    }

    #iovViews(memory: DataView, iovs: number, iovs_len: number): Uint8Array[] {
        const iovsBuffers: Uint8Array[] = [];
        let iovsOffset = iovs;

        for (let i = 0; i < iovs_len; i++) {
            const offset = memory.getUint32(iovsOffset, true);
            const len = memory.getUint32(iovsOffset + 4, true);
            iovsBuffers.push(new Uint8Array(memory.buffer, offset, len));
            iovsOffset += 8;
        }

        return iovsBuffers;
    }

    #writeFilestat(memory: DataView, ptr: number, filetype: number, size: number): void {
        memory.setBigUint64(ptr, 0n, true);
        memory.setBigUint64(ptr + 8, 0n, true);
        memory.setUint8(ptr + 16, filetype);
        memory.setUint32(ptr + 24, 0, true);
        memory.setBigUint64(ptr + 32, BigInt(size), true);
        memory.setBigUint64(ptr + 40, 0n, true);
        memory.setBigUint64(ptr + 48, 0n, true);
        memory.setBigUint64(ptr + 56, 0n, true);
    }

    #writeFdstat(memory: DataView, ptr: number, filetype: number, flags: number): void {
        memory.setUint8(ptr, filetype);
        memory.setUint16(ptr + 2, flags, true);
        memory.setBigUint64(ptr + 8, 0n, true);
        memory.setBigUint64(ptr + 16, 0n, true);
    }

    #filetypeFromStatType(type: "DIRECTORY" | "FILE" | "SYMLINK"): number {
        if (type === "DIRECTORY") return WASI_FILETYPE.DIRECTORY;
        if (type === "SYMLINK") return WASI_FILETYPE.SYMBOLIC_LINK;
        return WASI_FILETYPE.REGULAR_FILE;
    }

    #filetypeForFd(fd: number): number {
        if (fd <= 2) return WASI_FILETYPE.CHARACTER_DEVICE;
        const path = this.#pathByFd.get(fd);
        if (!path) return WASI_FILETYPE.UNKNOWN;
        try {
            const st = this.#client.call<FileSystemReadOnlyComponent>("party.openv.filesystem.read.stat", path) as { type: "DIRECTORY" | "FILE" | "SYMLINK" };
            return this.#filetypeFromStatType(st.type);
        } catch {
            return WASI_FILETYPE.UNKNOWN;
        }
    }

    #normalizePath(path: string): string {
        const pieces = path.split("/");
        const out: string[] = [];
        for (const piece of pieces) {
            if (!piece || piece === ".") continue;
            if (piece === "..") {
                out.pop();
                continue;
            }
            out.push(piece);
        }
        return `/${out.join("/")}`;
    }

    #resolvePathFromFd(fd: number, path_ptr: number, path_len: number): string | null {
        const basePath = this.#preopenPathByFd.get(fd) ?? this.#pathByFd.get(fd);
        if (!basePath) return null;
        const view = new DataView(this.#getmemory().buffer);
        const relPath = this.#readString(view, path_ptr, path_len);
        return this.#normalizePath(`${basePath}/${relPath}`);
    }

    #mapWasiWhence(whence: number): "set" | "cur" | "end" {
        switch (whence) {
            case WASI_WHENCE.SET:
                return "set";
            case WASI_WHENCE.CUR:
                return "cur";
            case WASI_WHENCE.END:
                return "end";
            default:
                throw new Error(`EINVAL: invalid whence ${whence}`);
        }
    }

    #toWasiErrno(error: unknown, fallback: number): number {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ESPIPE")) return WASI_ERRNO.ESPIPE;
        if (message.includes("EBADF")) return WASI_ERRNO.EBADF;
        if (message.includes("EINVAL")) return WASI_ERRNO.EINVAL;
        if (message.includes("ENOENT")) return WASI_ERRNO.ENOENT;
        if (message.includes("ENOTDIR")) return WASI_ERRNO.ENOTDIR;
        if (message.includes("EEXIST")) return WASI_ERRNO.EEXIST;
        if (message.includes("EACCES")) return WASI_ERRNO.EACCES;
        if (message.includes("EPERM")) return WASI_ERRNO.EPERM;
        if (message.includes("ENOSYS")) return WASI_ERRNO.ENOSYS;
        return fallback;
    }

    toImportObject(): WebAssembly.ModuleImports {
        const args_get = this.args_get.bind(this);
        const args_sizes_get = this.args_sizes_get.bind(this);
        const environ_get = this.environ_get.bind(this);
        const environ_sizes_get = this.environ_sizes_get.bind(this);
        const clock_res_get = this.clock_res_get.bind(this);
        const clock_time_get = this.clock_time_get.bind(this);
        const fd_advice = this.fd_advice.bind(this);
        const fd_read = this.fd_read.bind(this);
        const fd_readdir = this.fd_readdir.bind(this);
        const fd_renumber = this.fd_renumber.bind(this);
        const fd_sync = this.fd_sync.bind(this);
        const fd_close = this.fd_close.bind(this);
        const fd_seek = this.fd_seek.bind(this);
        const fd_tell = this.fd_tell.bind(this);
        const fd_fdstat_get = this.fd_fdstat_get.bind(this);
        const fd_fdstat_set_flags = this.fd_fdstat_set_flags.bind(this);
        const fd_filestat_get = this.fd_filestat_get.bind(this);
        const fd_filestat_set_size = this.fd_filestat_set_size.bind(this);
        const fd_prestat_get = this.fd_prestat_get.bind(this);
        const fd_prestat_dir_name = this.fd_prestat_dir_name.bind(this);
        const path_open = this.path_open.bind(this);
        const path_create_directory = this.path_create_directory.bind(this);
        const path_unlink_file = this.path_unlink_file.bind(this);
        const path_remove_directory = this.path_remove_directory.bind(this);
        const path_filestat_get = this.path_filestat_get.bind(this);
        const path_filestat_set_times = this.path_filestat_set_times.bind(this);
        const fd_write = this.fd_write.bind(this);
        const poll_oneoff = this.poll_oneoff.bind(this);
        const proc_exit = this.proc_exit.bind(this);
        const random_get = this.random_get.bind(this);
        // faking hard links since we dont have them right now
        const path_link = this.path_symlink.bind(this);
        const path_symlink = this.path_symlink.bind(this);
        const path_readlink = this.path_readlink.bind(this);
        const path_rename = this.path_rename.bind(this);
        const sched_yield = this.sched_yield.bind(this);
        const base = {
            args_get,
            args_sizes_get,
            environ_get,
            environ_sizes_get,
            clock_res_get,
            clock_time_get,
            fd_advice,
            fd_read,
            fd_readdir,
            fd_renumber,
            fd_sync,
            fd_close,
            fd_seek,
            fd_tell,
            fd_fdstat_get,
            fd_fdstat_set_flags,
            fd_filestat_get,
            fd_filestat_set_size,
            fd_prestat_get,
            fd_prestat_dir_name,
            path_open,
            path_create_directory,
            path_unlink_file,
            path_remove_directory,
            path_filestat_get,
            path_filestat_set_times,
            fd_write,
            poll_oneoff,
            proc_exit,
            random_get,
            path_link,
            path_readlink,
            path_symlink,
            path_rename,
            sched_yield,
        };
        if (!this.#traceImports) {
            return base;
        }
        return new Proxy(base, {
            get: (target, prop, receiver) => {
                const v = Reflect.get(target, prop, receiver);
                if (typeof prop !== "string" || typeof v !== "function") return v;
                return (...args: unknown[]) => {
                    console.debug(`[wasi:${prop}]`, ...args);
                    return (v as (...inner: unknown[]) => unknown)(...args);
                };
            },
        });
    }

}
