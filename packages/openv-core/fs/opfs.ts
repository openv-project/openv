import type { FileMode, FileSystemVirtualComponent, FsStats, OpenFlags, PlainParameter } from "@openv-project/openv-api";

export const OPFS_NAMESPACE = "party.openv.impl.opfs" as const;

const INTERNAL_ATTRS_FILE = ".attrs";
const SANITIZE_PREFIX = ".openv$name$";

type AttrEntry = {
	type: "DIRECTORY" | "FILE" | "SYMLINK";
	uid: number;
	gid: number;
	mode: FileMode;
	ctime: number;
	mtime: number;
	atime: number;
	target?: string;
};

type AttrMap = Record<string, AttrEntry>;

type OpenFileState = {
	mount: string;
	path: string;
	flags: OpenFlags;
	position: number;
};

// Per-mount internal state for namespace isolation
type MountState = {
	rootHandle: FileSystemDirectoryHandle;
	dirCache: Map<string, FileSystemDirectoryHandle>;
	rootEntry: FsStats<typeof OPFS_NAMESPACE>;
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

function splitPath(path: string): string[] {
	return path === "/" ? [] : path.slice(1).split("/");
}

function parentPath(path: string): string {
	if (path === "/") return "/";
	const parts = splitPath(path);
	parts.pop();
	return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function baseName(path: string): string {
	if (path === "/") return "/";
	const parts = splitPath(path);
	return parts[parts.length - 1] ?? "/";
}

function canRead(flags: OpenFlags): boolean {
	return flags.includes("r") || flags.includes("+");
}

function canWrite(flags: OpenFlags): boolean {
	return flags.includes("w") || flags.includes("a") || flags.includes("+");
}

function shouldCreateOnOpen(flags: OpenFlags): boolean {
	return flags.includes("w") || flags.includes("a");
}

function shouldTruncateOnOpen(flags: OpenFlags): boolean {
	return flags.includes("w");
}

function isExclusiveCreate(flags: OpenFlags): boolean {
	return flags.includes("x");
}

function marshalName(name: string): string {
	if (name === INTERNAL_ATTRS_FILE || name.startsWith(SANITIZE_PREFIX)) {
		return `${SANITIZE_PREFIX}${name}`;
	}
	return name;
}

function unmarshalName(name: string): string {
	if (name.startsWith(SANITIZE_PREFIX)) {
		return name.slice(SANITIZE_PREFIX.length);
	}
	return name;
}

function mountMatches(path: string, mount: string): boolean {
	if (mount === "/") return true;
	return path === mount || path.startsWith(`${mount}/`);
}

function nowMs(): number {
	return Date.now();
}

function defaultEntry(type: "DIRECTORY" | "FILE" | "SYMLINK", mode: FileMode): AttrEntry {
	const t = nowMs();
	return {
		type,
		uid: 0,
		gid: 0,
		mode,
		ctime: t,
		mtime: t,
		atime: t,
	};
}

export class OPFS {
	#mountStates = new Map<string, MountState>();
	#roots = new Set<string>();
	#opQueue: Promise<void> = Promise.resolve();

	#openFiles: Map<number, OpenFileState> = new Map();

	#defaultRootPromise: Promise<FileSystemDirectoryHandle | null>;
	#nextRootPromise: Promise<FileSystemDirectoryHandle | null>;
	#nextMountPath: string | null = null;

	#encoder = new TextEncoder();

	constructor(rootHandle?: FileSystemDirectoryHandle | null) {
		this.#defaultRootPromise = rootHandle ? Promise.resolve(rootHandle) : this.#tryGetNavigatorRoot();
		this.#nextRootPromise = this.#defaultRootPromise;
	}

	async #tryGetNavigatorRoot(): Promise<FileSystemDirectoryHandle | null> {
		const nav = globalThis.navigator as (Navigator & {
			storage?: {
				getDirectory?: () => Promise<FileSystemDirectoryHandle>;
			};
		}) | undefined;
		if (!nav?.storage?.getDirectory) return null;
		try {
			return await nav.storage.getDirectory();
		} catch {
			return null;
		}
	}

	setRoot(dirHandle: FileSystemDirectoryHandle): void {
		this.#nextRootPromise = Promise.resolve(dirHandle);
	}

	/**
	 * Sets the path that the next root will be mounted at.
	 * This enables proper per-mount namespace isolation.
	 */
	setNextMountPath(path: string): void {
		this.#nextMountPath = path;
	}

	async #runSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#opQueue;
		let release!: () => void;
		this.#opQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async register(system: FileSystemVirtualComponent): Promise<void> {
		await system["party.openv.filesystem.virtual.create"](OPFS_NAMESPACE);
		await system["party.openv.filesystem.virtual.onstat"](OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.stat(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onlstat"]?.(OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.lstat(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onreadlink"]?.(OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.readlink(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onreaddir"](OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.readdir(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onmkdir"](OPFS_NAMESPACE,
			async (path: string, mode?: FileMode) => await this.#runSerialized(async () => await this.mkdir(normalizePath(path), mode))
		);
		await system["party.openv.filesystem.virtual.onrmdir"](OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.rmdir(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onmount"](OPFS_NAMESPACE,
			async (path: string, extra?: PlainParameter) => await this.#runSerialized(async () => await this.mount(normalizePath(path), extra as any))
		);
		await system["party.openv.filesystem.virtual.onunmount"](OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.unmount(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onopen"](OPFS_NAMESPACE,
			async (path: string, ofd: number, flags: OpenFlags, mode: FileMode) => await this.#runSerialized(async () => await this.open(normalizePath(path), ofd, flags, mode))
		);
		await system["party.openv.filesystem.virtual.onclose"](OPFS_NAMESPACE,
			async (ofd: number) => await this.#runSerialized(async () => await this.close(ofd))
		);
		await system["party.openv.filesystem.virtual.onread"](OPFS_NAMESPACE,
			async (ofd: number, length: number, position?: number) => await this.#runSerialized(async () => await this.read(ofd, length, position))
		);
		await system["party.openv.filesystem.virtual.onwrite"](OPFS_NAMESPACE,
			async (ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => await this.#runSerialized(async () => await this.write(ofd, buffer, offset, length, position))
		);
		await system["party.openv.filesystem.virtual.oncreate"](OPFS_NAMESPACE,
			async (path: string, mode?: FileMode) => await this.#runSerialized(async () => await this.create(normalizePath(path), mode))
		);
		await system["party.openv.filesystem.virtual.onunlink"](OPFS_NAMESPACE,
			async (path: string) => await this.#runSerialized(async () => await this.unlink(normalizePath(path)))
		);
		await system["party.openv.filesystem.virtual.onsymlink"]?.(OPFS_NAMESPACE,
			async (target: string, path: string, mode?: FileMode) => await this.#runSerialized(async () => await this.symlink(target, normalizePath(path), mode))
		);
		await system["party.openv.filesystem.virtual.onchmod"]?.(OPFS_NAMESPACE,
			async (path: string, mode: FileMode) => await this.#runSerialized(async () => await this.chmod(normalizePath(path), mode))
		);
		await system["party.openv.filesystem.virtual.onchown"]?.(OPFS_NAMESPACE,
			async (path: string, uid: number, gid: number) => await this.#runSerialized(async () => await this.chown(normalizePath(path), uid, gid))
		);
		await system["party.openv.filesystem.virtual.onrename"](OPFS_NAMESPACE,
			async (oldPath: string, newPath: string) => await this.#runSerialized(async () => await this.rename(normalizePath(oldPath), normalizePath(newPath)))
		);
		await system["party.openv.filesystem.virtual.ontruncate"]?.(OPFS_NAMESPACE,
			async (path: string, length: number) => await this.#runSerialized(async () => await this.truncate(normalizePath(path), length))
		);
		await system["party.openv.filesystem.virtual.onftruncate"]?.(OPFS_NAMESPACE,
			async (ofd: number, length: number) => await this.#runSerialized(async () => await this.ftruncate(ofd, length))
		);
		await system["party.openv.filesystem.virtual.onsettimes"]?.(OPFS_NAMESPACE,
			async (path: string, atim: number, mtim: number, ctim: number) => await this.#runSerialized(async () => await this.settimes(normalizePath(path), atim, mtim, ctim))
		);
		await system["party.openv.filesystem.virtual.onlsettimes"]?.(OPFS_NAMESPACE,
			async (path: string, atim: number, mtim: number, ctim: number) => await this.#runSerialized(async () => await this.lsettimes(normalizePath(path), atim, mtim, ctim))
		);
	}

	closestMountpoint(path: string): string | null {
		let closest: string | null = null;
		for (const root of this.#roots) {
			if (!mountMatches(path, root)) continue;
			if (closest === null || root.length > closest.length) {
				closest = root;
			}
		}
		return closest;
	}

	async mount(path: string, extra?: "opfs" | FileSystemDirectoryHandle): Promise<void> {
		if (extra !== undefined) {
			if (extra === "opfs") {
				const root = await this.#tryGetNavigatorRoot();
				if (!root) throw new Error("OPFS root is unavailable on this platform.");
				this.setRoot(root);
			} else {
				if (!(extra instanceof FileSystemDirectoryHandle)) {
					throw new Error("invalid extra parameter for OPFS mount");
				}
				this.setRoot(extra);
			}
		};
		const root = await this.#nextRootPromise;
		this.#nextRootPromise = this.#defaultRootPromise;

		if (!root) {
			throw new Error("OPFS root is unavailable. Call setRoot(directoryHandle) before mounting.");
		}

		const mountPath = path;
		this.#roots.add(mountPath);
		const t = nowMs();
		const rootEntry: FsStats<typeof OPFS_NAMESPACE> = {
			type: "DIRECTORY",
			size: 0,
			atime: t,
			mtime: t,
			ctime: t,
			name: baseName(mountPath),
			uid: 0,
			gid: 0,
			mode: 0o777,
			node: OPFS_NAMESPACE,
		};

		// Create isolated per-mount state
		this.#mountStates.set(mountPath, {
			rootHandle: root,
			dirCache: new Map(),
			rootEntry,
		});
	}

	async unmount(path: string): Promise<void> {
		if (!this.#mountStates.has(path)) {
			throw new Error(`ENOENT: mount path not found '${path}'`);
		}
		this.#mountStates.delete(path);
		this.#roots.delete(path);

		for (const [ofd, state] of this.#openFiles) {
			if (state.mount === path) {
				this.#openFiles.delete(ofd);
			}
		}
	}

	async stat(path: string): Promise<FsStats<typeof OPFS_NAMESPACE>> {
		return this.#statInternal(path, true);
	}

	async lstat(path: string): Promise<FsStats<typeof OPFS_NAMESPACE>> {
		return this.#statInternal(path, false);
	}

	async readlink(path: string): Promise<string> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}

		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentPath(resolved.relativePath));
		const segment = splitPath(resolved.relativePath).at(-1);
		if (!segment) {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}
		const wireName = marshalName(segment);
		const attrs = await this.#readAttrs(parent);
		const attr = attrs[wireName];
		if (!attr || attr.type !== "SYMLINK" || typeof attr.target !== "string") {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}
		return attr.target;
	}

	async #statInternal(path: string, followSymlink: boolean): Promise<FsStats<typeof OPFS_NAMESPACE>> {
		const resolved = this.#resolvePath(path);
		if (!resolved) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}

		if (resolved.relativePath === "/") {
			return resolved.mountState.rootEntry;
		}

		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentPath(resolved.relativePath));
		const segment = splitPath(resolved.relativePath).at(-1);
		if (!segment) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}
		const wireName = marshalName(segment);

		const kind = await this.#entryKind(parent, wireName);
		if (!kind) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}

		const attrs = await this.#readAttrs(parent);
		const attr = attrs[wireName];
		if (attr?.type === "SYMLINK") {
			if (!followSymlink) {
				const t = nowMs();
				return {
					type: "SYMLINK",
					size: attr.target?.length ?? 0,
					atime: attr.atime ?? t,
					mtime: attr.mtime ?? t,
					ctime: attr.ctime ?? t,
					name: segment,
					uid: attr.uid ?? 0,
					gid: attr.gid ?? 0,
					mode: attr.mode ?? 0o120777,
					node: OPFS_NAMESPACE,
				};
			}
			if (!attr.target) {
				throw new Error(`ENOENT: broken symlink, stat '${path}'`);
			}
			const targetPath = attr.target.startsWith("/")
				? normalizePath(attr.target)
				: normalizePath(`${parentPath(path)}/${attr.target}`);
			return this.#statInternal(targetPath, true);
		}

		if (kind === "FILE") {
			const fileHandle = await parent.getFileHandle(wireName);
			const file = await fileHandle.getFile();
			const fallbackTime = file.lastModified;
			return {
				type: "FILE",
				size: file.size,
				atime: attr?.atime ?? fallbackTime,
				mtime: attr?.mtime ?? fallbackTime,
				ctime: attr?.ctime ?? fallbackTime,
				name: segment,
				uid: attr?.uid ?? 0,
				gid: attr?.gid ?? 0,
				mode: attr?.mode ?? 0o666,
				node: OPFS_NAMESPACE,
			};
		}

		const t = nowMs();
		return {
			type: "DIRECTORY",
			size: 0,
			atime: attr?.atime ?? t,
			mtime: attr?.mtime ?? t,
			ctime: attr?.ctime ?? t,
			name: segment,
			uid: attr?.uid ?? 0,
			gid: attr?.gid ?? 0,
			mode: attr?.mode ?? 0o777,
			node: OPFS_NAMESPACE,
		};
	}

	async readdir(path: string): Promise<string[]> {
		const resolved = this.#resolvePath(path);
		if (!resolved) {
			throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
		}
		const dir = await this.#getDirectoryHandleByRelativePath(resolved.mount, resolved.relativePath);
		const entries: string[] = [];

		for await (const [name] of dir.entries()) {
			if (name === INTERNAL_ATTRS_FILE) continue;
			entries.push(unmarshalName(name));
		}
		const attrs = await this.#readAttrs(dir);
		for (const [wireName, attr] of Object.entries(attrs)) {
			if (attr.type !== "SYMLINK") continue;
			const name = unmarshalName(wireName);
			if (!entries.includes(name)) entries.push(name);
		}
		return entries;
	}

	async mkdir(path: string, mode?: FileMode): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
		}

		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);

		if (await this.#entryKind(parent, wireName)) {
			throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
		}

		await parent.getDirectoryHandle(wireName, { create: true });
		await this.#upsertAttr(parent, wireName, {
			...defaultEntry("DIRECTORY", mode ?? 0o777),
			mtime: nowMs(),
		});

		await this.#touchDirMetadata(resolved.mount, parentRel);
		this.#invalidateDirCache(resolved.mount, parentRel, false);
		this.#invalidateDirCache(resolved.mount, resolved.relativePath, true);
	}

	async rmdir(path: string): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EINVAL: cannot remove mount root, rmdir '${path}'`);
		}

		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		const dir = await this.#tryGetDirectoryHandle(parent, wireName);
		if (!dir) {
			throw new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
		}

		for await (const [name] of dir.entries()) {
			if (name === INTERNAL_ATTRS_FILE) continue;
			throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
		}

		await parent.removeEntry(wireName, { recursive: false });
		await this.#deleteAttr(parent, wireName);
		await this.#touchDirMetadata(resolved.mount, parentRel);

		this.#invalidateDirCache(resolved.mount, parentRel, false);
		this.#invalidateDirCache(resolved.mount, resolved.relativePath, true);
	}

	async create(path: string, mode?: FileMode): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EEXIST: file already exists, create '${path}'`);
		}

		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);

		if (await this.#entryKind(parent, wireName)) {
			throw new Error(`EEXIST: file already exists, create '${path}'`);
		}

		await parent.getFileHandle(wireName, { create: true });
		await this.#upsertAttr(parent, wireName, defaultEntry("FILE", mode ?? 0o666));
		await this.#touchDirMetadata(resolved.mount, parentRel);

		this.#invalidateDirCache(resolved.mount, parentRel, false);
	}

	async symlink(target: string, path: string, mode?: FileMode): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EEXIST: file already exists, symlink '${path}'`);
		}
		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		if (await this.#entryKind(parent, wireName)) {
			throw new Error(`EEXIST: file already exists, symlink '${path}'`);
		}
		await this.#upsertAttr(parent, wireName, {
			...defaultEntry("SYMLINK", (mode ?? 0o777) | 0o120000),
			target,
		});
		await this.#touchDirMetadata(resolved.mount, parentRel);
		this.#invalidateDirCache(resolved.mount, parentRel, false);
	}

	async chmod(path: string, mode: FileMode): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
		}
		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		const attrs = await this.#readAttrs(parent);
		const prev = attrs[wireName];
		if (!prev) {
			throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
		}
		const typeBits = prev.mode & 0o170000;
		attrs[wireName] = {
			...prev,
			mode: typeBits | (mode & 0o777),
			ctime: nowMs(),
			mtime: nowMs(),
		};
		await this.#writeAttrs(parent, attrs);
	}

	async chown(path: string, uid: number, gid: number): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`ENOENT: no such file or directory, chown '${path}'`);
		}
		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		const attrs = await this.#readAttrs(parent);
		const prev = attrs[wireName];
		if (!prev) {
			throw new Error(`ENOENT: no such file or directory, chown '${path}'`);
		}
		attrs[wireName] = {
			...prev,
			uid,
			gid,
			ctime: nowMs(),
			mtime: nowMs(),
		};
		await this.#writeAttrs(parent, attrs);
	}

	async unlink(path: string): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
		}

		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);

		const attrs = await this.#readAttrs(parent);
		const attr = attrs[wireName];
		if (attr?.type === "SYMLINK") {
			await this.#deleteAttr(parent, wireName);
			await this.#touchDirMetadata(resolved.mount, parentRel);
			this.#invalidateDirCache(resolved.mount, parentRel, false);
			return;
		}
		const file = await this.#tryGetFileHandle(parent, wireName);
		if (!file) {
			const dir = await this.#tryGetDirectoryHandle(parent, wireName);
			if (dir) {
				throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
			}
			throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
		}

		await parent.removeEntry(wireName, { recursive: false });
		await this.#deleteAttr(parent, wireName);
		await this.#touchDirMetadata(resolved.mount, parentRel);

		this.#invalidateDirCache(resolved.mount, parentRel, false);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldResolved = this.#resolvePath(oldPath);
		const newResolved = this.#resolvePath(newPath);
		if (!oldResolved || !newResolved) {
			throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
		}
		if (oldResolved.mount !== newResolved.mount) {
			throw new Error(`EXDEV: cross-device link not permitted, rename '${oldPath}' -> '${newPath}'`);
		}
		if (oldResolved.relativePath === "/" || newResolved.relativePath === "/") {
			throw new Error(`EINVAL: cannot rename mount root, rename '${oldPath}' -> '${newPath}'`);
		}

		const oldParentRel = parentPath(oldResolved.relativePath);
		const newParentRel = parentPath(newResolved.relativePath);
		const oldSegment = baseName(oldResolved.relativePath);
		const newSegment = baseName(newResolved.relativePath);
		const oldWire = marshalName(oldSegment);
		const newWire = marshalName(newSegment);

		const oldParent = await this.#getDirectoryHandleByRelativePath(oldResolved.mount, oldParentRel);
		const newParent = await this.#getDirectoryHandleByRelativePath(newResolved.mount, newParentRel);

		const oldKind = await this.#entryKind(oldParent, oldWire);
		if (!oldKind) {
			throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
		}
		const newKind = await this.#entryKind(newParent, newWire);
		if (newKind) {
			throw new Error(`EEXIST: file already exists, rename '${newPath}'`);
		}

		const oldAttrs = await this.#readAttrs(oldParent);
		const carriedAttr = oldAttrs[oldWire] ?? defaultEntry(
			oldKind,
			oldKind === "FILE" ? 0o666 : oldKind === "DIRECTORY" ? 0o777 : 0o120777,
		);

		if (oldKind !== "SYMLINK") {
			await this.#copyEntry(oldParent, oldWire, newParent, newWire, oldKind);
			await oldParent.removeEntry(oldWire, { recursive: true });
		}

		await this.#deleteAttr(oldParent, oldWire);
		await this.#upsertAttr(newParent, newWire, {
			...carriedAttr,
			mtime: nowMs(),
		});

		await this.#touchDirMetadata(oldResolved.mount, oldParentRel);
		await this.#touchDirMetadata(newResolved.mount, newParentRel);
		this.#invalidateDirCache(oldResolved.mount, "/", true);
	}

	async open(path: string, ofd: number, flags: OpenFlags, mode: FileMode): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
		}

		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);

		const kind = await this.#entryKind(parent, wireName);
		const attrs = await this.#readAttrs(parent);
		const attr = attrs[wireName];
		if (attr?.type === "SYMLINK") {
			throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
		}
		if (!kind) {
			if (!shouldCreateOnOpen(flags)) {
				throw new Error(`ENOENT: no such file or directory, open '${path}'`);
			}
			await parent.getFileHandle(wireName, { create: true });
			await this.#upsertAttr(parent, wireName, defaultEntry("FILE", mode ?? 0o666));
			await this.#touchDirMetadata(resolved.mount, parentRel);
			this.#invalidateDirCache(resolved.mount, parentRel, false);
		} else if (kind === "DIRECTORY") {
			throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
		} else if (isExclusiveCreate(flags) && shouldCreateOnOpen(flags)) {
			throw new Error(`EEXIST: file already exists, open '${path}'`);
		}

		if (shouldTruncateOnOpen(flags)) {
			const fileHandle = await parent.getFileHandle(wireName);
			const writable = await fileHandle.createWritable();
			await writable.truncate(0);
			await writable.close();
			await this.#touchFileMetadata(parent, wireName, true);
		}

		this.#openFiles.set(ofd, {
			mount: resolved.mount,
			path: resolved.relativePath,
			flags,
			position: 0,
		});
		await this.#touchFileMetadata(parent, wireName, false, true);
	}

	async close(ofd: number): Promise<void> {
		const open = this.#openFiles.get(ofd);
		if (!open) {
			throw new Error(`EBADF: bad file descriptor, close '${ofd}'`);
		}
		this.#openFiles.delete(ofd);
	}

	async read(ofd: number, length: number, position?: number): Promise<Uint8Array> {
		const open = this.#openFiles.get(ofd);
		if (!open) {
			throw new Error(`EBADF: bad file descriptor, read '${ofd}'`);
		}
		if (!canRead(open.flags)) {
			throw new Error(`EBADF: file not open for reading, read '${ofd}'`);
		}

		const parentRel = parentPath(open.path);
		const segment = baseName(open.path);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(open.mount, parentRel);
		const fileHandle = await this.#tryGetFileHandle(parent, wireName);
		if (!fileHandle) {
			throw new Error(`ENOENT: no such file or directory, read '${ofd}'`);
		}

		const file = await fileHandle.getFile();
		const data = new Uint8Array(await file.arrayBuffer());
		const readPos = position ?? open.position;
		const end = Math.min(readPos + length, data.length);
		const out = data.slice(readPos, end);
		if (position === undefined) {
			open.position = end;
		}

		await this.#touchFileMetadata(parent, wireName, false, true);
		return out;
	}

	async write(ofd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<number> {
        const open = this.#openFiles.get(ofd);
		if (!open) {
			throw new Error(`EBADF: bad file descriptor, write '${ofd}'`);
		}
		if (!canWrite(open.flags)) {
			throw new Error(`EBADF: file not open for writing, write '${ofd}'`);
		}

		const parentRel = parentPath(open.path);
		const segment = baseName(open.path);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(open.mount, parentRel);
		const fileHandle = await this.#tryGetFileHandle(parent, wireName);
		if (!fileHandle) {
			throw new Error(`ENOENT: no such file or directory, write '${ofd}'`);
		}

		const file = await fileHandle.getFile();
		const existing = new Uint8Array(await file.arrayBuffer());

		const srcOffset = offset ?? 0;
		const srcLength = length ?? (buffer.length - srcOffset);
		const src = buffer.subarray(srcOffset, srcOffset + srcLength);

		let writePos: number;
		if (position === null || open.flags.includes("a")) {
			writePos = existing.length;
		} else {
			writePos = position ?? open.position;
		}

		const needed = writePos + src.length;
		let next = existing;
		if (needed > existing.length) {
			next = new Uint8Array(needed);
			next.set(existing, 0);
		}
		next.set(src, writePos);

		const writable = await fileHandle.createWritable();
		await writable.write(next);
		await writable.close();

		open.position = writePos + src.length;
		await this.#touchFileMetadata(parent, wireName, true, true);
		return src.length;
	}

	async truncate(path: string, length: number): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`EISDIR: illegal operation on a directory, truncate '${path}'`);
		}
		if (!Number.isFinite(length) || length < 0) {
			throw new Error(`EINVAL: invalid truncate length '${length}'`);
		}
		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		const kind = await this.#entryKind(parent, wireName);
		if (!kind) {
			throw new Error(`ENOENT: no such file or directory, truncate '${path}'`);
		}
		if (kind !== "FILE") {
			throw new Error(`EISDIR: illegal operation on a directory, truncate '${path}'`);
		}
		const fileHandle = await parent.getFileHandle(wireName);
		const writable = await fileHandle.createWritable();
		await writable.truncate(Math.trunc(length));
		await writable.close();
		await this.#touchFileMetadata(parent, wireName, true, true);
	}

	async ftruncate(ofd: number, length: number): Promise<void> {
		const open = this.#openFiles.get(ofd);
		if (!open) {
			throw new Error(`EBADF: bad file descriptor, ftruncate '${ofd}'`);
		}
		if (!canWrite(open.flags)) {
			throw new Error(`EBADF: file not open for writing, ftruncate '${ofd}'`);
		}
		if (!Number.isFinite(length) || length < 0) {
			throw new Error(`EINVAL: invalid truncate length '${length}'`);
		}
		const parentRel = parentPath(open.path);
		const segment = baseName(open.path);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(open.mount, parentRel);
		const fileHandle = await this.#tryGetFileHandle(parent, wireName);
		if (!fileHandle) {
			throw new Error(`ENOENT: no such file or directory, ftruncate '${ofd}'`);
		}
		const writable = await fileHandle.createWritable();
		await writable.truncate(Math.trunc(length));
		await writable.close();
		if (open.position > length) {
			open.position = Math.trunc(length);
		}
		await this.#touchFileMetadata(parent, wireName, true, true);
	}

	async settimes(path: string, atim: number, mtim: number, ctim: number): Promise<void> {
		const resolved = this.#resolvePath(path);
		if (!resolved || resolved.relativePath === "/") {
			throw new Error(`ENOENT: no such file or directory, settimes '${path}'`);
		}
		const parentRel = parentPath(resolved.relativePath);
		const segment = baseName(resolved.relativePath);
		const wireName = marshalName(segment);
		const parent = await this.#getDirectoryHandleByRelativePath(resolved.mount, parentRel);
		const attrs = await this.#readAttrs(parent);
		const prev = attrs[wireName];
		if (!prev) {
			const kind = await this.#entryKind(parent, wireName);
			if (!kind) {
				throw new Error(`ENOENT: no such file or directory, settimes '${path}'`);
			}
			attrs[wireName] = {
				...defaultEntry(kind, kind === "FILE" ? 0o666 : kind === "DIRECTORY" ? 0o777 : 0o120777),
				atime: atim,
				mtime: mtim,
				ctime: ctim,
			};
		} else {
			attrs[wireName] = {
				...prev,
				atime: atim,
				mtime: mtim,
				ctime: ctim,
			};
		}
		await this.#writeAttrs(parent, attrs);
	}

	async lsettimes(path: string, atim: number, mtim: number, ctim: number): Promise<void> {
		await this.settimes(path, atim, mtim, ctim);
	}

	async #copyEntry(
		srcParent: FileSystemDirectoryHandle,
		srcName: string,
		dstParent: FileSystemDirectoryHandle,
		dstName: string,
		kind: "DIRECTORY" | "FILE" | "SYMLINK",
	): Promise<void> {
		if (kind === "SYMLINK") {
			return;
		}
		if (kind === "FILE") {
			const srcFile = await srcParent.getFileHandle(srcName);
			const srcBlob = await (await srcFile.getFile()).arrayBuffer();
			const dstFile = await dstParent.getFileHandle(dstName, { create: true });
			const writable = await dstFile.createWritable();
			await writable.write(srcBlob);
			await writable.close();
			return;
		}

		const srcDir = await srcParent.getDirectoryHandle(srcName);
		const dstDir = await dstParent.getDirectoryHandle(dstName, { create: true });

		const srcAttrs = await this.#readAttrs(srcDir);
		await this.#writeAttrs(dstDir, srcAttrs);

		for await (const [name, handle] of srcDir.entries()) {
			if (name === INTERNAL_ATTRS_FILE) continue;
			await this.#copyEntry(srcDir, name, dstDir, name, handle.kind === "file" ? "FILE" : "DIRECTORY");
		}
	}

	#resolvePath(path: string): { mount: string; mountState: MountState; relativePath: string } | null {
		const mount = this.closestMountpoint(path);
		if (!mount) return null;

		const mountState = this.#mountStates.get(mount);
		if (!mountState) return null;

		if (mount === "/") {
			const rel = path === "/" ? "/" : normalizePath(path);
			return { mount, mountState, relativePath: rel };
		}

		if (!mountMatches(path, mount)) return null;
		const suffix = path.slice(mount.length);
		const rel = suffix === "" ? "/" : normalizePath(suffix);
		return { mount, mountState, relativePath: rel };
	}

	async #getDirectoryHandleByRelativePath(mount: string, relativePath: string, symlinkHops: number = 0): Promise<FileSystemDirectoryHandle> {
		const mountState = this.#mountStates.get(mount);
		if (!mountState) {
			throw new Error(`ENOENT: mount path not found '${mount}'`);
		}

		const cacheKey = relativePath;
		const cached = mountState.dirCache.get(cacheKey);
		if (cached) return cached;

		if (relativePath === "/") {
			mountState.dirCache.set(cacheKey, mountState.rootHandle);
			return mountState.rootHandle;
		}

		let current = mountState.rootHandle;
		let resolvedPrefix = "/";
		const remaining = [...splitPath(relativePath)];
		while (remaining.length > 0) {
			const part = remaining.shift()!;
			const wireName = marshalName(part);
			const childDir = await this.#tryGetDirectoryHandle(current, wireName);
			if (childDir) {
				current = childDir;
				resolvedPrefix = normalizePath(`${resolvedPrefix}/${part}`);
				continue;
			}

			const attrs = await this.#readAttrs(current);
			const attr = attrs[wireName];
			if (attr?.type === "SYMLINK" && typeof attr.target === "string") {
				const nextHops = symlinkHops + 1;
				if (nextHops > 40) {
					throw new Error(`ELOOP: too many levels of symbolic links, stat '${relativePath}'`);
				}
				const targetPath = attr.target.startsWith("/")
					? normalizePath(attr.target)
					: normalizePath(`${resolvedPrefix}/${attr.target}`);
				const suffix = remaining.length > 0 ? `/${remaining.join("/")}` : "";
				const redirected = normalizePath(`${targetPath}${suffix}`);
				return await this.#getDirectoryHandleByRelativePath(mount, redirected, nextHops);
			}

			throw new Error(`ENOENT: no such file or directory, stat '${relativePath}'`);
		}
		mountState.dirCache.set(cacheKey, current);
		return current;
	}

	#invalidateDirCache(mount: string, relativePath: string, descendants: boolean): void {
		const mountState = this.#mountStates.get(mount);
		if (!mountState) return;

		const normalized = relativePath === "/" ? "/" : relativePath.replace(/\/+$/, "");
		for (const key of Array.from(mountState.dirCache.keys())) {
			if (key === normalized) {
				mountState.dirCache.delete(key);
				continue;
			}
			if (!descendants) continue;
			if (normalized === "/" && key.startsWith("/")) {
				mountState.dirCache.delete(key);
				continue;
			}
			if (normalized !== "/" && key.startsWith(`${normalized}/`)) {
				mountState.dirCache.delete(key);
			}
		}
	}

	async #entryKind(parent: FileSystemDirectoryHandle, name: string): Promise<"DIRECTORY" | "FILE" | "SYMLINK" | null> {
		if (name === INTERNAL_ATTRS_FILE) return null;
		if (await this.#tryGetFileHandle(parent, name)) return "FILE";
		if (await this.#tryGetDirectoryHandle(parent, name)) return "DIRECTORY";
		const attrs = await this.#readAttrs(parent);
		const attr = attrs[name];
		if (attr?.type === "SYMLINK") return "SYMLINK";
		return null;
	}

	async #tryGetFileHandle(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
		try {
			return await parent.getFileHandle(name);
		} catch {
			return null;
		}
	}

	async #tryGetDirectoryHandle(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
		try {
			return await parent.getDirectoryHandle(name);
		} catch {
			return null;
		}
	}

	async #readAttrs(dir: FileSystemDirectoryHandle): Promise<AttrMap> {
		const handle = await this.#tryGetFileHandle(dir, INTERNAL_ATTRS_FILE);
		if (!handle) return {};

		try {
			const text = await (await handle.getFile()).text();
			if (!text.trim()) return {};
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== "object") return {};

			const out: AttrMap = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (!v || typeof v !== "object") continue;
				const e = v as Partial<AttrEntry>;
				if (e.type !== "FILE" && e.type !== "DIRECTORY" && e.type !== "SYMLINK") continue;
				out[k] = {
					type: e.type,
					uid: typeof e.uid === "number" ? e.uid : 0,
					gid: typeof e.gid === "number" ? e.gid : 0,
					mode: typeof e.mode === "number" ? e.mode : (e.type === "FILE" ? 0o666 : e.type === "DIRECTORY" ? 0o777 : 0o120777),
					ctime: typeof e.ctime === "number" ? e.ctime : nowMs(),
					mtime: typeof e.mtime === "number" ? e.mtime : nowMs(),
					atime: typeof e.atime === "number" ? e.atime : nowMs(),
					target: typeof e.target === "string" ? e.target : undefined,
				};
			}
			return out;
		} catch {
			return {};
		}
	}

	async #writeAttrs(dir: FileSystemDirectoryHandle, attrs: AttrMap): Promise<void> {
		const handle = await dir.getFileHandle(INTERNAL_ATTRS_FILE, { create: true });
		const writable = await handle.createWritable();
		await writable.write(this.#encoder.encode(JSON.stringify(attrs)));
		await writable.close();
	}

	async #upsertAttr(dir: FileSystemDirectoryHandle, childName: string, entry: AttrEntry): Promise<void> {
		const attrs = await this.#readAttrs(dir);
		attrs[childName] = entry;
		await this.#writeAttrs(dir, attrs);
	}

	async #deleteAttr(dir: FileSystemDirectoryHandle, childName: string): Promise<void> {
		const attrs = await this.#readAttrs(dir);
		if (!(childName in attrs)) return;
		delete attrs[childName];
		await this.#writeAttrs(dir, attrs);
	}

	async #touchDirMetadata(mount: string, relativeDirPath: string): Promise<void> {
		const mountState = this.#mountStates.get(mount);
		if (!mountState) return;

		if (relativeDirPath === "/") {
			mountState.rootEntry.mtime = nowMs();
			return;
		}
		const parentRel = parentPath(relativeDirPath);
		const seg = baseName(relativeDirPath);
		const parentDir = await this.#getDirectoryHandleByRelativePath(mount, parentRel);
		const wireName = marshalName(seg);
		const attrs = await this.#readAttrs(parentDir);
		const prev = attrs[wireName];
		if (prev && prev.type !== "DIRECTORY") {
			// Path aliases through symlinks (e.g. /lib -> /usr/lib) may route directory
			// updates through a symlink name. Never coerce a symlink entry into a directory.
			return;
		}
		const base = prev ?? defaultEntry("DIRECTORY", 0o777);
		attrs[wireName] = {
			...base,
			type: "DIRECTORY",
			mtime: nowMs(),
			atime: base.atime,
		};
		await this.#writeAttrs(parentDir, attrs);
	}

	async #touchFileMetadata(parent: FileSystemDirectoryHandle, wireName: string, mtime: boolean, atime = false): Promise<void> {
		const attrs = await this.#readAttrs(parent);
		const prev = attrs[wireName] ?? defaultEntry("FILE", 0o666);
		attrs[wireName] = {
			...prev,
			type: "FILE",
			mtime: mtime ? nowMs() : prev.mtime,
			atime: atime ? nowMs() : prev.atime,
		};
		await this.#writeAttrs(parent, attrs);
	}

	supports(ns: "party.openv.impl.opfs"): Promise<"party.openv.impl.opfs/0.1.0">;
	supports(ns: "party.openv.impl.opfs/0.1.0"): Promise<"party.openv.impl.opfs/0.1.0">;
	async supports(ns: string): Promise<string | null> {
		if (ns === "party.openv.impl.opfs" || ns === "party.openv.impl.opfs/0.1.0") {
			return "party.openv.impl.opfs/0.1.0";
		}
		return null;
	}
}

export type OpfsSystemComponent = import("@openv-project/openv-api").SystemComponent<"party.openv.impl.opfs/0.1.0", "party.openv.impl.opfs">;
