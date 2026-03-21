import { FileMode, FileSystemCoreComponent, FileSystemEvent, FileSystemLocalComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, FS_LOCAL_NAMESPACE, FS_LOCAL_NAMESPACE_VERSIONED, FS_NAMESPACE, FS_NAMESPACE_VERSIONED, FS_PIPE_NAMESPACE, FS_PIPE_NAMESPACE_VERSIONED, FS_READ_NAMESPACE, FS_READ_NAMESPACE_VERSIONED, FS_VIRTUAL_NAMESPACE, FS_VIRTUAL_NAMESPACE_VERSIONED, FS_WRITE_NAMESPACE, FS_WRITE_NAMESPACE_VERSIONED, FsStats, OpenFlags, ProcessComponent, SystemComponent } from "@openv-project/openv-api"
import { CoreProcessExt } from "./mod";

type vfs = {
    mount: (path: string) => Promise<void>;
    unmount: (path: string) => Promise<void>;
    open: (path: string, ofd: number, flags: OpenFlags, mode: FileMode) => Promise<void>;
    create: (path: string, mode?: FileMode) => Promise<void>;
    close: (ofd: number) => Promise<void>;
    read: (ofd: number, length: number, position?: number) => Promise<Uint8Array>;
    write: (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>;
    stat: (path: string) => Promise<FsStats>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, mode?: FileMode) => Promise<void>;
    rmdir: (path: string) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    watch: (path: string, options?: { recursive?: boolean }) => Promise<{
        events: AsyncIterable<FileSystemEvent>;
        abort: () => Promise<void>;
    }>;
};

const CORE_FS_EXT_NAMESPACE = "party.openv.impl.filesystem" as const;
const CORE_FS_EXT_NAMESPACE_VERSIONED = "party.openv.impl.filesystem/0.1.0" as const;

/**
 * Internal extensions for linking with ProcessScopedFS
 */
export interface CoreFSExt extends SystemComponent<typeof CORE_FS_EXT_NAMESPACE_VERSIONED, typeof CORE_FS_EXT_NAMESPACE> {
    /**
     * Read from a file using OFD.
     */
    ["party.openv.impl.filesystem.readByOfd"](ofd: number, length: number, position?: number): Promise<Uint8Array>;

    /**
     * Write to a file using OFD.
     */
    ["party.openv.impl.filesystem.writeByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number>;

    /**
     * Close a file using OFD.
     */
    ["party.openv.impl.filesystem.closeByOfd"](ofd: number): Promise<void>;

    /**
     * Check if an OFD is valid and has an associated provider.
     */
    ["party.openv.impl.filesystem.hasOfd"](ofd: number): Promise<boolean>;

    /**
     * Create an anonymous pipe at the OFD level. Returns [readOfd, writeOfd].
     * Both OFDs are entries in the global open file table backed by a shared
     * in-memory ring buffer.
     */
    ["party.openv.impl.filesystem.createPipeOfd"](bufferSize?: number): Promise<[readOfd: number, writeOfd: number]>;
}

export class CoreFS implements FileSystemVirtualComponent, FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemPipeComponent, CoreFSExt {
    async ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}".`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.create) {
            throw new Error(`Virtual filesystem "${id}" does not implement create.`);
        }
        return provider.create(subpath, mode);
    }
    async ["party.openv.filesystem.virtual.oncreate"](id: string, handler: (path: string, mode?: FileMode) => Promise<void>): Promise<void> {
        const provider = this.#vfsTable.get(id);
        if (!provider) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }
        provider.create = handler;
    }

    async ["party.openv.filesystem.write.write"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        // Check pipe table first
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo && pipeInfo.role === "write") {
            return this.#pipeWrite(pipeInfo.pipeId, buffer, offset, length);
        }

        const entry = this.#ofdTable.get(ofd);
        if (!entry) throw new Error(`Invalid open file number ${ofd}`);
        if (!entry.provider || typeof entry.provider.write !== "function") {
            throw new Error(`Open file number ${ofd} is not backed by a provider that supports write.`);
        }
        return entry.provider.write(ofd, buffer, offset, length, position);
    }

    // Map of mountpoint -> vfs id
    #mountTable: Map<string, string> = new Map();

    async ["party.openv.filesystem.virtual.unmount"](path: string): Promise<void> {
        // Normalize mount path: remove trailing slash (except for root)
        const normalized = path === "/" ? "/" : path.replace(/\/+$/, "");
        const id = this.#mountTable.get(normalized);
        if (!id) {
            throw new Error(`No mountpoint found at "${path}".`);
        }

        const provider = this.#vfsTable.get(id);
        if (!provider) {
            this.#mountTable.delete(normalized);
            return;
        }

        if (provider.unmount) {
            await provider.unmount(normalized);
        }

        this.#mountTable.delete(normalized);
    }

    async ["party.openv.filesystem.virtual.mount"](id: string, path: string): Promise<void> {
        if (!this.#vfsTable.has(id)) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }

        // Normalize mount path: ensure it starts with / and strip trailing slash (except root)
        let normalized = path || "/";
        if (!normalized.startsWith("/")) normalized = "/" + normalized;
        normalized = normalized === "/" ? "/" : normalized.replace(/\/+$/, "");

        if (this.#mountTable.has(normalized)) {
            throw new Error(`Mountpoint "${normalized}" is already in use.`);
        }

        const provider = this.#vfsTable.get(id)!;

        this.#mountTable.set(normalized, id);

        try {
            if (provider.mount) {
                await provider.mount(normalized);
            }
        } catch (err) {
            this.#mountTable.delete(normalized);
            throw err;
        }
    }

    async ["party.openv.filesystem.write.mkdir"](path: string, mode?: FileMode): Promise<void> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.mkdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement mkdir.`);
        }
        return provider.mkdir(subpath, mode);
    }

    async ["party.openv.filesystem.write.rmdir"](path: string): Promise<void> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.rmdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement rmdir.`);
        }
        return provider.rmdir(subpath);
    }

    async ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void> {
        const rOld = this.#resolveMountPath(oldPath);
        const rNew = this.#resolveMountPath(newPath);
        if (!rOld) {
            throw new Error(`No mountpoint found for path "${oldPath}". Use mount to attach a virtual filesystem.`);
        }
        if (!rNew) {
            throw new Error(`No mountpoint found for path "${newPath}". Use mount to attach a virtual filesystem.`);
        }
        if (rOld.id !== rNew.id) {
            throw new Error(`Cross-provider rename is not supported: "${rOld.id}" -> "${rNew.id}".`);
        }
        const provider = this.#vfsTable.get(rOld.id);
        if (!provider || !provider.rename) {
            throw new Error(`Virtual filesystem "${rOld.id}" does not implement rename.`);
        }
        return provider.rename(rOld.subpath, rNew.subpath);
    }

    async ["party.openv.filesystem.write.unlink"](path: string): Promise<void> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.unlink) {
            throw new Error(`Virtual filesystem "${id}" does not implement unlink.`);
        }
        return provider.unlink(subpath);
    }

    async ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.stat) {
            throw new Error(`Virtual filesystem "${id}" does not implement stat.`);
        }
        return provider.stat(subpath);
    }

    async ["party.openv.filesystem.read.read"](ofd: number, length: number, position?: number): Promise<Uint8Array> {
        // Check pipe table first
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo && pipeInfo.role === "read") {
            return this.#pipeRead(pipeInfo.pipeId, length);
        }

        const entry = this.#ofdTable.get(ofd);
        if (!entry) throw new Error(`Invalid open file number ${ofd}`);
        if (!entry.provider || typeof entry.provider.read !== "function") {
            throw new Error(`Open file number ${ofd} is not backed by a provider that supports read.`);
        }
        return entry.provider.read(ofd, length, position);
    }


    async ["party.openv.filesystem.read.readdir"](path: string): Promise<string[]> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.readdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement readdir.`);
        }
        return provider.readdir(subpath);
    }

    async ["party.openv.filesystem.read.watch"](path: string, options?: { recursive?: boolean; }): Promise<{ events: AsyncIterable<FileSystemEvent>; abort: () => Promise<void>; }> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.watch) {
            throw new Error(`Virtual filesystem "${id}" does not implement watch.`);
        }
        return provider.watch(subpath, options);
    }
    // Global open file table. Each entry is an "open file description" (ofd), analogous
    // to the Linux open file table. Process-local file descriptors point into this table.
    // In the system (non-scoped) environment, open/close/read/write operate directly on ofds.
    #ofdCounter = 100;
    #ofdTable: Map<number, {
        path: string;
        providerId?: string;
        provider?: Partial<vfs>;
        flags: OpenFlags;
        mode: FileMode;
    }> = new Map();

    async ["party.openv.filesystem.open"](path: string, flags: OpenFlags, mode: FileMode): Promise<number> {
        // Resolve path to mounted vfs provider
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }

        const { id, subpath } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }
        if (!provider.open) {
            throw new Error(`Virtual filesystem "${id}" does not implement open.`);
        }

        const providerOpen = provider.open!;
        const ofd = ++this.#ofdCounter;
        await providerOpen(subpath, ofd, flags, mode);
        this.#ofdTable.set(ofd, {
            path,
            providerId: id,
            provider,
            flags,
            mode,
        });
        return ofd;
    }

    async ["party.openv.filesystem.close"](ofd: number): Promise<void> {
        const entry = this.#ofdTable.get(ofd);
        if (!entry) {
            throw new Error(`Invalid open file number ${ofd}`);
        }

        this.#ofdTable.delete(ofd);

        // If this ofd was backed by a provider and the provider implements close, forward.
        if (entry.provider && typeof entry.provider.close === "function") {
            await entry.provider.close(ofd);
            return;
        }

        // Nothing to do for non-provider-backed ofds.
        return;
    }

    async ["party.openv.filesystem.virtual.onstat"](id: string, handler: (path: string) => Promise<FsStats>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.stat = handler;
    }
    async ["party.openv.filesystem.virtual.onreaddir"](id: string, handler: (path: string) => Promise<string[]>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.readdir = handler;
    }
    async ["party.openv.filesystem.virtual.onwatch"](id: string, handler: (path: string, options?: { recursive?: boolean; }) => Promise<{ events: AsyncIterable<FileSystemEvent>; abort: () => Promise<void>; }>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.watch = handler;
    }
    async ["party.openv.filesystem.virtual.onopen"](id: string, handler: (path: string, fd: number, flags: OpenFlags, mode: FileMode) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.open = handler;
    }

    /**
     * This object is populated with vfs providers. When `party.openv.filesystem.virtual.create` is called, an empty
     * but named partial vfs object is created. The `party.openv.filesystem.virtual.on*` functions register the
     * corresponding function on the vfs object.
     */
    #vfsTable: Map<string, Partial<vfs>> = new Map();

    async ["party.openv.filesystem.virtual.create"](id: string): Promise<void> {
        if (this.#vfsTable.has(id)) {
            throw new Error(`Virtual filesystem "${id}" already exists.`);
        }
        this.#vfsTable.set(id, {});
    }

    async ["party.openv.filesystem.virtual.destroy"](id: string): Promise<void> {
        if (!this.#vfsTable.has(id)) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }
        this.#vfsTable.delete(id);
    }

    async ["party.openv.filesystem.virtual.onmount"](id: string, handler: (path: string) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.mount = handler;
    }

    async ["party.openv.filesystem.virtual.onunmount"](id: string, handler: (path: string) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.unmount = handler;
    }

    async ["party.openv.filesystem.virtual.onclose"](id: string, handler: (fd: number) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.close = handler;
    }

    async ["party.openv.filesystem.virtual.onread"](id: string, handler: (ofd: number, length: number, position?: number) => Promise<Uint8Array>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.read = handler;
    }

    async ["party.openv.filesystem.virtual.onwrite"](id: string, handler: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.write = handler;
    }

    async ["party.openv.filesystem.virtual.onmkdir"](id: string, handler: (path: string, mode: FileMode) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.mkdir = async (path: string, mode?: FileMode) => {
            await handler(path, mode!);
        };
    }

    async ["party.openv.filesystem.virtual.onrmdir"](id: string, handler: (path: string) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.rmdir = handler;
    }

    async ["party.openv.filesystem.virtual.onrename"](id: string, handler: (oldPath: string, newPath: string) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.rename = handler;
    }

    async ["party.openv.filesystem.virtual.onunlink"](id: string, handler: (path: string) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.unlink = handler;
    }

    static readonly DEFAULT_PIPE_BUFFER_SIZE = 65536;

    /**
     * Internal pipe state. A pipe is a unidirectional in-memory byte stream shared
     * between a read OFD and a write OFD.
     */
    #pipeTable: Map<number, {
        buffer: Uint8Array;
        /** Write cursor: how many bytes have been written into the buffer. */
        head: number;
        /** Read cursor: how many bytes have been consumed from the buffer. */
        tail: number;
        readClosed: boolean;
        writeClosed: boolean;
        /** Resolvers for readers waiting for data (or EOF). */
        pendingReaders: Array<() => void>;
        /** Resolvers for writers waiting for space. */
        pendingWriters: Array<() => void>;
    }> = new Map();

    #pipeIdCounter = 0;

    /**
     * Maps an OFD to its pipe id and role ("read" or "write").
     */
    #ofdToPipe: Map<number, { pipeId: number; role: "read" | "write" }> = new Map();

    async ["party.openv.impl.filesystem.readByOfd"](ofd: number, length: number, position?: number): Promise<Uint8Array> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo && pipeInfo.role === "read") {
            return this.#pipeRead(pipeInfo.pipeId, length);
        }
        return this["party.openv.filesystem.read.read"](ofd, length, position);
    }

    async ["party.openv.impl.filesystem.writeByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo && pipeInfo.role === "write") {
            return this.#pipeWrite(pipeInfo.pipeId, buffer, offset, length);
        }
        return this["party.openv.filesystem.write.write"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.impl.filesystem.closeByOfd"](ofd: number): Promise<void> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            this.#pipeCloseEnd(pipeInfo.pipeId, pipeInfo.role);
            this.#ofdToPipe.delete(ofd);
            this.#ofdTable.delete(ofd);
            return;
        }
        return this["party.openv.filesystem.close"](ofd);
    }

    async ["party.openv.impl.filesystem.hasOfd"](ofd: number): Promise<boolean> {
        return this.#ofdTable.has(ofd);
    }

    async ["party.openv.impl.filesystem.createPipeOfd"](bufferSize?: number): Promise<[readOfd: number, writeOfd: number]> {
        return this.#createPipeOfdPair(bufferSize);
    }

    async ["party.openv.filesystem.pipe.create"](bufferSize?: number): Promise<[readEnd: number, writeEnd: number]> {
        return this.#createPipeOfdPair(bufferSize);
    }

    #createPipeOfdPair(bufferSize?: number): [readOfd: number, writeOfd: number] {
        const size = bufferSize ?? CoreFS.DEFAULT_PIPE_BUFFER_SIZE;
        const pipeId = ++this.#pipeIdCounter;

        this.#pipeTable.set(pipeId, {
            buffer: new Uint8Array(size),
            head: 0,
            tail: 0,
            readClosed: false,
            writeClosed: false,
            pendingReaders: [],
            pendingWriters: [],
        });

        const readOfd = ++this.#ofdCounter;
        const writeOfd = ++this.#ofdCounter;

        this.#ofdTable.set(readOfd, {
            path: `<pipe:${pipeId}:read>`,
            flags: "r",
            mode: 0,
        });
        this.#ofdTable.set(writeOfd, {
            path: `<pipe:${pipeId}:write>`,
            flags: "w",
            mode: 0,
        });

        this.#ofdToPipe.set(readOfd, { pipeId, role: "read" });
        this.#ofdToPipe.set(writeOfd, { pipeId, role: "write" });

        return [readOfd, writeOfd];
    }

    async #pipeRead(pipeId: number, length: number): Promise<Uint8Array> {
        const pipe = this.#pipeTable.get(pipeId);
        if (!pipe) throw new Error(`Pipe ${pipeId} does not exist.`);

        while (pipe.head === pipe.tail && !pipe.writeClosed) {
            await new Promise<void>(resolve => pipe.pendingReaders.push(resolve));
        }

        if (pipe.head === pipe.tail && pipe.writeClosed) {
            return new Uint8Array(0);
        }

        const available = pipe.head - pipe.tail;
        const toRead = Math.min(length, available);
        const result = pipe.buffer.slice(pipe.tail, pipe.tail + toRead);
        pipe.tail += toRead;

        if (pipe.tail === pipe.head) {
            pipe.tail = 0;
            pipe.head = 0;
        }

        for (const resolve of pipe.pendingWriters.splice(0)) resolve();

        return result;
    }

    async #pipeWrite(pipeId: number, buffer: Uint8Array, offset?: number, length?: number): Promise<number> {
        const pipe = this.#pipeTable.get(pipeId);
        if (!pipe) throw new Error(`Pipe ${pipeId} does not exist.`);
        if (pipe.readClosed) throw new Error(`Broken pipe: read end is closed.`);

        const srcOffset = offset ?? 0;
        const toWrite = length ?? (buffer.length - srcOffset);
        const src = buffer.subarray(srcOffset, srcOffset + toWrite);

        let written = 0;
        while (written < src.length) {
            if (pipe.readClosed) throw new Error(`Broken pipe: read end is closed.`);

            const space = pipe.buffer.length - pipe.head;
            if (space === 0) {
                if (pipe.tail > 0) {
                    const remaining = pipe.head - pipe.tail;
                    pipe.buffer.copyWithin(0, pipe.tail, pipe.head);
                    pipe.tail = 0;
                    pipe.head = remaining;
                    continue;
                }
                await new Promise<void>(resolve => pipe.pendingWriters.push(resolve));
                continue;
            }

            const chunk = Math.min(src.length - written, space);
            pipe.buffer.set(src.subarray(written, written + chunk), pipe.head);
            pipe.head += chunk;
            written += chunk;

            for (const resolve of pipe.pendingReaders.splice(0)) {
                resolve();
            }
        }

        return written;
    }

    #pipeCloseEnd(pipeId: number, role: "read" | "write"): void {
        const pipe = this.#pipeTable.get(pipeId);
        if (!pipe) return;

        if (role === "read") {
            pipe.readClosed = true;
            for (const resolve of pipe.pendingWriters.splice(0)) {
                resolve();
            }
        } else {
            pipe.writeClosed = true;
            for (const resolve of pipe.pendingReaders.splice(0)) {
                resolve();
            }
        }

        if (pipe.readClosed && pipe.writeClosed) {
            this.#pipeTable.delete(pipeId);
        }
    }

    supports(ns: typeof CORE_FS_EXT_NAMESPACE_VERSIONED | typeof CORE_FS_EXT_NAMESPACE): Promise<typeof CORE_FS_EXT_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_PIPE_NAMESPACE | typeof FS_PIPE_NAMESPACE_VERSIONED): Promise<typeof FS_PIPE_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_VIRTUAL_NAMESPACE | typeof FS_VIRTUAL_NAMESPACE_VERSIONED): Promise<typeof FS_VIRTUAL_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_READ_NAMESPACE | typeof FS_READ_NAMESPACE_VERSIONED): Promise<typeof FS_READ_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_WRITE_NAMESPACE | typeof FS_WRITE_NAMESPACE_VERSIONED): Promise<typeof FS_WRITE_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_NAMESPACE | typeof FS_NAMESPACE_VERSIONED): Promise<typeof FS_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (
            ns === CORE_FS_EXT_NAMESPACE ||
            ns === CORE_FS_EXT_NAMESPACE_VERSIONED
        ) {
            return CORE_FS_EXT_NAMESPACE_VERSIONED;
        }
        if (
            ns === FS_PIPE_NAMESPACE ||
            ns === FS_PIPE_NAMESPACE_VERSIONED
        ) {
            return FS_PIPE_NAMESPACE_VERSIONED;
        }
        if (
            ns === FS_VIRTUAL_NAMESPACE ||
            ns === FS_VIRTUAL_NAMESPACE_VERSIONED
        ) {
            return FS_VIRTUAL_NAMESPACE_VERSIONED;
        }
        if (
            ns === FS_READ_NAMESPACE ||
            ns === FS_READ_NAMESPACE_VERSIONED
        ) {
            return FS_READ_NAMESPACE_VERSIONED;
        }
        if (
            ns === FS_WRITE_NAMESPACE ||
            ns === FS_WRITE_NAMESPACE_VERSIONED
        ) {
            return FS_WRITE_NAMESPACE_VERSIONED;
        }
        if (
            ns === FS_NAMESPACE ||
            ns === FS_NAMESPACE_VERSIONED
        ) {
            return FS_NAMESPACE_VERSIONED;
        }
        return null;
    }

    /**
     * Retrieves the vfs entry for the given id, throwing if it doesn't exist.
     */
    #getVfs(id: string): Partial<vfs> {
        const vfs = this.#vfsTable.get(id);
        if (!vfs) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }
        return vfs;
    }

    /**
     * Resolve a regular filesystem path against the mount table.
     * Finds the longest matching mountpoint prefix and returns the provider id and subpath.
     * Returns null if no mountpoint matches.
     */
    #resolveMountPath(path: string): { id: string; subpath: string } | null {
        if (!path.startsWith("/")) path = "/" + path;
        let bestMount: string | null = null;
        for (const mountPoint of this.#mountTable.keys()) {
            if (mountPoint === "/") {
                // root matches everything
                if (bestMount === null) bestMount = mountPoint;
                continue;
            }
            if (path === mountPoint || path.startsWith(mountPoint + "/")) {
                if (bestMount === null || mountPoint.length > bestMount.length) {
                    bestMount = mountPoint;
                }
            }
        }
        // If no specific mount matched but root exists, prefer root
        if (bestMount === null && this.#mountTable.has("/")) {
            bestMount = "/";
        }
        if (bestMount === null) return null;
        const id = this.#mountTable.get(bestMount)!;
        let sub = "/";
        if (bestMount === "/") {
            sub = path === "" ? "/" : path;
        } else {
            const remainder = path.slice(bestMount.length);
            sub = remainder === "" ? "/" : remainder.startsWith("/") ? remainder : "/" + remainder;
        }
        return { id, subpath: sub };
    }

}

const S_IRUSR = 0o400;
const S_IWUSR = 0o200;
const S_IXUSR = 0o100;
const S_IRGRP = 0o040;
const S_IWGRP = 0o020;
const S_IXGRP = 0o010;
const S_IROTH = 0o004;
const S_IWOTH = 0o002;
const S_IXOTH = 0o001;
const S_ISVTX = 0o1000;

type AccessMode = "read" | "write" | "execute";

function checkMode(stat: FsStats, uid: number, gid: number, access: AccessMode): boolean {
    if (uid === 0) {
        if (access === "execute") return !!(stat.mode & (S_IXUSR | S_IXGRP | S_IXOTH));
        return true;
    }
    const isOwner = stat.uid === uid;
    const isGroup = stat.gid === gid;
    let r: number, w: number, x: number;
    if (isOwner) { r = S_IRUSR; w = S_IWUSR; x = S_IXUSR; }
    else if (isGroup) { r = S_IRGRP; w = S_IWGRP; x = S_IXGRP; }
    else { r = S_IROTH; w = S_IWOTH; x = S_IXOTH; }
    switch (access) {
        case "read": return !!(stat.mode & r);
        case "write": return !!(stat.mode & w);
        case "execute": return !!(stat.mode & x);
    }
}

function requireAccess(stat: FsStats, uid: number, gid: number, access: AccessMode, path: string): void {
    if (!checkMode(stat, uid, gid, access)) {
        throw new Error(`EACCES: permission denied, ${access} '${path}'`);
    }
}

export class ProcessScopedFS implements
    FileSystemCoreComponent,
    FileSystemReadOnlyComponent,
    FileSystemReadWriteComponent,
    FileSystemLocalComponent {
    #system: FileSystemCoreComponent &
        FileSystemReadOnlyComponent &
        FileSystemReadWriteComponent &
        FileSystemPipeComponent &
        CoreFSExt &
        ProcessComponent &
        CoreProcessExt;
    #pid: number;
    #umask: number;

    #fdCounter = 2;
    #fdToOfd: Map<number, number> = new Map();

    constructor(pid: number, system: FileSystemCoreComponent &
        FileSystemReadOnlyComponent &
        FileSystemReadWriteComponent &
        FileSystemPipeComponent &
        CoreFSExt &
        ProcessComponent &
        CoreProcessExt, umask = 0o022) {
        this.#system = system;
        this.#pid = pid;
        this.#umask = umask;
    }

    async #getUid(): Promise<number> {
        return this.#system["party.openv.process.getuid"](this.#pid);
    }

    async #getGid(): Promise<number> {
        return this.#system["party.openv.process.getgid"](this.#pid);
    }

    async #statAndCheck(path: string, access: AccessMode): Promise<FsStats> {
        const stat = await this.#system["party.openv.filesystem.read.stat"](path);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(stat, uid, gid, access, path);
        return stat;
    }

    #applyUmask(mode: FileMode): FileMode {
        return mode & ~this.#umask;
    }

    async #checkPathTraversal(path: string): Promise<void> {
        const uid = await this.#getUid();
        if (uid === 0) return;
        const gid = await this.#getGid();
        const parts = path.split("/").filter(Boolean);
        for (let i = 0; i < parts.length - 1; i++) {
            const dir = "/" + parts.slice(0, i + 1).join("/");
            try {
                const stat = await this.#system["party.openv.filesystem.read.stat"](dir);
                if (stat.type !== "DIRECTORY") continue;
                requireAccess(stat, uid, gid, "execute", dir);
            } catch (e) {
                if (e instanceof Error && e.message.startsWith("EACCES")) throw e;
            }
        }
    }

    #resolveOfd(fd: number): number {
        const ofd = this.#fdToOfd.get(fd);
        if (ofd === undefined) throw new Error(`Invalid file descriptor ${fd}`);
        return ofd;
    }

    async ["party.openv.filesystem.open"](path: string, flags: OpenFlags, mode?: FileMode): Promise<number> {
        await this.#checkPathTraversal(path);

        const isWrite = flags.includes("w") || flags.includes("a") || flags.includes("+");
        const isRead = flags.includes("r") || flags.includes("+");
        const uid = await this.#getUid();
        const gid = await this.#getGid();

        let stat: FsStats | null = null;
        try { stat = await this.#system["party.openv.filesystem.read.stat"](path); } catch { }

        if (stat) {
            if (isRead) requireAccess(stat, uid, gid, "read", path);
            if (isWrite) requireAccess(stat, uid, gid, "write", path);
        } else if (isWrite) {
            const parent = path.split("/").slice(0, -1).join("/") || "/";
            const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
            requireAccess(parentStat, uid, gid, "write", parent);
            requireAccess(parentStat, uid, gid, "execute", parent);
        } else {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }

        const ofd = await this.#system["party.openv.filesystem.open"](
            path, flags, mode !== undefined ? this.#applyUmask(mode) : mode
        );
        const fd = ++this.#fdCounter;
        this.#fdToOfd.set(fd, ofd);
        return fd;
    }

    async ["party.openv.filesystem.close"](fd: number): Promise<void> {
        const ofd = this.#resolveOfd(fd);
        this.#fdToOfd.delete(fd);
        await this.#system["party.openv.impl.filesystem.closeByOfd"](ofd);
    }

    async ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats> {
        await this.#checkPathTraversal(path);
        return this.#system["party.openv.filesystem.read.stat"](path);
    }

    async ["party.openv.filesystem.read.read"](fd: number, length: number, position?: number): Promise<Uint8Array> {
        const ofd = this.#resolveOfd(fd);
        return this.#system["party.openv.impl.filesystem.readByOfd"](ofd, length, position);
    }

    async ["party.openv.filesystem.read.readdir"](path: string): Promise<string[]> {
        await this.#checkPathTraversal(path);
        await this.#statAndCheck(path, "read");
        return this.#system["party.openv.filesystem.read.readdir"](path);
    }

    async ["party.openv.filesystem.read.watch"](path: string, options?: { recursive?: boolean }): Promise<{
        events: AsyncIterable<FileSystemEvent>;
        abort: () => Promise<void>;
    }> {
        await this.#checkPathTraversal(path);
        await this.#statAndCheck(path, "read");
        return this.#system["party.openv.filesystem.read.watch"](path, options);
    }

    async ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        return this.#system["party.openv.impl.filesystem.writeByOfd"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.filesystem.write.create"](path: string, mode: FileMode = 0o666): Promise<void> {
        await this.#checkPathTraversal(path);
        const parent = path.split("/").slice(0, -1).join("/") || "/";
        const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(parentStat, uid, gid, "write", parent);
        requireAccess(parentStat, uid, gid, "execute", parent);
        return this.#system["party.openv.filesystem.write.create"](path, this.#applyUmask(mode));
    }

    async ["party.openv.filesystem.write.mkdir"](path: string, mode: FileMode = 0o777): Promise<void> {
        await this.#checkPathTraversal(path);
        const parent = path.split("/").slice(0, -1).join("/") || "/";
        const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(parentStat, uid, gid, "write", parent);
        requireAccess(parentStat, uid, gid, "execute", parent);
        return this.#system["party.openv.filesystem.write.mkdir"](path, this.#applyUmask(mode));
    }

    async ["party.openv.filesystem.write.rmdir"](path: string): Promise<void> {
        await this.#checkPathTraversal(path);
        const parent = path.split("/").slice(0, -1).join("/") || "/";
        const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(parentStat, uid, gid, "write", parent);
        requireAccess(parentStat, uid, gid, "execute", parent);
        return this.#system["party.openv.filesystem.write.rmdir"](path);
    }

    async ["party.openv.filesystem.write.unlink"](path: string): Promise<void> {
        await this.#checkPathTraversal(path);
        const parent = path.split("/").slice(0, -1).join("/") || "/";
        const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(parentStat, uid, gid, "write", parent);
        requireAccess(parentStat, uid, gid, "execute", parent);
        if (parentStat.mode & S_ISVTX) {
            const fileStat = await this.#system["party.openv.filesystem.read.stat"](path);
            if (uid !== 0 && fileStat.uid !== uid) {
                throw new Error(`EACCES: permission denied (sticky bit), unlink '${path}'`);
            }
        }
        return this.#system["party.openv.filesystem.write.unlink"](path);
    }

    async ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void> {
        await this.#checkPathTraversal(oldPath);
        await this.#checkPathTraversal(newPath);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        const oldParent = oldPath.split("/").slice(0, -1).join("/") || "/";
        const newParent = newPath.split("/").slice(0, -1).join("/") || "/";
        const oldParentStat = await this.#system["party.openv.filesystem.read.stat"](oldParent);
        const newParentStat = await this.#system["party.openv.filesystem.read.stat"](newParent);
        requireAccess(oldParentStat, uid, gid, "write", oldParent);
        requireAccess(oldParentStat, uid, gid, "execute", oldParent);
        requireAccess(newParentStat, uid, gid, "write", newParent);
        requireAccess(newParentStat, uid, gid, "execute", newParent);
        return this.#system["party.openv.filesystem.write.rename"](oldPath, newPath);
    }

    async ["party.openv.filesystem.local.listfds"](): Promise<number[]> {
        return Array.from(this.#fdToOfd.keys());
    }

    async ["party.openv.filesystem.local.dupfd"](fd: number): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        const newFd = ++this.#fdCounter;
        this.#fdToOfd.set(newFd, ofd);
        return newFd;
    }

    async ["party.openv.filesystem.local.dup2"](fd: number, targetFd: number): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        if (this.#fdToOfd.has(targetFd) && targetFd !== fd) {
            const existingOfd = this.#fdToOfd.get(targetFd)!;
            this.#fdToOfd.delete(targetFd);
            await this.#system["party.openv.impl.filesystem.closeByOfd"](existingOfd);
        }
        this.#fdToOfd.set(targetFd, ofd);
        if (targetFd > this.#fdCounter) this.#fdCounter = targetFd;
        return targetFd;
    }

    async ["party.openv.filesystem.local.setfd"](targetFd: number, ofd: number): Promise<void> {
        if (!await this.#system["party.openv.impl.filesystem.hasOfd"](ofd)) {
            throw new Error(`Global open file number ${ofd} does not exist.`);
        }
        if (this.#fdToOfd.has(targetFd)) {
            const existingOfd = this.#fdToOfd.get(targetFd)!;
            this.#fdToOfd.delete(targetFd);
            await this.#system["party.openv.impl.filesystem.closeByOfd"](existingOfd);
        }
        this.#fdToOfd.set(targetFd, ofd);
        if (targetFd > this.#fdCounter) this.#fdCounter = targetFd;
    }

    async ["party.openv.filesystem.pipe.create"](bufferSize?: number): Promise<[readEnd: number, writeEnd: number]> {
        const [readOfd, writeOfd] = await this.#system["party.openv.impl.filesystem.createPipeOfd"](bufferSize);
        const readFd = ++this.#fdCounter;
        const writeFd = ++this.#fdCounter;
        this.#fdToOfd.set(readFd, readOfd);
        this.#fdToOfd.set(writeFd, writeOfd);
        return [readFd, writeFd];
    }

    async supports(ns: typeof FS_NAMESPACE | typeof FS_NAMESPACE_VERSIONED): Promise<typeof FS_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_READ_NAMESPACE | typeof FS_READ_NAMESPACE_VERSIONED): Promise<typeof FS_READ_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_WRITE_NAMESPACE | typeof FS_WRITE_NAMESPACE_VERSIONED): Promise<typeof FS_WRITE_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_LOCAL_NAMESPACE | typeof FS_LOCAL_NAMESPACE_VERSIONED): Promise<typeof FS_LOCAL_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_PIPE_NAMESPACE | typeof FS_PIPE_NAMESPACE_VERSIONED): Promise<typeof FS_PIPE_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        switch (ns) {
            case FS_NAMESPACE:
            case FS_NAMESPACE_VERSIONED: return FS_NAMESPACE_VERSIONED;
            case FS_READ_NAMESPACE:
            case FS_READ_NAMESPACE_VERSIONED: return FS_READ_NAMESPACE_VERSIONED;
            case FS_WRITE_NAMESPACE:
            case FS_WRITE_NAMESPACE_VERSIONED: return FS_WRITE_NAMESPACE_VERSIONED;
            case FS_LOCAL_NAMESPACE:
            case FS_LOCAL_NAMESPACE_VERSIONED: return FS_LOCAL_NAMESPACE_VERSIONED;
            case FS_PIPE_NAMESPACE:
            case FS_PIPE_NAMESPACE_VERSIONED: return FS_PIPE_NAMESPACE_VERSIONED;
        }
        return null;
    }
}