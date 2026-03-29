import type {
    CharacterDeviceInfo,
    CharacterDeviceRegistration,
    FileMode,
    FileSystemDevFsComponent,
    FileSystemVirtualComponent,
    FsStats,
    OpenFlags,
    PlainParameter,
    SystemComponent,
} from "@openv-project/openv-api";

export const DEVFS_NAMESPACE = "party.openv.impl.devfs" as const;

type CharacterDevice = CharacterDeviceRegistration & {
    mode: FileMode;
    uid: number;
    gid: number;
    createdAt: number;
    updatedAt: number;
};

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

function requireDevicePath(path: string): string {
    const normalized = normalizePath(path);
    if (!normalized.startsWith("/dev/") || normalized === "/dev") {
        throw new Error(`device path must be under /dev: '${normalized}'`);
    }
    return normalized;
}

function defaultNoopIoctl(_ofd: number, request: string): never {
    throw new Error(`ENOTTY: ioctl request '${request}' is not supported`);
}

export class DevFS implements FileSystemDevFsComponent {
    #mountedAt: string | null = null;
    #devices = new Map<string, CharacterDevice>();
    #openFiles = new Map<number, string>();

    constructor() {
        const nullDevice: CharacterDeviceRegistration = {
            type: "character",
            mode: 0o666,
            read: async () => new Uint8Array(0),
            write: async (_ofd, buffer, offset, length) => {
                const start = offset ?? 0;
                const end = length !== undefined ? start + length : buffer.byteLength;
                return Math.max(0, end - start);
            },
            ioctl: async (ofd, request, _argument) => defaultNoopIoctl(ofd, request),
        };
        const zero: CharacterDeviceRegistration = {
            type: "character",
            mode: 0o666,
            read: async (_ofd, length) => new Uint8Array(length),
            write: async (_ofd, buffer, offset, length) => {
                const start = offset ?? 0;
                const end = length !== undefined ? start + length : buffer.byteLength;
                return Math.max(0, end - start);
            },
            ioctl: async (ofd, request, _argument) => defaultNoopIoctl(ofd, request),
        };
        const randomLike: CharacterDeviceRegistration = {
            type: "character",
            mode: 0o666,
            read: async (_ofd, length) => {
                const out = new Uint8Array(length);
                if (!globalThis.crypto?.getRandomValues) {
                    throw new Error("secure random source unavailable");
                }
                globalThis.crypto.getRandomValues(out);
                return out;
            },
            write: async (_ofd, buffer, offset, length) => {
                const start = offset ?? 0;
                const end = length !== undefined ? start + length : buffer.byteLength;
                return Math.max(0, end - start);
            },
            ioctl: async (ofd, request, _argument) => defaultNoopIoctl(ofd, request),
        };

        void this.registerCharacterDevice("/dev/null", nullDevice);
        void this.registerCharacterDevice("/dev/zero", zero);
        void this.registerCharacterDevice("/dev/random", randomLike);
        void this.registerCharacterDevice("/dev/urandom", randomLike);
    }

    async register(system: FileSystemVirtualComponent): Promise<void> {
        await system["party.openv.filesystem.virtual.create"](DEVFS_NAMESPACE);
        await system["party.openv.filesystem.virtual.onmount"](DEVFS_NAMESPACE, async (path: string) => await this.mount(normalizePath(path)));
        await system["party.openv.filesystem.virtual.onunmount"](DEVFS_NAMESPACE, async (path: string) => await this.unmount(normalizePath(path)));
        await system["party.openv.filesystem.virtual.onstat"](DEVFS_NAMESPACE, async (path: string) => await this.stat(normalizePath(path)));
        await system["party.openv.filesystem.virtual.onreaddir"](DEVFS_NAMESPACE, async (path: string) => await this.readdir(normalizePath(path)));
        await system["party.openv.filesystem.virtual.onopen"](DEVFS_NAMESPACE, async (path: string, ofd: number, flags: OpenFlags, mode: FileMode) => await this.open(normalizePath(path), ofd, flags, mode));
        await system["party.openv.filesystem.virtual.onclose"](DEVFS_NAMESPACE, async (ofd: number) => await this.close(ofd));
        await system["party.openv.filesystem.virtual.onread"](DEVFS_NAMESPACE, async (ofd: number, length: number, position?: number) => await this.read(ofd, length, position));
        await system["party.openv.filesystem.virtual.onwrite"](DEVFS_NAMESPACE, async (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => await this.write(ofd, buffer, offset, length, position));
        await system["party.openv.filesystem.virtual.onioctl"](DEVFS_NAMESPACE, async (ofd: number, request: string, argument?: PlainParameter) => await this.ioctl(ofd, request, argument));
        await system["party.openv.filesystem.virtual.oncreate"](DEVFS_NAMESPACE, async (path: string) => {
            throw new Error(`EPERM: cannot create regular files in devfs: '${path}'`);
        });
        await system["party.openv.filesystem.virtual.onmkdir"](DEVFS_NAMESPACE, async (path: string) => {
            throw new Error(`EPERM: cannot create directories in devfs: '${path}'`);
        });
        await system["party.openv.filesystem.virtual.onrmdir"](DEVFS_NAMESPACE, async (path: string) => {
            throw new Error(`EPERM: cannot remove directories in devfs: '${path}'`);
        });
        await system["party.openv.filesystem.virtual.onrename"](DEVFS_NAMESPACE, async (oldPath: string, newPath: string) => {
            throw new Error(`EPERM: cannot rename device files in devfs: '${oldPath}' -> '${newPath}'`);
        });
        await system["party.openv.filesystem.virtual.onunlink"](DEVFS_NAMESPACE, async (path: string) => {
            throw new Error(`EPERM: cannot unlink device files in devfs through fs ops: '${path}'`);
        });
    }

    async mount(path: string): Promise<void> {
        if (path !== "/dev") {
            throw new Error(`devfs must be mounted at /dev, received '${path}'`);
        }
        if (this.#mountedAt === "/dev") {
            throw new Error("devfs is already mounted at /dev");
        }
        this.#mountedAt = "/dev";
    }

    async unmount(path: string): Promise<void> {
        if (path !== "/dev" || this.#mountedAt !== "/dev") {
            throw new Error(`devfs is not mounted at '${path}'`);
        }
        this.#mountedAt = null;
        this.#openFiles.clear();
    }

    async stat(path: string): Promise<FsStats<typeof DEVFS_NAMESPACE>> {
        if (path === "/dev") {
            const now = Date.now();
            return {
                type: "DIRECTORY",
                size: 0,
                atime: now,
                mtime: now,
                ctime: now,
                name: "dev",
                uid: 0,
                gid: 0,
                mode: 0o040755,
                node: DEVFS_NAMESPACE,
            };
        }

        const devicePath = requireDevicePath(path);
        const device = this.#devices.get(devicePath);
        if (!device) {
            throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        }
        return {
            type: "FILE",
            size: 0,
            atime: device.updatedAt,
            mtime: device.updatedAt,
            ctime: device.createdAt,
            name: devicePath.split("/").pop()!,
            uid: device.uid,
            gid: device.gid,
            mode: 0o020000 | (device.mode & 0o777),
            node: DEVFS_NAMESPACE,
        };
    }

    async readdir(path: string): Promise<string[]> {
        if (path !== "/dev") {
            throw new Error(`ENOTDIR: not a directory, readdir '${path}'`);
        }
        return Array.from(this.#devices.keys())
            .map((fullPath) => fullPath.split("/").pop()!)
            .sort((a, b) => a.localeCompare(b));
    }

    async open(path: string, ofd: number, flags: OpenFlags, mode: FileMode): Promise<void> {
        const devicePath = requireDevicePath(path);
        const device = this.#devices.get(devicePath);
        if (!device) {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        this.#openFiles.set(ofd, devicePath);
        if (device.open) {
            await device.open(ofd, flags, mode);
        }
    }

    async close(ofd: number): Promise<void> {
        const devicePath = this.#openFiles.get(ofd);
        if (!devicePath) {
            return;
        }
        this.#openFiles.delete(ofd);
        const device = this.#devices.get(devicePath);
        if (device?.close) {
            await device.close(ofd);
        }
    }

    async read(ofd: number, length: number, position?: number): Promise<Uint8Array> {
        const device = this.#getOpenDevice(ofd, "read");
        if (!device.read) {
            throw new Error(`EBADF: device is not readable`);
        }
        return device.read(ofd, length, position);
    }

    async write(ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const device = this.#getOpenDevice(ofd, "write");
        if (!device.write) {
            throw new Error(`EBADF: device is not writable`);
        }
        return device.write(ofd, buffer, offset, length, position);
    }

    async ioctl(ofd: number, request: string, argument?: PlainParameter): Promise<PlainParameter> {
        const device = this.#getOpenDevice(ofd, "ioctl");
        if (!device.ioctl) {
            throw new Error(`ENOTTY: ioctl request '${request}' is not supported`);
        }
        return device.ioctl(ofd, request, argument);
    }

    #getOpenDevice(ofd: number, op: "read" | "write" | "ioctl"): CharacterDevice {
        const devicePath = this.#openFiles.get(ofd);
        if (!devicePath) {
            throw new Error(`EBADF: invalid open file number ${ofd} for ${op}`);
        }
        const device = this.#devices.get(devicePath);
        if (!device) {
            throw new Error(`ENOENT: device for open file number ${ofd} no longer exists`);
        }
        return device;
    }

    async ["party.openv.filesystem.devfs.register"](path: string, device: CharacterDeviceInfo): Promise<void> {
        const devicePath = requireDevicePath(path);
        if (this.#devices.has(devicePath)) {
            throw new Error(`EEXIST: device already registered '${devicePath}'`);
        }
        if (device.type !== "character") {
            throw new Error(`unsupported device type '${device.type}'`);
        }
        const now = Date.now();
        this.#devices.set(devicePath, {
            ...device,
            mode: device.mode ?? 0o666,
            uid: device.uid ?? 0,
            gid: device.gid ?? 0,
            createdAt: now,
            updatedAt: now,
        });
    }

    async ["party.openv.filesystem.devfs.onopen"](path: string, handler: (ofd: number, flags: OpenFlags, mode: FileMode) => Promise<void>): Promise<void> {
        const device = this.#requireDevice(path);
        device.open = handler;
    }

    async ["party.openv.filesystem.devfs.onclose"](path: string, handler: (ofd: number) => Promise<void>): Promise<void> {
        const device = this.#requireDevice(path);
        device.close = handler;
    }

    async ["party.openv.filesystem.devfs.onread"](path: string, handler: (ofd: number, length: number, position?: number) => Promise<Uint8Array>): Promise<void> {
        const device = this.#requireDevice(path);
        device.read = handler;
    }

    async ["party.openv.filesystem.devfs.onwrite"](path: string, handler: (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<number>): Promise<void> {
        const device = this.#requireDevice(path);
        device.write = handler;
    }

    async ["party.openv.filesystem.devfs.onioctl"](path: string, handler: (ofd: number, request: string, argument?: PlainParameter) => Promise<PlainParameter>): Promise<void> {
        const device = this.#requireDevice(path);
        device.ioctl = handler;
    }

    async ["party.openv.filesystem.devfs.unregister"](path: string): Promise<void> {
        const devicePath = requireDevicePath(path);
        if (!this.#devices.has(devicePath)) {
            throw new Error(`ENOENT: no such device '${devicePath}'`);
        }
        this.#devices.delete(devicePath);
        for (const [ofd, openPath] of this.#openFiles) {
            if (openPath === devicePath) {
                this.#openFiles.delete(ofd);
            }
        }
    }

    async ["party.openv.filesystem.devfs.list"](): Promise<string[]> {
        return Array.from(this.#devices.keys()).sort((a, b) => a.localeCompare(b));
    }

    async registerCharacterDevice(path: string, device: CharacterDeviceRegistration): Promise<void> {
        await this["party.openv.filesystem.devfs.register"](path, device);
        if (device.open) await this["party.openv.filesystem.devfs.onopen"](path, device.open);
        if (device.close) await this["party.openv.filesystem.devfs.onclose"](path, device.close);
        if (device.read) await this["party.openv.filesystem.devfs.onread"](path, device.read);
        if (device.write) await this["party.openv.filesystem.devfs.onwrite"](path, device.write);
        if (device.ioctl) await this["party.openv.filesystem.devfs.onioctl"](path, device.ioctl);
    }

    #requireDevice(path: string): CharacterDevice {
        const devicePath = requireDevicePath(path);
        const device = this.#devices.get(devicePath);
        if (!device) {
            throw new Error(`ENOENT: no such device '${devicePath}'`);
        }
        return device;
    }

    supports(ns: "party.openv.filesystem.devfs"): Promise<"party.openv.filesystem.devfs/0.1.0">;
    supports(ns: "party.openv.filesystem.devfs/0.1.0"): Promise<"party.openv.filesystem.devfs/0.1.0">;
    async supports(ns: string): Promise<string | null> {
        if (ns === "party.openv.filesystem.devfs" || ns === "party.openv.filesystem.devfs/0.1.0") {
            return "party.openv.filesystem.devfs/0.1.0";
        }
        return null;
    }
}

export type DevFsSystemComponent = SystemComponent<"party.openv.filesystem.devfs/0.1.0", "party.openv.filesystem.devfs">;
