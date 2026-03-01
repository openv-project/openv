import { type SystemComponent } from "./index.ts";

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
 * The core file system component that provides the open/close interface.
 */
export interface FileSystemCoreComponent extends SystemComponent<"party.openv.filesystem/0.1.0", "party.openv.filesystem"> {
    ["party.openv.filesystem.open"](path: string, flags: OpenFlags, mode: FileMode): Promise<number>;
    ["party.openv.filesystem.close"](fd: number): Promise<void>;
}

/**
 * A system component for read file system operations.
 * This component supports all of the most basic file operations, but only in read mode.
 */
export interface FileSystemReadOnlyComponent extends SystemComponent<"party.openv.filesystem.read/0.1.0", "party.openv.filesystem.read"> {
    ["party.openv.filesystem.read.stat"](path: string): Promise<FsStats>;
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
export interface FileSystemReadWriteComponent extends SystemComponent<"party.openv.filesystem.write/0.1.0", "party.openv.filesystem.write"> {
    ["party.openv.filesystem.write.write"](fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number>;
    ["party.openv.filesystem.write.create"](path: string, mode?: FileMode): Promise<void>;
    ["party.openv.filesystem.write.mkdir"](path: string, mode?: FileMode): Promise<void>;
    ["party.openv.filesystem.write.rmdir"](path: string): Promise<void>;
    ["party.openv.filesystem.write.rename"](oldPath: string, newPath: string): Promise<void>;
    ["party.openv.filesystem.write.unlink"](path: string): Promise<void>;

    // FUTURE: symlink management + permissions management
}

export interface FileSystemVirtualComponent extends SystemComponent<"party.openv.filesystem.virtual/0.1.0", "party.openv.filesystem.virtual"> {
    ["party.openv.filesystem.virtual.create"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.destroy"](id: string): Promise<void>;
    ["party.openv.filesystem.virtual.mount"](id: string, path: string): Promise<void>;
    ["party.openv.filesystem.virtual.unmount"](path: string): Promise<void>;
    ["party.openv.filesystem.virtual.onmount"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onunmount"](id: string, handler: (path: string) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onopen"](id: string, handler: (path: string, fd: number, flags: OpenFlags, mode: FileMode) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onclose"](id: string, handler: (fd: number) => Promise<void>): Promise<void>;
    ["party.openv.filesystem.virtual.onread"](id: string, handler: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<number>): Promise<void>;
    ["party.openv.filesystem.virtual.onwrite"](id: string, handler: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>): Promise<void>;
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
