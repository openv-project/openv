import { FileMode, FileSystemCoreComponent, FileSystemEvent, FileSystemLocalComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, FS_LOCAL_NAMESPACE, FS_LOCAL_NAMESPACE_VERSIONED, FS_NAMESPACE, FS_NAMESPACE_VERSIONED, FS_READ_NAMESPACE, FS_READ_NAMESPACE_VERSIONED, FS_VIRTUAL_NAMESPACE, FS_VIRTUAL_NAMESPACE_VERSIONED, FS_WRITE_NAMESPACE, FS_WRITE_NAMESPACE_VERSIONED, FsStats, OpenFlags, SystemComponent } from "@openv-project/openv-api"

type VFS = {
    mount: (path: string) => Promise<void>;
    unmount: (path: string) => Promise<void>;
    open: (path: string, ofd: number, flags: OpenFlags, mode: FileMode) => Promise<void>;
    create: (path: string, mode?: FileMode) => Promise<void>;
    close: (ofd: number) => Promise<void>;
    read: (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<number>;
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
    ["party.openv.impl.filesystem.readByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number>;

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
}

export class CoreFS implements FileSystemVirtualComponent, FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, CoreFSExt {
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
        const entry = this.#ofdTable.get(ofd);
        if (!entry) {
            throw new Error(`Invalid open file number ${ofd}`);
        }
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

    async ["party.openv.filesystem.read.read"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number> {
        const entry = this.#ofdTable.get(ofd);
        if (!entry) {
            throw new Error(`Invalid open file number ${ofd}`);
        }
        if (!entry.provider || typeof entry.provider.read !== "function") {
            throw new Error(`Open file number ${ofd} is not backed by a provider that supports read.`);
        }
        return entry.provider.read(ofd, buffer, offset, length, position);
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
        provider?: Partial<VFS>;
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
    #vfsTable: Map<string, Partial<VFS>> = new Map();

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

    async ["party.openv.filesystem.virtual.onread"](id: string, handler: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<number>): Promise<void> {
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

    // --- CoreFSExt implementations ---

    async ["party.openv.impl.filesystem.readByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number> {
        return this["party.openv.filesystem.read.read"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.impl.filesystem.writeByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        return this["party.openv.filesystem.write.write"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.impl.filesystem.closeByOfd"](ofd: number): Promise<void> {
        return this["party.openv.filesystem.close"](ofd);
    }

    async ["party.openv.impl.filesystem.hasOfd"](ofd: number): Promise<boolean> {
        return this.#ofdTable.has(ofd);
    }

    supports(ns: typeof CORE_FS_EXT_NAMESPACE_VERSIONED | typeof CORE_FS_EXT_NAMESPACE): Promise<typeof CORE_FS_EXT_NAMESPACE_VERSIONED>;
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
     * Retrieves the VFS entry for the given id, throwing if it doesn't exist.
     */
    #getVfs(id: string): Partial<VFS> {
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

/**
 * Process-scoped filesystem component. Wraps a CoreFS and maintains a per-process
 * file descriptor table
 */
export class ProcessScopedFS implements FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemLocalComponent {
    #fs: FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & CoreFSExt;

    #fdCounter = 0;
    #fdToOfd: Map<number, number> = new Map();

    constructor(fs: FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & CoreFSExt) {
        this.#fs = fs;
    }

    #resolveOfd(fd: number): number {
        const ofd = this.#fdToOfd.get(fd);
        if (ofd === undefined) {
            throw new Error(`Invalid file descriptor ${fd}`);
        }
        return ofd;
    }

    async ["party.openv.filesystem.open"](path: string, flags: OpenFlags, mode?: FileMode): Promise<number> {
        // Open on the core FS to get a global ofd
        const ofd = await this.#fs["party.openv.filesystem.open"](path, flags, mode);
        // Allocate a process-local fd
        const fd = ++this.#fdCounter;
        this.#fdToOfd.set(fd, ofd);
        return fd;
    }

    async ["party.openv.filesystem.close"](fd: number): Promise<void> {
        const ofd = this.#resolveOfd(fd);
        this.#fdToOfd.delete(fd);
        await this.#fs["party.openv.impl.filesystem.closeByOfd"](ofd);
    }

    async ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats> {
        return this.#fs["party.openv.filesystem.read.stat"](path);
    }

    async ["party.openv.filesystem.read.read"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        return this.#fs["party.openv.impl.filesystem.readByOfd"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.filesystem.read.readdir"](path: string): Promise<string[]> {
        return this.#fs["party.openv.filesystem.read.readdir"](path);
    }

    async ["party.openv.filesystem.read.watch"](path: string, options?: { recursive?: boolean }): Promise<{
        events: AsyncIterable<FileSystemEvent>;
        abort: () => Promise<void>;
    }> {
        return this.#fs["party.openv.filesystem.read.watch"](path, options);
    }

    async ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        return this.#fs["party.openv.impl.filesystem.writeByOfd"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void> {
        return this.#fs["party.openv.filesystem.write.create"](path, mode);
    }

    async ["party.openv.filesystem.write.mkdir"](path: string, mode?: FileMode): Promise<void> {
        return this.#fs["party.openv.filesystem.write.mkdir"](path, mode);
    }

    async ["party.openv.filesystem.write.rmdir"](path: string): Promise<void> {
        return this.#fs["party.openv.filesystem.write.rmdir"](path);
    }

    async ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void> {
        return this.#fs["party.openv.filesystem.write.rename"](oldPath, newPath);
    }

    async ["party.openv.filesystem.write.unlink"](path: string): Promise<void> {
        return this.#fs["party.openv.filesystem.write.unlink"](path);
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

    async supports(ns: typeof FS_NAMESPACE | typeof FS_NAMESPACE_VERSIONED): Promise<typeof FS_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_READ_NAMESPACE | typeof FS_READ_NAMESPACE_VERSIONED): Promise<typeof FS_READ_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_WRITE_NAMESPACE | typeof FS_WRITE_NAMESPACE_VERSIONED): Promise<typeof FS_WRITE_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_LOCAL_NAMESPACE | typeof FS_LOCAL_NAMESPACE_VERSIONED): Promise<typeof FS_LOCAL_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        switch (ns) {
            case FS_NAMESPACE:
            case FS_NAMESPACE_VERSIONED:
                return FS_NAMESPACE_VERSIONED;
            case FS_READ_NAMESPACE:
            case FS_READ_NAMESPACE_VERSIONED:
                return FS_READ_NAMESPACE_VERSIONED;
            case FS_WRITE_NAMESPACE:
            case FS_WRITE_NAMESPACE_VERSIONED:
                return FS_WRITE_NAMESPACE_VERSIONED;
            case FS_LOCAL_NAMESPACE:
            case FS_LOCAL_NAMESPACE_VERSIONED:
                return FS_LOCAL_NAMESPACE_VERSIONED;
        }
        return null;
    }
}