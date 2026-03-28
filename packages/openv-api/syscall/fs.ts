import { PlainParameter } from "../mod.ts";
import type { SystemComponent } from "./mod.ts";

export type OpenFlags = "r" | "a" | "ax" | "a+" | "r+" | "w" | "wx" | "w+" | "wx+"

export type FileMode = number;

export interface FsStats<T extends string = string> {
    type: "DIRECTORY" | "FILE";
    size: number;
    atime: number;
    mtime: number;
    ctime: number;
    name: string;
    uid: number;
    gid: number;
    mode: FileMode;
    node: T;
}

export type FileSystemEventType = "rename" | "change";

export interface FileSystemEvent {
    type: FileSystemEventType;
    filename: string;
}

/**
 * Describes how a stdio fd should be wired when spawning a process.
 * - `"pipe"`: Create a new pipe; the parent receives an fd to the other end.
 * - `"inherit"`: Inherit the parent's fd for this slot (stdin/stdout/stderr).
 * - `number`: Use this specific fd from the parent process as the child's fd.
 * - `null` or `undefined`: Use the default behavior (typically inherit, or /dev/null equivalent).
 */
export type StdioOption = "pipe" | "inherit" | number | null | undefined;

/**
 * The result of spawning a process with piped stdio. Each field is present only when
 * the corresponding stdio option was `"pipe"`.
 */
export interface SpawnStdioResult {
    /** Parent-side fd for writing to the child's stdin. Present when stdin is "pipe". */
    stdin?: number;
    /** Parent-side fd for reading from the child's stdout. Present when stdout is "pipe". */
    stdout?: number;
    /** Parent-side fd for reading from the child's stderr. Present when stderr is "pipe". */
    stderr?: number;
}

export type FS_NAMESPACE = "party.openv.filesystem";
export type FS_NAMESPACE_VERSIONED = "party.openv.filesystem/0.1.0";
export type FS_READ_NAMESPACE = "party.openv.filesystem.read";
export type FS_READ_NAMESPACE_VERSIONED = "party.openv.filesystem.read/0.1.0";
export type FS_WRITE_NAMESPACE = "party.openv.filesystem.write";
export type FS_WRITE_NAMESPACE_VERSIONED = "party.openv.filesystem.write/0.1.0";
export type FS_VIRTUAL_NAMESPACE = "party.openv.filesystem.virtual";
export type FS_VIRTUAL_NAMESPACE_VERSIONED = "party.openv.filesystem.virtual/0.1.0";
export type FS_LOCAL_NAMESPACE = "party.openv.filesystem.local";
export type FS_LOCAL_NAMESPACE_VERSIONED = "party.openv.filesystem.local/0.1.0";
export type FS_PIPE_NAMESPACE = "party.openv.filesystem.pipe";
export type FS_PIPE_NAMESPACE_VERSIONED = "party.openv.filesystem.pipe/0.1.0";
export type FS_SOCKET_NAMESPACE = "party.openv.filesystem.socket";
export type FS_SOCKET_NAMESPACE_VERSIONED = "party.openv.filesystem.socket/0.1.0";

export type FileSystemSocketType = "stream" | "dgram";

export interface SocketAddress {
    path: string;
}

/**
 * The core file system component that provides the open/close interface.
 * 
 * In the system (non-process) environment, `open` returns a global open file number
 * (analogous to the Linux open file table entry index). In a process-scoped environment,
 * `open` returns a process-local file descriptor that maps to a global open file number internally.
 * 
 * The `read` and `write` operations also accept the appropriate identifier for the
 * environment: a global open file number in the system environment, or a local file
 * descriptor in the process environment.
 */
export interface FileSystemCoreComponent extends SystemComponent<FS_NAMESPACE_VERSIONED, FS_NAMESPACE> {
    /**
     * Open a file at the given path. In the system environment, returns a global open file
     * number. In a process-scoped environment, returns a process-local file descriptor.
     */
    ["party.openv.filesystem.open"](path: string, flags: OpenFlags, mode?: FileMode): Promise<number>;
    /**
     * Close a previously opened file. Accepts the same kind of number that `open` returned.
     */
    ["party.openv.filesystem.close"](fd: number): Promise<void>;
}

/**
 * A system component for read file system operations.
 * This component supports all of the most basic file operations, but only in read mode.
 */
export interface FileSystemReadOnlyComponent extends SystemComponent<FS_READ_NAMESPACE_VERSIONED, FS_READ_NAMESPACE> {
    ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats>;
    /**
     * Read from an open file. Accepts the same kind of number that `open` returned
     * (global open file number in system environment, local fd in process environment).
     */
    ["party.openv.filesystem.read.read"](fd: number, length: number, position?: number): Promise<Uint8Array>;
    ["party.openv.filesystem.read.readdir"](path: string): Promise<string[]>;
    ["party.openv.filesystem.read.watch"](path: string, options?: { recursive?: boolean }): Promise<{
        events: AsyncIterable<FileSystemEvent>;
        abort: () => Promise<void>;
    }>;
    // FUTURE: symlink management + permissions management
}

/**
 * A system component for read-write file system operations.
 * This component supports all of the most basic file operations, which
 * allows for both reading and writing to files when fs/read is implemented.
 */
export interface FileSystemReadWriteComponent extends SystemComponent<FS_WRITE_NAMESPACE_VERSIONED, FS_WRITE_NAMESPACE> {
    /**
     * Write to an open file. Accepts the same kind of number that `open` returned
     * (global open file number in system environment, local fd in process environment).
     */
    ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number>;
    ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void>;
    ["party.openv.filesystem.write.mkfifo"](path: string, mode?: FileMode): Promise<void>;
    ["party.openv.filesystem.write.mkdir"](path: string, mode?: FileMode): Promise<void>;
    ["party.openv.filesystem.write.rmdir"](path: string): Promise<void>;
    ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void>;
    ["party.openv.filesystem.write.unlink"](path: string): Promise<void>;

    // FUTURE: symlink management + permissions management
}

/**
 * A system component for process-local file system operations. This component is only
 * available in a process-scoped environment (similar to ProcessLocalComponent for processes).
 * It provides operations specific to the current process's file descriptor table.
 */
export interface FileSystemLocalComponent extends SystemComponent<FS_LOCAL_NAMESPACE_VERSIONED, FS_LOCAL_NAMESPACE> {
    /**
     * Get a list of all open file descriptors for the current process.
     */
    ["party.openv.filesystem.local.listfds"](): Promise<number[]>;

    /**
     * Duplicate a file descriptor, returning a new local fd pointing to the same global open file number.
     */
    ["party.openv.filesystem.local.dupfd"](fd: number): Promise<number>;

    /**
     * Duplicate a file descriptor to a specific target fd number.
     * If `targetFd` is already open, it is silently closed first.
     * After this call, `targetFd` points to the same global open file number as `fd`.
     */
    ["party.openv.filesystem.local.dup2"](fd: number, targetFd: number): Promise<number>;

    /**
     * Insert a global open file number into the local fd table at a specific target fd number.
     * 
     * Security note:
     * This method is okay to expose, as permission checks are enforced by the global open file table.
     */
    ["party.openv.filesystem.local.setfd"](targetFd: number, ofd: number): Promise<void>;
}

/**
 * A system component for creating anonymous pipes. Pipes are unidirectional byte streams
 * that are members of the open file table. Pipe methods return open file numbers in system environment
 * and local fds in process environment.
 */
export interface FileSystemPipeComponent extends SystemComponent<FS_PIPE_NAMESPACE_VERSIONED, FS_PIPE_NAMESPACE> {
    /**
     * Create an anonymous unidirectional pipe.
     * The returned file numbers/fds are ordered as [readEnd, writeEnd], where readEnd is readable and writeEnd is writable.
     */
    ["party.openv.filesystem.pipe.create"](bufferSize?: number): Promise<[readEnd: number, writeEnd: number]>;
}

/**
 * Socket capabilities that are not expressible through plain open/read/write alone.
 * Data transfer for connected stream sockets still uses filesystem read/write.
 */
export interface FileSystemSocketComponent extends SystemComponent<FS_SOCKET_NAMESPACE_VERSIONED, FS_SOCKET_NAMESPACE> {
    ["party.openv.filesystem.socket.create"](type: FileSystemSocketType): Promise<number>;
    ["party.openv.filesystem.socket.bind"](fd: number, address: SocketAddress): Promise<void>;
    ["party.openv.filesystem.socket.listen"](fd: number, backlog?: number): Promise<void>;
    ["party.openv.filesystem.socket.connect"](fd: number, address: SocketAddress): Promise<void>;
    ["party.openv.filesystem.socket.accept"](fd: number): Promise<number>;
    ["party.openv.filesystem.socket.sendto"](fd: number, data: Uint8Array, address: SocketAddress): Promise<number>;
    ["party.openv.filesystem.socket.recvfrom"](fd: number, maxLength: number): Promise<{ data: Uint8Array; address: SocketAddress | null }>;
}

export interface FileSystemVirtualComponent extends SystemComponent<FS_VIRTUAL_NAMESPACE_VERSIONED, FS_VIRTUAL_NAMESPACE> {
    ["party.openv.filesystem.virtual.create"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.destroy"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.mount"](id: string, path: string, extra?: PlainParameter): Promise<void>;
    ["party.openv.filesystem.virtual.unmount"](path: string): Promise<void>;
    ["party.openv.filesystem.virtual.onmount"](id: string, handler: (path: string, extra?: PlainParameter) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onunmount"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
    /**
     * Register a handler for when a file is opened on this virtual filesystem.
     * The handler receives the global open file number (not a process-local fd),
     * which is the same number that the virtual filesystem should use for subsequent read/write/close callbacks.
     */
    ["party.openv.filesystem.virtual.onopen"](id: string, handler: (path: string, ofd: number, flags: OpenFlags, mode: FileMode) => Promise<void>): Promise<void>;
    /**
     * Register a handler for when a file is closed. Receives the global open file number.
     */
    ["party.openv.filesystem.virtual.onclose"](id: string, handler: (ofd: number) => Promise<void>): Promise<void>;
    /**
     * Register a handler for reading from a file. Receives the global open file number.
     */
    ["party.openv.filesystem.virtual.onread"](id: string, handler: (ofd: number, length: number, position?: number) => Promise<Uint8Array>): Promise<void>;
    /**
     * Register a handler for writing to a file. Receives the global open file number.
     */
    ["party.openv.filesystem.virtual.onwrite"](id: string, handler: (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>): Promise<void>;
    ["party.openv.filesystem.virtual.oncreate"](id: string, handler: (path: string, mode?: FileMode) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onstat"](id: string, handler: (path: string) => Promise<FsStats>): Promise<void>;
    ["party.openv.filesystem.virtual.onreaddir"](id: string, handler: (path: string) => Promise<string[]>): Promise<void>;
    ["party.openv.filesystem.virtual.onmkdir"](id: string, handler: (path: string, mode?: FileMode) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onrmdir"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onrename"](id: string, handler: (oldPath: string, newPath: string) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onunlink"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onwatch"](id: string, handler: (path: string, options?: { recursive?: boolean }) => Promise<{
        events: AsyncIterable<FileSystemEvent>;
        abort: () => Promise<void>;
    }>): Promise<void>;
    ["party.openv.filesystem.virtual.onsync"](id: string, handler: (ofd: number) => Promise<void>): Promise<void>;
}

export type FS_SYNC_NAMESPACE = "party.openv.filesystem.sync";
export type FS_SYNC_NAMESPACE_VERSIONED = "party.openv.filesystem.sync/0.1.0";

/**
 * This component is implemented on filesystems that support explicit sync, where data may stay buffered
 * until an explicit flush operation is performed. The sync method accepts an open file number/fd and flushes
 * any buffered data for that file to the underlying storage medium. This is a no-op on filesystems that do not
 * support buffering.
 * 
 * For VFS: If your VFS does not support buffering, do not call `party.openv.filesystem.virtual.onsync` at all. 
 * The VFS layer should guard against missing sync support by acting like a no-op if the sync method is not implemented.
 */
export interface FileSystemSyncComponent extends SystemComponent<FS_SYNC_NAMESPACE_VERSIONED, FS_SYNC_NAMESPACE> {
    ["party.openv.filesystem.sync.sync"](ofd: number): Promise<void>;
}