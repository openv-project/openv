import { FileMode, FileSystemCoreComponent, FileSystemEvent, FileSystemLocalComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemSocketComponent, FileSystemSocketType, FileSystemSyncComponent, FileSystemVirtualComponent, FS_LOCAL_NAMESPACE, FS_LOCAL_NAMESPACE_VERSIONED, FS_NAMESPACE, FS_NAMESPACE_VERSIONED, FS_PIPE_NAMESPACE, FS_PIPE_NAMESPACE_VERSIONED, FS_READ_NAMESPACE, FS_READ_NAMESPACE_VERSIONED, FS_SOCKET_NAMESPACE, FS_SOCKET_NAMESPACE_VERSIONED, FS_SYNC_NAMESPACE, FS_SYNC_NAMESPACE_VERSIONED, FS_VIRTUAL_NAMESPACE, FS_VIRTUAL_NAMESPACE_VERSIONED, FS_WRITE_NAMESPACE, FS_WRITE_NAMESPACE_VERSIONED, FsStats, OpenFlags, PlainParameter, ProcessComponent, SocketAddress, SystemComponent } from "@openv-project/openv-api"
import { CoreProcessExt } from "./mod";

type VFS = {
    mount: (path: string, extra?: PlainParameter) => Promise<void>;
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
    sync: (ofd: number) => Promise<void>;
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

export class CoreFS implements FileSystemVirtualComponent, FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemPipeComponent, FileSystemSocketComponent, FileSystemSyncComponent, CoreFSExt {
    async ["party.openv.filesystem.sync.sync"](ofd: number): Promise<void> {
        const entry = this.#ofdTable.get(ofd);
        if (!entry) {
            throw new Error(`Invalid open file number ${ofd}`);
        }
        if (entry.provider && typeof entry.provider.sync === "function") {
            await entry.provider.sync(ofd);
        }
    }
    async ["party.openv.filesystem.virtual.onsync"](id: string, handler: (ofd: number) => Promise<void>): Promise<void> {
        const vfs = this.#getVfs(id);
        vfs.sync = handler;
    }

    async ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void> {
        const normalized = this.#normalizePath(path);
        if (this.#fifoByPath.has(normalized) || this.#socketPathToId.has(normalized)) {
            throw new Error(`EEXIST: file already exists, create '${normalized}'`);
        }
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}".`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.create) {
            throw new Error(`Virtual filesystem "${id}" does not implement create.`);
        }
        return provider.create(path, mode);
    }

    async ["party.openv.filesystem.write.mkfifo"](path: string, mode: FileMode = 0o666): Promise<void> {
        const normalized = this.#normalizePath(path);
        if (this.#fifoByPath.has(normalized)) {
            throw new Error(`EEXIST: file already exists, mkfifo '${normalized}'`);
        }
        if (await this.#pathExists(normalized)) {
            throw new Error(`EEXIST: file already exists, mkfifo '${normalized}'`);
        }

        const fifoId = ++this.#fifoIdCounter;
        const pipeId = ++this.#pipeIdCounter;
        this.#pipeTable.set(pipeId, {
            buffer: new Uint8Array(CoreFS.DEFAULT_PIPE_BUFFER_SIZE),
            head: 0,
            tail: 0,
            readClosed: false,
            writeClosed: false,
            pendingReaders: [],
            pendingWriters: [],
        });

        const now = Date.now();
        this.#fifoTable.set(fifoId, {
            id: fifoId,
            path: normalized,
            pipeId,
            mode: S_IFIFO | (mode & 0o777),
            uid: 0,
            gid: 0,
            ctime: now,
            mtime: now,
            atime: now,
            openReaders: 0,
            openWriters: 0,
            pendingOpenReaders: [],
            pendingOpenWriters: [],
        });
        this.#fifoByPath.set(normalized, fifoId);
    }

    async ["party.openv.filesystem.socket.create"](type: FileSystemSocketType): Promise<number> {
        if (type !== "stream" && type !== "dgram") {
            throw new Error(`ENOTSUP: socket type '${type}' is not implemented yet.`);
        }

        const socketId = ++this.#socketIdCounter;
        const ofd = ++this.#ofdCounter;
        const now = Date.now();

        this.#socketTable.set(socketId, {
            id: socketId,
            type,
            boundPath: null,
            mode: S_IFSOCK | 0o777,
            uid: 0,
            gid: 0,
            ctime: now,
            mtime: now,
            atime: now,
            listening: false,
            backlog: 16,
            pendingAcceptedOfds: [],
            pendingAcceptWaiters: [],
            openOfds: new Set([ofd]),
            pendingDatagrams: [],
            pendingDatagramReaders: [],
            pendingDatagramWriters: [],
            datagramQueueLimit: CoreFS.DEFAULT_DGRAM_QUEUE_LIMIT,
        });

        this.#ofdTable.set(ofd, {
            path: `<socket:${socketId}>`,
            flags: "r+",
            mode: S_IFSOCK | 0o777,
        });

        this.#ofdToSocket.set(ofd, { socketId });
        return ofd;
    }

    async ["party.openv.filesystem.socket.bind"](ofd: number, address: SocketAddress): Promise<void> {
        const meta = this.#requireSocketOfd(ofd);
        const socket = this.#requireSocket(meta.socketId);
        if (meta.readPipeId !== undefined || meta.writePipeId !== undefined) {
            throw new Error(`EINVAL: connected socket cannot be rebound.`);
        }
        if (socket.boundPath) {
            throw new Error(`EINVAL: socket is already bound to '${socket.boundPath}'.`);
        }

        const normalized = this.#normalizePath(address.path);
        if (this.#fifoByPath.has(normalized) || this.#socketPathToId.has(normalized) || await this.#pathExists(normalized)) {
            throw new Error(`EADDRINUSE: address already in use '${normalized}'`);
        }

        socket.boundPath = normalized;
        socket.mtime = Date.now();
        this.#socketPathToId.set(normalized, socket.id);
        const entry = this.#ofdTable.get(ofd);
        if (entry) entry.path = normalized;
    }

    async ["party.openv.filesystem.socket.listen"](ofd: number, backlog: number = 16): Promise<void> {
        const meta = this.#requireSocketOfd(ofd);
        const socket = this.#requireSocket(meta.socketId);
        if (socket.type !== "stream") throw new Error(`ENOTSUP: only stream sockets are supported in phase 2.`);
        if (!socket.boundPath) throw new Error(`EINVAL: socket must be bound before listen.`);
        if (meta.readPipeId !== undefined || meta.writePipeId !== undefined) {
            throw new Error(`EINVAL: connected socket cannot listen.`);
        }

        socket.listening = true;
        socket.backlog = Math.max(1, backlog | 0);
        socket.mtime = Date.now();
    }

    async ["party.openv.filesystem.socket.connect"](ofd: number, address: SocketAddress): Promise<void> {
        const clientMeta = this.#requireSocketOfd(ofd);
        const clientSocket = this.#requireSocket(clientMeta.socketId);
        if (clientSocket.type !== "stream") throw new Error(`ENOTSUP: only stream sockets are supported in phase 2.`);
        if (clientMeta.readPipeId !== undefined || clientMeta.writePipeId !== undefined) {
            throw new Error(`EISCONN: socket is already connected.`);
        }

        const normalized = this.#normalizePath(address.path);
        const serverSocketId = this.#socketPathToId.get(normalized);
        if (serverSocketId === undefined) {
            throw new Error(`ECONNREFUSED: no listening socket at '${normalized}'`);
        }

        const serverSocket = this.#requireSocket(serverSocketId);
        if (!serverSocket.listening) {
            throw new Error(`ECONNREFUSED: socket at '${normalized}' is not listening`);
        }

        while (serverSocket.pendingAcceptedOfds.length >= serverSocket.backlog) {
            await new Promise<void>((resolve) => serverSocket.pendingAcceptWaiters.push(resolve));
            if (!this.#socketTable.has(serverSocketId)) {
                throw new Error(`ECONNREFUSED: listening socket disappeared.`);
            }
        }

        const c2s = this.#createPipeState();
        const s2c = this.#createPipeState();

        clientMeta.readPipeId = s2c;
        clientMeta.writePipeId = c2s;
        clientSocket.atime = Date.now();
        clientSocket.mtime = Date.now();

        const acceptedOfd = ++this.#ofdCounter;
        this.#ofdTable.set(acceptedOfd, {
            path: `<socket:${serverSocketId}:accepted>`,
            flags: "r+",
            mode: S_IFSOCK | 0o777,
        });
        this.#ofdToSocket.set(acceptedOfd, {
            socketId: serverSocketId,
            readPipeId: c2s,
            writePipeId: s2c,
        });
        serverSocket.openOfds.add(acceptedOfd);
        serverSocket.pendingAcceptedOfds.push(acceptedOfd);
        serverSocket.mtime = Date.now();

        for (const resolve of serverSocket.pendingAcceptWaiters.splice(0)) resolve();
    }

    async ["party.openv.filesystem.socket.accept"](ofd: number): Promise<number> {
        const meta = this.#requireSocketOfd(ofd);
        const socket = this.#requireSocket(meta.socketId);
        if (!socket.listening) throw new Error(`EINVAL: socket is not listening.`);

        while (socket.pendingAcceptedOfds.length === 0) {
            await new Promise<void>((resolve) => socket.pendingAcceptWaiters.push(resolve));
            if (!this.#socketTable.has(socket.id)) {
                throw new Error(`ECONNABORTED: listening socket closed.`);
            }
        }

        const accepted = socket.pendingAcceptedOfds.shift()!;
        return accepted;
    }

    async ["party.openv.filesystem.socket.sendto"](_ofd: number, _data: Uint8Array, _address: SocketAddress): Promise<number> {
        const meta = this.#requireSocketOfd(_ofd);
        const sender = this.#requireSocket(meta.socketId);
        if (sender.type !== "dgram") {
            throw new Error("ENOTSUP: sendto is only available for datagram sockets.");
        }

        const normalized = this.#normalizePath(_address.path);
        const targetId = this.#socketPathToId.get(normalized);
        if (targetId === undefined) {
            throw new Error(`ECONNREFUSED: no datagram socket at '${normalized}'`);
        }

        const target = this.#requireSocket(targetId);
        if (target.type !== "dgram") {
            throw new Error(`EPROTOTYPE: destination '${normalized}' is not a datagram socket.`);
        }

        while (target.pendingDatagrams.length >= target.datagramQueueLimit) {
            await new Promise<void>((resolve) => target.pendingDatagramWriters.push(resolve));
            if (!this.#socketTable.has(target.id)) {
                throw new Error("ECONNREFUSED: destination socket closed while waiting for queue space.");
            }
        }

        target.pendingDatagrams.push({
            data: _data.slice(),
            address: sender.boundPath ? { path: sender.boundPath } : null,
        });
        target.mtime = Date.now();
        for (const resolve of target.pendingDatagramReaders.splice(0)) resolve();
        return _data.byteLength;
    }

    async ["party.openv.filesystem.socket.recvfrom"](_ofd: number, _maxLength: number): Promise<{ data: Uint8Array; address: SocketAddress | null }> {
        const meta = this.#requireSocketOfd(_ofd);
        const socket = this.#requireSocket(meta.socketId);
        if (socket.type !== "dgram") {
            throw new Error("ENOTSUP: recvfrom is only available for datagram sockets.");
        }

        while (socket.pendingDatagrams.length === 0) {
            await new Promise<void>((resolve) => socket.pendingDatagramReaders.push(resolve));
            if (!this.#socketTable.has(socket.id)) {
                throw new Error("ECONNABORTED: socket closed while waiting for datagram.");
            }
        }

        const packet = socket.pendingDatagrams.shift()!;
        socket.atime = Date.now();
        for (const resolve of socket.pendingDatagramWriters.splice(0)) resolve();
        const data = packet.data.byteLength > _maxLength
            ? packet.data.slice(0, _maxLength)
            : packet.data;
        return { data, address: packet.address };
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
        if (pipeInfo) {
            if (pipeInfo.kind === "anon") {
                if (pipeInfo.role !== "write") {
                    throw new Error(`OFD ${ofd} is not writable.`);
                }
                return this.#pipeWrite(pipeInfo.pipeId, buffer, offset, length);
            }
            if (!pipeInfo.canWrite) {
                throw new Error(`OFD ${ofd} is not writable.`);
            }
            return this.#fifoWrite(pipeInfo.fifoId, buffer, offset, length);
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            if (socketInfo.writePipeId === undefined) {
                throw new Error(`ENOTCONN: socket OFD ${ofd} is not connected for write.`);
            }
            return this.#pipeWrite(socketInfo.writePipeId, buffer, offset, length);
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

    async ["party.openv.filesystem.virtual.mount"](id: string, path: string, extra?: PlainParameter): Promise<void> {
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
                await provider.mount(normalized, extra);
            }
        } catch (err) {
            this.#mountTable.delete(normalized);
            throw err;
        }
    }

    async ["party.openv.filesystem.write.mkdir"](path: string, mode?: FileMode): Promise<void> {
        const normalized = this.#normalizePath(path);
        if (this.#fifoByPath.has(normalized) || this.#socketPathToId.has(normalized)) {
            throw new Error(`EEXIST: file already exists, mkdir '${normalized}'`);
        }
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.mkdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement mkdir.`);
        }
        return provider.mkdir(path, mode);
    }

    async ["party.openv.filesystem.write.rmdir"](path: string): Promise<void> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.rmdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement rmdir.`);
        }
        return provider.rmdir(path);
    }

    async ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void> {
        const oldNormalized = this.#normalizePath(oldPath);
        const newNormalized = this.#normalizePath(newPath);
        const fifoId = this.#fifoByPath.get(oldNormalized);
        if (fifoId !== undefined) {
            if (this.#fifoByPath.has(newNormalized) || await this.#pathExists(newNormalized)) {
                throw new Error(`EEXIST: file already exists, rename '${newNormalized}'`);
            }
            this.#fifoByPath.delete(oldNormalized);
            this.#fifoByPath.set(newNormalized, fifoId);
            const fifo = this.#fifoTable.get(fifoId)!;
            fifo.path = newNormalized;
            fifo.mtime = Date.now();
            return;
        }

        const socketId = this.#socketPathToId.get(oldNormalized);
        if (socketId !== undefined) {
            if (this.#fifoByPath.has(newNormalized) || this.#socketPathToId.has(newNormalized) || await this.#pathExists(newNormalized)) {
                throw new Error(`EEXIST: file already exists, rename '${newNormalized}'`);
            }
            this.#socketPathToId.delete(oldNormalized);
            this.#socketPathToId.set(newNormalized, socketId);
            const socket = this.#socketTable.get(socketId)!;
            socket.boundPath = newNormalized;
            socket.mtime = Date.now();
            return;
        }

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
        return provider.rename(oldPath, newPath);
    }

    async ["party.openv.filesystem.write.unlink"](path: string): Promise<void> {
        const normalized = this.#normalizePath(path);
        const fifoId = this.#fifoByPath.get(normalized);
        if (fifoId !== undefined) {
            this.#fifoByPath.delete(normalized);
            const fifo = this.#fifoTable.get(fifoId);
            if (!fifo) return;
            fifo.path = null;
            fifo.mtime = Date.now();
            this.#cleanupFifoIfUnlinkedAndClosed(fifoId);
            return;
        }

        const socketId = this.#socketPathToId.get(normalized);
        if (socketId !== undefined) {
            this.#socketPathToId.delete(normalized);
            const socket = this.#socketTable.get(socketId);
            if (!socket) return;
            socket.boundPath = null;
            socket.mtime = Date.now();
            this.#cleanupSocketIfOrphaned(socketId);
            return;
        }

        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.unlink) {
            throw new Error(`Virtual filesystem "${id}" does not implement unlink.`);
        }
        return provider.unlink(path);
    }

    async ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats> {
        const normalized = this.#normalizePath(path);
        const fifoId = this.#fifoByPath.get(normalized);
        if (fifoId !== undefined) {
            const fifo = this.#fifoTable.get(fifoId);
            if (!fifo) {
                throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
            }
            const pipe = this.#pipeTable.get(fifo.pipeId);
            const size = pipe ? Math.max(0, pipe.head - pipe.tail) : 0;
            return {
                type: "FILE",
                size,
                atime: fifo.atime,
                mtime: fifo.mtime,
                ctime: fifo.ctime,
                name: normalized.split("/").pop() || normalized,
                uid: fifo.uid,
                gid: fifo.gid,
                mode: fifo.mode,
                node: `party.openv.impl.corefs.fifo.${fifo.id}`,
            };
        }

        const socketId = this.#socketPathToId.get(normalized);
        if (socketId !== undefined) {
            const socket = this.#socketTable.get(socketId);
            if (!socket) {
                throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
            }
            return {
                type: "FILE",
                size: 0,
                atime: socket.atime,
                mtime: socket.mtime,
                ctime: socket.ctime,
                name: normalized.split("/").pop() || normalized,
                uid: socket.uid,
                gid: socket.gid,
                mode: socket.mode,
                node: `party.openv.impl.corefs.socket.${socket.id}`,
            };
        }

        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.stat) {
            throw new Error(`Virtual filesystem "${id}" does not implement stat.`);
        }
        return provider.stat(path);
    }

    async ["party.openv.filesystem.read.read"](ofd: number, length: number, position?: number): Promise<Uint8Array> {
        // Check pipe table first
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            if (pipeInfo.kind === "anon") {
                if (pipeInfo.role !== "read") {
                    throw new Error(`OFD ${ofd} is not readable.`);
                }
                return this.#pipeRead(pipeInfo.pipeId, length);
            }
            if (!pipeInfo.canRead) {
                throw new Error(`OFD ${ofd} is not readable.`);
            }
            return this.#fifoRead(pipeInfo.fifoId, length);
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            if (socketInfo.readPipeId === undefined) {
                throw new Error(`ENOTCONN: socket OFD ${ofd} is not connected for read.`);
            }
            return this.#pipeRead(socketInfo.readPipeId, length);
        }

        const entry = this.#ofdTable.get(ofd);
        if (!entry) throw new Error(`Invalid open file number ${ofd}`);
        if (!entry.provider || typeof entry.provider.read !== "function") {
            throw new Error(`Open file number ${ofd} is not backed by a provider that supports read.`);
        }
        return entry.provider.read(ofd, length, position);
    }


    async ["party.openv.filesystem.read.readdir"](path: string): Promise<string[]> {
        const normalized = this.#normalizePath(path);
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.readdir) {
            throw new Error(`Virtual filesystem "${id}" does not implement readdir.`);
        }

        const baseEntries = await provider.readdir(path);
        const merged = new Set(baseEntries);

        const parentOf = (fullPath: string): string => {
            const idx = fullPath.lastIndexOf("/");
            if (idx <= 0) return "/";
            return fullPath.slice(0, idx);
        };

        const nameOf = (fullPath: string): string => {
            const idx = fullPath.lastIndexOf("/");
            return idx === -1 ? fullPath : fullPath.slice(idx + 1);
        };

        for (const fifoPath of this.#fifoByPath.keys()) {
            if (parentOf(fifoPath) === normalized) {
                merged.add(nameOf(fifoPath));
            }
        }

        for (const socketPath of this.#socketPathToId.keys()) {
            if (parentOf(socketPath) === normalized) {
                merged.add(nameOf(socketPath));
            }
        }

        return Array.from(merged.values());
    }

    async ["party.openv.filesystem.read.watch"](path: string, options?: { recursive?: boolean; }): Promise<{ events: AsyncIterable<FileSystemEvent>; abort: () => Promise<void>; }> {
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }
        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider || !provider.watch) {
            throw new Error(`Virtual filesystem "${id}" does not implement watch.`);
        }
        return provider.watch(path, options);
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
        const normalized = this.#normalizePath(path);
        const fifoId = this.#fifoByPath.get(normalized);
        if (fifoId !== undefined) {
            return this.#openFifo(fifoId, flags);
        }

        if (this.#socketPathToId.has(normalized)) {
            throw new Error(`ENXIO: socket path '${normalized}' must be used via filesystem.socket.connect.`);
        }

        // Resolve path to mounted vfs provider
        const resolved = this.#resolveMountPath(path);
        if (!resolved) {
            throw new Error(`No mountpoint found for path "${path}". Use mount to attach a virtual filesystem.`);
        }

        const { id } = resolved;
        const provider = this.#vfsTable.get(id);
        if (!provider) {
            throw new Error(`Virtual filesystem "${id}" does not exist.`);
        }
        if (!provider.open) {
            throw new Error(`Virtual filesystem "${id}" does not implement open.`);
        }

        const providerOpen = provider.open!;
        const ofd = ++this.#ofdCounter;
        await providerOpen(path, ofd, flags, mode);
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
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            this.#ofdToPipe.delete(ofd);
            this.#ofdTable.delete(ofd);
            if (pipeInfo.kind === "anon") {
                this.#pipeCloseEnd(pipeInfo.pipeId, pipeInfo.role);
                return;
            }
            this.#fifoCloseDescriptor(pipeInfo.fifoId, pipeInfo.canRead, pipeInfo.canWrite);
            return;
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            this.#ofdToSocket.delete(ofd);
            this.#ofdTable.delete(ofd);
            this.#closeSocketOfd(ofd, socketInfo);
            return;
        }

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

    async ["party.openv.filesystem.virtual.onmount"](id: string, handler: (path: string, extra?: PlainParameter) => Promise<void>): Promise<void> {
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
    static readonly DEFAULT_DGRAM_QUEUE_LIMIT = 128;

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

    #fifoIdCounter = 0;

    #fifoByPath: Map<string, number> = new Map();

    #fifoTable: Map<number, {
        id: number;
        path: string | null;
        pipeId: number;
        mode: FileMode;
        uid: number;
        gid: number;
        atime: number;
        mtime: number;
        ctime: number;
        openReaders: number;
        openWriters: number;
        pendingOpenReaders: Array<() => void>;
        pendingOpenWriters: Array<() => void>;
    }> = new Map();

    #socketIdCounter = 0;

    #socketPathToId: Map<string, number> = new Map();

    #socketTable: Map<number, {
        id: number;
        type: FileSystemSocketType;
        boundPath: string | null;
        mode: FileMode;
        uid: number;
        gid: number;
        atime: number;
        mtime: number;
        ctime: number;
        listening: boolean;
        backlog: number;
        pendingAcceptedOfds: number[];
        pendingAcceptWaiters: Array<() => void>;
        openOfds: Set<number>;
        pendingDatagrams: Array<{ data: Uint8Array; address: SocketAddress | null }>;
        pendingDatagramReaders: Array<() => void>;
        pendingDatagramWriters: Array<() => void>;
        datagramQueueLimit: number;
    }> = new Map();

    #ofdToSocket: Map<number, { socketId: number; readPipeId?: number; writePipeId?: number }> = new Map();

    /**
     * Maps an OFD to its pipe id and role ("read" or "write").
     */
    #ofdToPipe: Map<number,
        | { kind: "anon"; pipeId: number; role: "read" | "write" }
        | { kind: "fifo"; fifoId: number; canRead: boolean; canWrite: boolean }
    > = new Map();

    async ["party.openv.impl.filesystem.readByOfd"](ofd: number, length: number, position?: number): Promise<Uint8Array> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            if (pipeInfo.kind === "anon") {
                if (pipeInfo.role !== "read") {
                    throw new Error(`OFD ${ofd} is not readable.`);
                }
                return this.#pipeRead(pipeInfo.pipeId, length);
            }
            if (!pipeInfo.canRead) {
                throw new Error(`OFD ${ofd} is not readable.`);
            }
            return this.#fifoRead(pipeInfo.fifoId, length);
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            if (socketInfo.readPipeId === undefined) {
                throw new Error(`ENOTCONN: socket OFD ${ofd} is not connected for read.`);
            }
            return this.#pipeRead(socketInfo.readPipeId, length);
        }

        return this["party.openv.filesystem.read.read"](ofd, length, position);
    }

    async ["party.openv.impl.filesystem.writeByOfd"](ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            if (pipeInfo.kind === "anon") {
                if (pipeInfo.role !== "write") {
                    throw new Error(`OFD ${ofd} is not writable.`);
                }
                return this.#pipeWrite(pipeInfo.pipeId, buffer, offset, length);
            }
            if (!pipeInfo.canWrite) {
                throw new Error(`OFD ${ofd} is not writable.`);
            }
            return this.#fifoWrite(pipeInfo.fifoId, buffer, offset, length);
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            if (socketInfo.writePipeId === undefined) {
                throw new Error(`ENOTCONN: socket OFD ${ofd} is not connected for write.`);
            }
            return this.#pipeWrite(socketInfo.writePipeId, buffer, offset, length);
        }

        return this["party.openv.filesystem.write.write"](ofd, buffer, offset, length, position);
    }

    async ["party.openv.impl.filesystem.closeByOfd"](ofd: number): Promise<void> {
        const pipeInfo = this.#ofdToPipe.get(ofd);
        if (pipeInfo) {
            this.#ofdToPipe.delete(ofd);
            this.#ofdTable.delete(ofd);
            if (pipeInfo.kind === "anon") {
                this.#pipeCloseEnd(pipeInfo.pipeId, pipeInfo.role);
                return;
            }
            this.#fifoCloseDescriptor(pipeInfo.fifoId, pipeInfo.canRead, pipeInfo.canWrite);
            return;
        }

        const socketInfo = this.#ofdToSocket.get(ofd);
        if (socketInfo) {
            this.#ofdToSocket.delete(ofd);
            this.#ofdTable.delete(ofd);
            this.#closeSocketOfd(ofd, socketInfo);
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

        this.#ofdToPipe.set(writeOfd, { kind: "anon", pipeId, role: "write" });
        this.#ofdToPipe.set(readOfd, { kind: "anon", pipeId, role: "read" });

        return [readOfd, writeOfd];
    }

    async #openFifo(fifoId: number, flags: OpenFlags): Promise<number> {
        const fifo = this.#fifoTable.get(fifoId);
        if (!fifo) {
            throw new Error(`ENOENT: fifo does not exist`);
        }

        const isReadOnly = flags === "r";
        const isWriteOnly = flags === "w" || flags === "a" || flags === "wx" || flags === "ax";
        const canRead = flags.includes("r") || flags.includes("+");
        const canWrite = flags.includes("w") || flags.includes("a") || flags.includes("+");

        if (!canRead && !canWrite) {
            throw new Error(`EINVAL: unsupported fifo open flags '${flags}'`);
        }

        // Register this endpoint before waiting so peer opens can observe presence.
        if (canRead) fifo.openReaders++;
        if (canWrite) fifo.openWriters++;

        if (canWrite) {
            for (const resolve of fifo.pendingOpenReaders.splice(0)) resolve();
        }
        if (canRead) {
            for (const resolve of fifo.pendingOpenWriters.splice(0)) resolve();
        }

        if (isReadOnly) {
            while (fifo.openWriters === 0) {
                await new Promise<void>((resolve) => fifo.pendingOpenReaders.push(resolve));
                if (!this.#fifoTable.has(fifoId)) {
                    if (canRead && fifo.openReaders > 0) fifo.openReaders--;
                    if (canWrite && fifo.openWriters > 0) fifo.openWriters--;
                    throw new Error(`ENOENT: fifo no longer exists`);
                }
            }
        }
        if (isWriteOnly) {
            while (fifo.openReaders === 0) {
                await new Promise<void>((resolve) => fifo.pendingOpenWriters.push(resolve));
                if (!this.#fifoTable.has(fifoId)) {
                    if (canRead && fifo.openReaders > 0) fifo.openReaders--;
                    if (canWrite && fifo.openWriters > 0) fifo.openWriters--;
                    throw new Error(`ENOENT: fifo no longer exists`);
                }
            }
        }

        fifo.atime = Date.now();
        fifo.mtime = Date.now();

        const ofd = ++this.#ofdCounter;
        this.#ofdTable.set(ofd, {
            path: fifo.path ?? `<fifo:${fifo.id}>`,
            flags,
            mode: fifo.mode,
        });
        this.#ofdToPipe.set(ofd, { kind: "fifo", fifoId, canRead, canWrite });
        return ofd;
    }

    async #fifoRead(fifoId: number, length: number): Promise<Uint8Array> {
        const fifo = this.#fifoTable.get(fifoId);
        if (!fifo) throw new Error(`EPIPE: fifo does not exist.`);
        const pipe = this.#pipeTable.get(fifo.pipeId);
        if (!pipe) throw new Error(`EPIPE: fifo backing pipe is missing.`);

        while (pipe.head === pipe.tail && fifo.openWriters > 0) {
            await new Promise<void>(resolve => pipe.pendingReaders.push(resolve));
            if (!this.#fifoTable.has(fifoId)) {
                return new Uint8Array(0);
            }
        }

        if (pipe.head === pipe.tail && fifo.openWriters === 0) {
            return new Uint8Array(0);
        }

        const available = pipe.head - pipe.tail;
        const toRead = Math.min(length, available);
        const result = pipe.buffer.slice(pipe.tail, pipe.tail + toRead);
        pipe.tail += toRead;
        fifo.atime = Date.now();

        if (pipe.tail === pipe.head) {
            pipe.tail = 0;
            pipe.head = 0;
        }

        for (const resolve of pipe.pendingWriters.splice(0)) resolve();

        return result;
    }

    async #fifoWrite(fifoId: number, buffer: Uint8Array, offset?: number, length?: number): Promise<number> {
        const fifo = this.#fifoTable.get(fifoId);
        if (!fifo) throw new Error(`EPIPE: fifo does not exist.`);
        const pipe = this.#pipeTable.get(fifo.pipeId);
        if (!pipe) throw new Error(`EPIPE: fifo backing pipe is missing.`);

        if (fifo.openReaders === 0) throw new Error(`Broken pipe: read end is closed.`);

        const srcOffset = offset ?? 0;
        const toWrite = length ?? (buffer.length - srcOffset);
        const src = buffer.subarray(srcOffset, srcOffset + toWrite);

        let written = 0;
        while (written < src.length) {
            if (fifo.openReaders === 0) throw new Error(`Broken pipe: read end is closed.`);

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
                if (!this.#fifoTable.has(fifoId)) {
                    throw new Error(`Broken pipe: fifo endpoint is closed.`);
                }
                continue;
            }

            const chunk = Math.min(src.length - written, space);
            pipe.buffer.set(src.subarray(written, written + chunk), pipe.head);
            pipe.head += chunk;
            written += chunk;
            fifo.mtime = Date.now();

            for (const resolve of pipe.pendingReaders.splice(0)) {
                resolve();
            }
        }

        return written;
    }

    #fifoCloseDescriptor(fifoId: number, canRead: boolean, canWrite: boolean): void {
        const fifo = this.#fifoTable.get(fifoId);
        if (!fifo) return;
        const pipe = this.#pipeTable.get(fifo.pipeId);

        if (canRead && fifo.openReaders > 0) {
            fifo.openReaders--;
        }
        if (canWrite && fifo.openWriters > 0) {
            fifo.openWriters--;
        }

        if (pipe) {
            if (fifo.openReaders === 0) {
                for (const resolve of pipe.pendingWriters.splice(0)) resolve();
            }
            if (fifo.openWriters === 0) {
                for (const resolve of pipe.pendingReaders.splice(0)) resolve();
            }
        }

        this.#cleanupFifoIfUnlinkedAndClosed(fifoId);
    }

    #cleanupFifoIfUnlinkedAndClosed(fifoId: number): void {
        const fifo = this.#fifoTable.get(fifoId);
        if (!fifo) return;
        if (fifo.path !== null) return;
        if (fifo.openReaders !== 0 || fifo.openWriters !== 0) return;

        const pipe = this.#pipeTable.get(fifo.pipeId);
        if (pipe) {
            for (const resolve of pipe.pendingReaders.splice(0)) resolve();
            for (const resolve of pipe.pendingWriters.splice(0)) resolve();
            this.#pipeTable.delete(fifo.pipeId);
        }

        this.#fifoTable.delete(fifoId);
    }

    #requireSocket(socketId: number): {
        id: number;
        type: FileSystemSocketType;
        boundPath: string | null;
        mode: FileMode;
        uid: number;
        gid: number;
        atime: number;
        mtime: number;
        ctime: number;
        listening: boolean;
        backlog: number;
        pendingAcceptedOfds: number[];
        pendingAcceptWaiters: Array<() => void>;
        openOfds: Set<number>;
        pendingDatagrams: Array<{ data: Uint8Array; address: SocketAddress | null }>;
        pendingDatagramReaders: Array<() => void>;
        pendingDatagramWriters: Array<() => void>;
        datagramQueueLimit: number;
    } {
        const socket = this.#socketTable.get(socketId);
        if (!socket) {
            throw new Error(`EBADF: socket ${socketId} does not exist.`);
        }
        return socket;
    }

    #requireSocketOfd(ofd: number): { socketId: number; readPipeId?: number; writePipeId?: number } {
        const info = this.#ofdToSocket.get(ofd);
        if (!info) {
            throw new Error(`ENOTSOCK: OFD ${ofd} is not a socket.`);
        }
        return info;
    }

    #createPipeState(bufferSize: number = CoreFS.DEFAULT_PIPE_BUFFER_SIZE): number {
        const pipeId = ++this.#pipeIdCounter;
        this.#pipeTable.set(pipeId, {
            buffer: new Uint8Array(bufferSize),
            head: 0,
            tail: 0,
            readClosed: false,
            writeClosed: false,
            pendingReaders: [],
            pendingWriters: [],
        });
        return pipeId;
    }

    #closeSocketOfd(ofd: number, socketInfo: { socketId: number; readPipeId?: number; writePipeId?: number }): void {
        if (socketInfo.readPipeId !== undefined) {
            this.#pipeCloseEnd(socketInfo.readPipeId, "read");
        }
        if (socketInfo.writePipeId !== undefined) {
            this.#pipeCloseEnd(socketInfo.writePipeId, "write");
        }

        const socket = this.#socketTable.get(socketInfo.socketId);
        if (!socket) return;
        socket.openOfds.delete(ofd);
        socket.pendingAcceptedOfds = socket.pendingAcceptedOfds.filter((queuedOfd) => queuedOfd !== ofd);
        for (const resolve of socket.pendingAcceptWaiters.splice(0)) resolve();
        for (const resolve of socket.pendingDatagramReaders.splice(0)) resolve();
        for (const resolve of socket.pendingDatagramWriters.splice(0)) resolve();
        this.#cleanupSocketIfOrphaned(socket.id);
    }

    #cleanupSocketIfOrphaned(socketId: number): void {
        const socket = this.#socketTable.get(socketId);
        if (!socket) return;
        if (socket.boundPath !== null) return;
        if (socket.openOfds.size !== 0) return;
        if (socket.pendingAcceptedOfds.length !== 0) return;
        this.#socketTable.delete(socketId);
    }

    async #pathExists(path: string): Promise<boolean> {
        try {
            await this["party.openv.filesystem.read.stat"](path);
            return true;
        } catch {
            return false;
        }
    }

    #normalizePath(path: string): string {
        if (!path) return "/";
        let normalized = path.startsWith("/") ? path : "/" + path;
        if (normalized.length > 1) {
            normalized = normalized.replace(/\/+$/, "");
        }
        return normalized;
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
    supports(ns: typeof FS_SOCKET_NAMESPACE | typeof FS_SOCKET_NAMESPACE_VERSIONED): Promise<typeof FS_SOCKET_NAMESPACE_VERSIONED>;
    supports(ns: typeof FS_SYNC_NAMESPACE | typeof FS_SYNC_NAMESPACE_VERSIONED): Promise<typeof FS_SYNC_NAMESPACE_VERSIONED>;
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
            ns === FS_SOCKET_NAMESPACE ||
            ns === FS_SOCKET_NAMESPACE_VERSIONED
        ) {
            return FS_SOCKET_NAMESPACE_VERSIONED;
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
        let hasRoot = false;
        
        for (const mountPoint of this.#mountTable.keys()) {
            if (mountPoint === "/") {
                hasRoot = true;
                continue; // Don't set bestMount to root yet; prefer specific mounts
            }
            if (path === mountPoint || path.startsWith(mountPoint + "/")) {
                if (bestMount === null || mountPoint.length > bestMount.length) {
                    bestMount = mountPoint;
                }
            }
        }
        
        // Only use root as fallback if no specific mount matched
        if (bestMount === null && hasRoot) {
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
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;
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
    FileSystemPipeComponent,
    FileSystemSocketComponent,
    FileSystemSyncComponent,
    FileSystemLocalComponent {
    #system: FileSystemCoreComponent &
        FileSystemReadOnlyComponent &
        FileSystemReadWriteComponent &
        FileSystemPipeComponent &
        FileSystemSocketComponent &
        FileSystemSyncComponent &
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
        FileSystemSocketComponent &
        FileSystemSyncComponent &
        CoreFSExt &
        ProcessComponent &
        CoreProcessExt, umask = 0o022) {
        this.#system = system;
        this.#pid = pid;
        this.#umask = umask;
    }
    async ["party.openv.filesystem.sync.sync"](ofd: number): Promise<void> {
        const ofdGlobal = this.#fdToOfd.get(ofd);
        if (ofdGlobal === undefined) {
            throw new Error(`Invalid file descriptor ${ofd}`);
        }
        await this.#system["party.openv.filesystem.sync.sync"](ofdGlobal);
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

    async ["party.openv.filesystem.write.mkfifo"](path: string, mode: FileMode = 0o666): Promise<void> {
        await this.#checkPathTraversal(path);
        const parent = path.split("/").slice(0, -1).join("/") || "/";
        const parentStat = await this.#system["party.openv.filesystem.read.stat"](parent);
        const uid = await this.#getUid();
        const gid = await this.#getGid();
        requireAccess(parentStat, uid, gid, "write", parent);
        requireAccess(parentStat, uid, gid, "execute", parent);
        return this.#system["party.openv.filesystem.write.mkfifo"](path, this.#applyUmask(mode));
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

    async ["party.openv.filesystem.socket.create"](type: FileSystemSocketType): Promise<number> {
        const ofd = await this.#system["party.openv.filesystem.socket.create"](type);
        const fd = ++this.#fdCounter;
        this.#fdToOfd.set(fd, ofd);
        return fd;
    }

    async ["party.openv.filesystem.socket.bind"](fd: number, address: SocketAddress): Promise<void> {
        const ofd = this.#resolveOfd(fd);
        await this.#system["party.openv.filesystem.socket.bind"](ofd, address);
    }

    async ["party.openv.filesystem.socket.listen"](fd: number, backlog?: number): Promise<void> {
        const ofd = this.#resolveOfd(fd);
        await this.#system["party.openv.filesystem.socket.listen"](ofd, backlog);
    }

    async ["party.openv.filesystem.socket.connect"](fd: number, address: SocketAddress): Promise<void> {
        const ofd = this.#resolveOfd(fd);
        await this.#system["party.openv.filesystem.socket.connect"](ofd, address);
    }

    async ["party.openv.filesystem.socket.accept"](fd: number): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        const acceptedOfd = await this.#system["party.openv.filesystem.socket.accept"](ofd);
        const acceptedFd = ++this.#fdCounter;
        this.#fdToOfd.set(acceptedFd, acceptedOfd);
        return acceptedFd;
    }

    async ["party.openv.filesystem.socket.sendto"](fd: number, data: Uint8Array, address: SocketAddress): Promise<number> {
        const ofd = this.#resolveOfd(fd);
        return this.#system["party.openv.filesystem.socket.sendto"](ofd, data, address);
    }

    async ["party.openv.filesystem.socket.recvfrom"](fd: number, maxLength: number): Promise<{ data: Uint8Array; address: SocketAddress | null }> {
        const ofd = this.#resolveOfd(fd);
        return this.#system["party.openv.filesystem.socket.recvfrom"](ofd, maxLength);
    }

    async supports(ns: typeof FS_NAMESPACE | typeof FS_NAMESPACE_VERSIONED): Promise<typeof FS_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_READ_NAMESPACE | typeof FS_READ_NAMESPACE_VERSIONED): Promise<typeof FS_READ_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_WRITE_NAMESPACE | typeof FS_WRITE_NAMESPACE_VERSIONED): Promise<typeof FS_WRITE_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_LOCAL_NAMESPACE | typeof FS_LOCAL_NAMESPACE_VERSIONED): Promise<typeof FS_LOCAL_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_SYNC_NAMESPACE | typeof FS_SYNC_NAMESPACE_VERSIONED): Promise<typeof FS_SYNC_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_PIPE_NAMESPACE | typeof FS_PIPE_NAMESPACE_VERSIONED): Promise<typeof FS_PIPE_NAMESPACE_VERSIONED>;
    async supports(ns: typeof FS_SOCKET_NAMESPACE | typeof FS_SOCKET_NAMESPACE_VERSIONED): Promise<typeof FS_SOCKET_NAMESPACE_VERSIONED>;
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
            case FS_SOCKET_NAMESPACE:
            case FS_SOCKET_NAMESPACE_VERSIONED: return FS_SOCKET_NAMESPACE_VERSIONED;
        }
        return null;
    }
}