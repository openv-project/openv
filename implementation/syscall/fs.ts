import type { FileMode, FileSystemCoreComponent, FileSystemEvent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, FsStats, OpenFlags } from "../../openv/syscall/fs.ts";

type VFS = {
    mount: (path: string) => Promise<void>;
    unmount: (path: string) => Promise<void>;
    open: (path: string, fd: number, flags: OpenFlags, mode: FileMode) => Promise<void>;
    create: (path: string, mode?: FileMode) => Promise<void>;
    close: (fd: number) => Promise<void>;
    read: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<number>;
    write: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>;
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

export class CoreFS implements FileSystemVirtualComponent, FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent {
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
    async ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const entry = this.#fdTable.get(fd);
        if (!entry) {
            throw new Error(`Invalid file descriptor ${fd}`);
        }
        if (!entry.provider || typeof entry.provider.write !== "function") {
            throw new Error(`File descriptor ${fd} is not backed by a provider that supports write.`);
        }
        return entry.provider.write(fd, buffer, offset, length, position);
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
            // If the provider was removed, just remove the mountpoint.
            this.#mountTable.delete(normalized);
            return;
        }

        // Call provider.unmount if implemented.
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

        // Record the mountpoint prior to calling provider.mount so other calls can see it
        this.#mountTable.set(normalized, id);

        // Call provider.mount if implemented. If it throws, undo the mount registration.
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

    async ["party.openv.filesystem.read.read"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number> {
        const entry = this.#fdTable.get(fd);
        if (!entry) {
            throw new Error(`Invalid file descriptor ${fd}`);
        }
        if (!entry.provider || typeof entry.provider.read !== "function") {
            throw new Error(`File descriptor ${fd} is not backed by a provider that supports read.`);
        }
        // Use providerFd when available, otherwise fall back to the opaque fd.
        return entry.provider.read(fd, buffer, offset, length, position);
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
    // Simple file descriptor allocator and table. We assign opaque fds to callers and map them
    // to provider-local fds when a virtual filesystem provider is used.
    #fdCounter = 100;
    #fdTable: Map<number, {
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
        const fd = ++this.#fdCounter;
        await providerOpen(subpath, fd, flags, mode);
        this.#fdTable.set(fd, {
            path,
            providerId: id,
            provider,
            flags,
            mode,
        });
        return fd;
    }

    async ["party.openv.filesystem.close"](fd: number): Promise<void> {
        const entry = this.#fdTable.get(fd);
        if (!entry) {
            // POSIX semantics: closing an invalid fd is an error. Mirror that with an exception.
            throw new Error(`Invalid file descriptor ${fd}`);
        }

        this.#fdTable.delete(fd);

        // If this fd was backed by a provider and the provider implements close, forward.
        if (entry.provider && typeof entry.provider.close === "function") {
            // providerFd may be undefined for providers that don't use it; guard anyway.
            await entry.provider.close(fd);
            return;
        }

        // Nothing to do for non-provider-backed fds.
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

    supports(ns: "party.openv.filesystem.virtual" | "party.openv.filesystem.virtual/0.1.0"): Promise<"party.openv.filesystem.virtual/0.1.0">;
    supports(ns: "party.openv.filesystem.read" | "party.openv.filesystem.read/0.1.0"): Promise<"party.openv.filesystem.read/0.1.0">;
    supports(ns: "party.openv.filesystem.write" | "party.openv.filesystem.write/0.1.0"): Promise<"party.openv.filesystem.write/0.1.0">;
    supports(ns: "party.openv.filesystem" | "party.openv.filesystem/0.1.0"): Promise<"party.openv.filesystem/0.1.0">;
    async supports(ns: string): Promise<string | null> {
        if (
            ns === "party.openv.filesystem.virtual" ||
            ns === "party.openv.filesystem.virtual/0.1.0"
        ) {
            return "party.openv.filesystem.virtual/0.1.0";
        }
        if (
            ns === "party.openv.filesystem.read" ||
            ns === "party.openv.filesystem.read/0.1.0"
        ) {
            return "party.openv.filesystem.read/0.1.0";
        }
        if (
            ns === "party.openv.filesystem.write" ||
            ns === "party.openv.filesystem.write/0.1.0"
        ) {
            return "party.openv.filesystem.write/0.1.0";
        }
        if (
            ns === "party.openv.filesystem" ||
            ns === "party.openv.filesystem/0.1.0"
        ) {
            return "party.openv.filesystem/0.1.0";
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