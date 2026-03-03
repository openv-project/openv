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

export const FS_NAMESPACE = "party.openv.filesystem" as const;
export const FS_NAMESPACE_VERSIONED = `${FS_NAMESPACE}/0.1.0` as const;
export const FS_READ_NAMESPACE = `${FS_NAMESPACE}.read` as const;
export const FS_READ_NAMESPACE_VERSIONED = `${FS_READ_NAMESPACE}/0.1.0` as const;
export const FS_WRITE_NAMESPACE = `${FS_NAMESPACE}.write` as const;
export const FS_WRITE_NAMESPACE_VERSIONED = `${FS_WRITE_NAMESPACE}/0.1.0` as const;
export const FS_VIRTUAL_NAMESPACE = `${FS_NAMESPACE}.virtual` as const;
export const FS_VIRTUAL_NAMESPACE_VERSIONED = `${FS_VIRTUAL_NAMESPACE}/0.1.0` as const;
export const FS_LOCAL_NAMESPACE = `${FS_NAMESPACE}.local` as const;
export const FS_LOCAL_NAMESPACE_VERSIONED = `${FS_LOCAL_NAMESPACE}/0.1.0` as const;

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
export interface FileSystemCoreComponent extends SystemComponent<typeof FS_NAMESPACE_VERSIONED, typeof FS_NAMESPACE> {
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
export interface FileSystemReadOnlyComponent extends SystemComponent<typeof FS_READ_NAMESPACE_VERSIONED, typeof FS_READ_NAMESPACE> {
    ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats>;
    /**
     * Read from an open file. Accepts the same kind of number that `open` returned
     * (global open file number in system environment, local fd in process environment).
     */
    ["party.openv.filesystem.read.read"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<number>;
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
export interface FileSystemReadWriteComponent extends SystemComponent<typeof FS_WRITE_NAMESPACE_VERSIONED, typeof FS_WRITE_NAMESPACE> {
    /**
     * Write to an open file. Accepts the same kind of number that `open` returned
     * (global open file number in system environment, local fd in process environment).
     */
    ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number>;
    ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void>;
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
export interface FileSystemLocalComponent extends SystemComponent<typeof FS_LOCAL_NAMESPACE_VERSIONED, typeof FS_LOCAL_NAMESPACE> {
    /**
     * Get a list of all open file descriptors for the current process.
     */
    ["party.openv.filesystem.local.listfds"](): Promise<number[]>;

    /**
     * Duplicate a file descriptor, returning a new local fd pointing to the same global open file number.
     */
    ["party.openv.filesystem.local.dupfd"](fd: number): Promise<number>;
}

export interface FileSystemVirtualComponent extends SystemComponent<typeof FS_VIRTUAL_NAMESPACE_VERSIONED, typeof FS_VIRTUAL_NAMESPACE> {
    ["party.openv.filesystem.virtual.create"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.destroy"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.mount"](id: string, path: string): Promise<void>;
    ["party.openv.filesystem.virtual.unmount"](path: string): Promise<void>;
    ["party.openv.filesystem.virtual.onmount"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
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
    ["party.openv.filesystem.virtual.onread"](id: string, handler: (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<number>): Promise<void>;
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
}
