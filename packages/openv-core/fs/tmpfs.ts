import type { FileMode, FileSystemVirtualComponent, FsStats, OpenFlags } from "@openv-project/openv-api"

export const TMPFS_NAMESPACE = "party.openv.impl.tmpfs" as const;

function normalizePath(path: string): string {
    if (!path.startsWith("/") || path.includes("\0")) {
        throw new Error(`invalid path '${path}'`);
    }
    const stack: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    return "/" + stack.join("/");
}

export class TmpFs {
    #nodecounter = 0;
    #data = new Map<number, Uint8Array | string[]>();
    #symlinks = new Map<number, string>();
    #stats = new Map<number, FsStats<typeof TMPFS_NAMESPACE>>();
    /**
     * This is a temporary in-memory filesystem implementation.
     * the paths map stores a mapping of `${mountpoint}\0${fullpath}` to node IDs.
     * 
     * This ensures mounting tmpfs at overlapping paths does not cause conflicts.
     */
    #paths = new Map<string, number>();
    #roots = new Set<string>();

    #makeFileBuffer(size: number): Uint8Array {
        return new Uint8Array(new SharedArrayBuffer(size));
    }

    // Register our vfs implementation with the system.
    async register(system: FileSystemVirtualComponent) {
        system["party.openv.filesystem.virtual.create"](TMPFS_NAMESPACE);
        system["party.openv.filesystem.virtual.onstat"](TMPFS_NAMESPACE,
            async (path: string) => await this.stat(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onlstat"]?.(TMPFS_NAMESPACE,
            async (path: string) => await this.lstat(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onreadlink"]?.(TMPFS_NAMESPACE,
            async (path: string) => await this.readlink(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onreaddir"](TMPFS_NAMESPACE,
            async (path: string) => await this.readdir(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onmkdir"](TMPFS_NAMESPACE,
            async (path: string, mode?: FileMode) => await this.mkdir(normalizePath(path), mode)
        );
        system["party.openv.filesystem.virtual.onrmdir"](TMPFS_NAMESPACE,
            async (path: string) => await this.rmdir(normalizePath(path))
        );
        // we dont care about any extra params
        system["party.openv.filesystem.virtual.onmount"](TMPFS_NAMESPACE,
            async (path: string) => await this.mount(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onunmount"](TMPFS_NAMESPACE,
            async (path: string) => await this.unmount(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onopen"](TMPFS_NAMESPACE,
            async (path: string, fd: number, flags: OpenFlags, mode: FileMode) => await this.open(normalizePath(path), fd, flags, mode)
        );
        system["party.openv.filesystem.virtual.onclose"](TMPFS_NAMESPACE,
            async (fd: number) => await this.close(fd)
        );
        system["party.openv.filesystem.virtual.onread"](TMPFS_NAMESPACE,
            async (fd: number, length: number, position?: number) => await this.read(fd, length, position)
        );
        system["party.openv.filesystem.virtual.onwrite"](TMPFS_NAMESPACE,
            async (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => await this.write(fd, buffer, offset, length, position)
        );
        system["party.openv.filesystem.virtual.oncreate"](TMPFS_NAMESPACE,
            async (path: string, mode?: FileMode) => await this.create(normalizePath(path), mode)
        );
        system["party.openv.filesystem.virtual.onunlink"](TMPFS_NAMESPACE,
            async (path: string) => await this.unlink(normalizePath(path))
        );
        system["party.openv.filesystem.virtual.onsymlink"]?.(TMPFS_NAMESPACE,
            async (target: string, path: string, mode?: FileMode) => await this.symlink(target, normalizePath(path), mode)
        );
        system["party.openv.filesystem.virtual.onchmod"]?.(TMPFS_NAMESPACE,
            async (path: string, mode: FileMode) => await this.chmod(normalizePath(path), mode)
        );
        system["party.openv.filesystem.virtual.onchown"]?.(TMPFS_NAMESPACE,
            async (path: string, uid: number, gid: number) => await this.chown(normalizePath(path), uid, gid)
        );
        system["party.openv.filesystem.virtual.onrename"](TMPFS_NAMESPACE,
            async (oldPath: string, newPath: string) => await this.rename(normalizePath(oldPath), normalizePath(newPath))
        );
    }

    closestMountpoint(path: string): string | null {
        let closest: string | null = null;
        for (const root of this.#roots) {
            if (path.startsWith(root)) {
                if (closest === null || root.length > closest.length) {
                    closest = root;
                }
            }
        }
        return closest;
    }

    async stat(path: string): Promise<FsStats<typeof TMPFS_NAMESPACE>> {
        return this.#getStats(path, "stat");
    }

    async lstat(path: string): Promise<FsStats<typeof TMPFS_NAMESPACE>> {
        return this.#getStats(path, "lstat");
    }

    #getStats(path: string, op: "stat" | "lstat"): FsStats<typeof TMPFS_NAMESPACE> {
        const node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
        }
        return this.#stats.get(node)!;
    }

    async readlink(path: string): Promise<string> {
        const node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
        }
        const stats = this.#stats.get(node);
        if (!stats || stats.type !== "SYMLINK") {
            throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
        }
        const target = this.#symlinks.get(node);
        if (!target) {
            throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
        }
        return target;
    }

    async readdir(path: string): Promise<string[]> {
        const node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
        }

        const data = this.#data.get(node);
        if (!Array.isArray(data)) {
            throw new Error(`ENOTDIR: not a directory, readdir '${path}'`);
        }

        return data;
    }

    async mkdir(path: string, mode?: FileMode): Promise<void> {
        const mount = this.closestMountpoint(path);
        if (this.#paths.has(`${mount}\0${path}`)) {
            throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        }
        mode = mode ?? 0o777;
        // Update parent directory's mtime
        const parentPath = path.split("/").slice(0, -1).join("/") || "/";
        const parentNode = this.#paths.get(`${mount}\0${parentPath}`);

        if (parentNode === undefined) {
            throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }

        const parentStats = this.#stats.get(parentNode)!;
        if (parentStats.type !== "DIRECTORY") {
            throw new Error(`parent path '${parentPath}' is not a directory.`);
        }

        parentStats.mtime = Date.now();

        const parentData = this.#data.get(parentNode);
        if (Array.isArray(parentData)) {
            parentData.push(path.split("/").pop()!);
        }


        const node = this.#nodecounter++;
        this.#paths.set(`${mount}\0${path}`, node);
        this.#data.set(node, []);
        this.#stats.set(node, {
            type: "DIRECTORY",
            size: 0,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            name: path.split("/").pop()!,
            uid: 0, // ownership not implemented, so null
            gid: 0,
            mode,
            node: "party.openv.impl.tmpfs"
        });
    }

    async rmdir(path: string): Promise<void> {
        const mount = this.closestMountpoint(path);
        const node = this.#paths.get(`${mount}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
        }

        const stats = this.#stats.get(node);

        let data: Uint8Array | string[] | undefined;
        if (stats == undefined || stats.type !== "DIRECTORY" || (data = this.#data.get(node), !Array.isArray(data))) {
            throw new Error(`ENOTDIR: not a directory, rmdir '${path}'`);
        }
        if (data.length > 0) {
            throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }

        // get parent directory and update its mtime
        const parentPath = path.split("/").slice(0, -1).join("/") || "/";
        const parentNode = this.#paths.get(`${mount}\0${parentPath}`);
        if (parentNode !== undefined) {
            const parentStats = this.#stats.get(parentNode)!;
            parentStats.mtime = Date.now();

            const parentData = this.#data.get(parentNode);
            if (Array.isArray(parentData)) {
                const name = path.split("/").pop()!;
                const index = parentData.indexOf(name);
                if (index !== -1) {
                    parentData.splice(index, 1);
                }
            }
        }

        this.#paths.delete(`${mount}\0${path}`);
        this.#data.delete(node);
        this.#stats.delete(node);
    }

    async mount(path: string): Promise<void> {
        const node = this.#nodecounter++;
        this.#paths.set(`${path}\0${path}`, node);
        this.#roots.add(path);
        this.#data.set(node, []);
        this.#stats.set(node, {
            type: "DIRECTORY",
            size: 0,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            name: path.split("/").pop()!,
            uid: 0, // ownership not implemented, so null
            gid: 0,
            mode: 0o777,
            node: "party.openv.impl.tmpfs"
        });
    }

    async unmount(path: string): Promise<void> {
        const nodesToDelete: number[] = [];

        for (const [p, node] of this.#paths) {
            if (p === path || p.startsWith(path)) {
                nodesToDelete.push(node);
                this.#paths.delete(p);
            }
        }

        for (const node of nodesToDelete) {
            this.#data.delete(node);
            this.#symlinks.delete(node);
            this.#stats.delete(node);
        }
    }

    async create(path: string, mode?: FileMode): Promise<void> {
        const mount = this.closestMountpoint(path);
        if (this.#paths.has(`${mount}\0${path}`)) {
            throw new Error(`EEXIST: file already exists, create '${path}'`);
        }
        mode = mode ?? 0o666;
        // Update parent directory's mtime
        const parentPath = path.split("/").slice(0, -1).join("/") || "/";
        const parentNode = this.#paths.get(`${mount}\0${parentPath}`);
        if (parentNode !== undefined) {
            const parentStats = this.#stats.get(parentNode)!;
            if (parentStats.type !== "DIRECTORY") {
                throw new Error(`parent path '${parentPath}' is not a directory.`);
            }
            parentStats.mtime = Date.now();

            const parentData = this.#data.get(parentNode);
            if (Array.isArray(parentData)) {
                parentData.push(path.split("/").pop()!);
            }
        }

        const node = this.#nodecounter++;
        this.#paths.set(`${mount}\0${path}`, node);
        this.#data.set(node, this.#makeFileBuffer(0));
        this.#stats.set(node, {
            type: "FILE",
            size: 0,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            name: path.split("/").pop()!,
            uid: 0, // ownership not implemented, so null
            gid: 0,
            mode: mode ?? 0o666,
            node: "party.openv.impl.tmpfs"
        });
    }

    async symlink(target: string, path: string, mode?: FileMode): Promise<void> {
        const mount = this.closestMountpoint(path);
        if (this.#paths.has(`${mount}\0${path}`)) {
            throw new Error(`EEXIST: file already exists, symlink '${path}'`);
        }
        const parentPath = path.split("/").slice(0, -1).join("/") || "/";
        const parentNode = this.#paths.get(`${mount}\0${parentPath}`);
        if (parentNode === undefined) {
            throw new Error(`ENOENT: no such file or directory, symlink '${path}'`);
        }
        const parentStats = this.#stats.get(parentNode)!;
        if (parentStats.type !== "DIRECTORY") {
            throw new Error(`parent path '${parentPath}' is not a directory.`);
        }
        parentStats.mtime = Date.now();
        const parentData = this.#data.get(parentNode);
        if (Array.isArray(parentData)) {
            parentData.push(path.split("/").pop()!);
        }

        const node = this.#nodecounter++;
        this.#paths.set(`${mount}\0${path}`, node);
        this.#symlinks.set(node, target);
        this.#stats.set(node, {
            type: "SYMLINK",
            size: target.length,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            name: path.split("/").pop()!,
            uid: 0,
            gid: 0,
            mode: (mode ?? 0o777) | 0o120000,
            node: "party.openv.impl.tmpfs"
        });
    }

    async chmod(path: string, mode: FileMode): Promise<void> {
        const node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
        }
        const stats = this.#stats.get(node)!;
        const fileTypeBits = stats.mode & 0o170000;
        stats.mode = fileTypeBits | (mode & 0o777);
        stats.ctime = Date.now();
        stats.mtime = stats.ctime;
    }

    async chown(path: string, uid: number, gid: number): Promise<void> {
        const node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, chown '${path}'`);
        }
        const stats = this.#stats.get(node)!;
        stats.uid = uid;
        stats.gid = gid;
        stats.ctime = Date.now();
        stats.mtime = stats.ctime;
    }

    // file descriptors: numbers are allocated by the core filesystem, but using
    // onopen and onclose we store associate our open files with the file descriptors.
    #openFiles: Map<number, {
        node: number;
        flags: OpenFlags;
        position: number;
    }> = new Map();

    async open(path: string, fd: number, flags: OpenFlags, mode: FileMode): Promise<void> {
        let node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`);
        if (node === undefined) {
            if (flags.includes("x") || flags.includes("w") || flags.includes("a") || flags.includes("+")) {
                await this.create(path, mode);
                node = this.#paths.get(`${this.closestMountpoint(path)}\0${path}`)!;
            } else {
                throw new Error(`ENOENT: no such file or directory, open '${path}'`);
            }
        }

        const stats = this.#stats.get(node)!;
        if (stats.type !== "FILE") {
            throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
        }
        this.#openFiles.set(fd, { node, flags, position: 0 });
        this.#stats.get(node)!.atime = Date.now();
    }

    async close(fd: number): Promise<void> {
        const file = this.#openFiles.get(fd);
        if (!file) {
            throw new Error(`EBADF: bad file descriptor, close '${fd}'`);
        }

        this.#openFiles.delete(fd);
        this.#stats.get(file.node)!.atime = Date.now();
    }

    async read(fd: number, length: number, position?: number): Promise<Uint8Array> {
        const file = this.#openFiles.get(fd);
        if (!file) {
            throw new Error(`EBADF: bad file descriptor, read '${fd}'`);
        }

        if (!file.flags.includes("r") && !file.flags.includes("+")) {
            throw new Error(`EBADF: file not open for reading, read '${fd}'`);
        }

        const data = this.#data.get(file.node);
        if (!data || Array.isArray(data)) {
            throw new Error(`EISDIR: illegal operation on a directory, read '${fd}'`);
        }

        const pos = position ?? file.position;
        const bytesToRead = Math.min(length, data.length - pos);
        const canWrite = file.flags.includes("w") || file.flags.includes("+") || file.flags.includes("a");
        const readView = data.subarray(pos, pos + bytesToRead);
        const result = canWrite
            ? readView
            : new Uint8Array(readView);

        if (position === undefined) {
            file.position += bytesToRead;
        }

        this.#stats.get(file.node)!.atime = Date.now();
        return result;
    }

    async write(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const file = this.#openFiles.get(fd);
        if (!file) {
            throw new Error(`EBADF: bad file descriptor, write '${fd}'`);
        }
        if (!file.flags.includes("w") && !file.flags.includes("+") && !file.flags.includes("a")) {
            throw new Error(`EBADF: file not open for writing, write '${fd}'`);
        }

        let data = this.#data.get(file.node);
        if (!data || Array.isArray(data)) {
            throw new Error(`EISDIR: illegal operation on a directory, write '${fd}'`);
        }

        // determine write position: null means append, or 'a' flag forces append
        let pos: number;
        if (position === null || file.flags.includes("a")) {
            pos = data.length;
        } else {
            pos = position ?? file.position;
        }

        // compute source slice from buffer
        const avail = length ?? buffer.length;
        const src = buffer.subarray(offset ?? 0, (offset ?? 0) + avail);
        const bytesToWrite = src.length;

        // ensure backing buffer is large enough
        const needed = pos + bytesToWrite;
        if (needed > data.length) {
            const newData = this.#makeFileBuffer(needed);
            newData.set(data, 0);
            this.#data.set(file.node, newData);
            data = newData;
        }

        data.set(src, pos);

        // update position (keeps previous behavior of advancing the descriptor position)
        file.position = pos + bytesToWrite;

        const stats = this.#stats.get(file.node)!;
        stats.mtime = Date.now();
        stats.size = Math.max(stats.size, data.length);

        return bytesToWrite;
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const oldMount = this.closestMountpoint(oldPath);
        const newMount = this.closestMountpoint(newPath);
        const oldNode = this.#paths.get(`${oldMount}\0${oldPath}`);
        const newNode = this.#paths.get(`${newMount}\0${newPath}`);

        if (!oldNode) {
            throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
        }

        if (newNode) {
            throw new Error(`EEXIST: file already exists, rename '${newPath}'`);
        }

        this.#paths.delete(`${oldMount}\0${oldPath}`);
        this.#paths.set(`${newMount}\0${newPath}`, oldNode);
    }

    async unlink(path: string): Promise<void> {
        const mount = this.closestMountpoint(path);
        const node = this.#paths.get(`${mount}\0${path}`);
        if (node === undefined) {
            throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
        }

        const stats = this.#stats.get(node);
        if (stats == undefined || stats.type === "DIRECTORY") {
            throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
        }

        // get parent directory and update its mtime
        const parentPath = path.split("/").slice(0, -1).join("/") || "/";
        const parentNode = this.#paths.get(`${mount}\0${parentPath}`);
        if (parentNode !== undefined) {
            const parentStats = this.#stats.get(parentNode)!;
            parentStats.mtime = Date.now();

            const parentData = this.#data.get(parentNode);
            if (Array.isArray(parentData)) {
                const name = path.split("/").pop()!;
                const index = parentData.indexOf(name);
                if (index !== -1) {
                    parentData.splice(index, 1);
                }
            }
        }

        this.#paths.delete(`${mount}\0${path}`);
        this.#data.delete(node);
        this.#symlinks.delete(node);
        this.#stats.delete(node);
    }
}
