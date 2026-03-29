import type {
    FileSystemCoreComponent,
    FileSystemReadOnlyComponent,
    FileSystemReadWriteComponent,
    RegistryEntryWatchEvent,
    RegistryKeyWatchEvent,
    RegistryValue,
} from "@openv-project/openv-api";
import type { CoreRegistry } from "../syscall/registry";

const FORMAT = "party.openv.registry.file.system/0.2.0" as const;

type FsSystem = FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent;

export type RegistryFsMapEntry = {
    baseKey: string;
    storeDir: string;
};

type MetaRow = {
    id: "map";
    format: string;
    baseKey: string;
    storeDir: string;
    updatedAt: number;
};

type KeyRow = {
    path: string;
    parent: string | null;
};

type EntryRow = {
    id: string;
    key: string;
    entry: string;
    value: RegistryValue;
};

type Snapshot = {
    keys: KeyRow[];
    entries: EntryRow[];
};

type StorePaths = {
    meta: string;
    keys: string;
    entries: string;
    byKey: string;
    byKeyEntry: string;
};

type PersistContext = {
    baseKey: string;
    storeDir: string;
    paths: StorePaths;
};

let persistenceStarted = false;

function normalizePath(path: string): string {
    if (!path.startsWith("/")) path = `/${path}`;
    return path.replace(/\/+$/, "") || "/";
}

function isWithinBase(path: string, baseKey: string): boolean {
    const base = normalizePath(baseKey);
    const p = normalizePath(path);
    return p === base || p.startsWith(`${base}/`);
}

function parentPath(path: string): string | null {
    if (path === "/") return null;
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return "/";
    return path.slice(0, idx);
}

function depth(path: string): number {
    if (path === "/") return 0;
    return path.split("/").filter(Boolean).length;
}

function uuid(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function b64urlEncode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): string {
    const padded = input + "===".slice((input.length + 3) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function keyPathToIndexName(keyPath: string): string {
    return b64urlEncode(normalizePath(keyPath));
}

function keyEntryToIndexName(keyPath: string, entry: string): string {
    return b64urlEncode(`${normalizePath(keyPath)}\0${entry}`);
}

function parseKeyEntryIndexName(name: string): { key: string; entry: string } | null {
    try {
        const decoded = b64urlDecode(name);
        const idx = decoded.indexOf("\0");
        if (idx === -1) return null;
        return { key: decoded.slice(0, idx), entry: decoded.slice(idx + 1) };
    } catch {
        return null;
    }
}

function resolveStorePaths(storeDir: string): StorePaths {
    const root = normalizePath(storeDir);
    return {
        meta: `${root}/meta.json`,
        keys: `${root}/keys`,
        entries: `${root}/entries`,
        byKey: `${root}/indexes/by-key`,
        byKeyEntry: `${root}/indexes/by-key-entry`,
    };
}

function resolveContexts(map: RegistryFsMapEntry[]): PersistContext[] {
    return map.map(entry => {
        const baseKey = normalizePath(entry.baseKey);
        const storeDir = normalizePath(entry.storeDir);
        return { baseKey, storeDir, paths: resolveStorePaths(storeDir) };
    });
}

async function ensureDir(fs: FsSystem, path: string): Promise<void> {
    if (path === "/" || path === "") return;
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current += `/${part}`;
        try {
            const stat = await fs["party.openv.filesystem.read.stat"](current);
            if (stat.type !== "DIRECTORY") {
                throw new Error(`Path exists but is not directory: ${current}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("ENOENT")) throw err;
            try {
                await fs["party.openv.filesystem.write.mkdir"](current, 0o755);
            } catch (mkdirErr) {
                const mkdirMsg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
                if (!mkdirMsg.includes("EEXIST")) throw mkdirErr;
            }
        }
    }
}

async function writeText(fs: FsSystem, path: string, text: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    await ensureDir(fs, dir);
    const fd = await fs["party.openv.filesystem.open"](path, "w", 0o644);
    try {
        const data = new TextEncoder().encode(text);
        await fs["party.openv.filesystem.write.write"](fd, data, 0, data.length, 0);
    } finally {
        await fs["party.openv.filesystem.close"](fd);
    }
}

async function readText(fs: FsSystem, path: string): Promise<string | null> {
    try {
        const stat = await fs["party.openv.filesystem.read.stat"](path);
        const fd = await fs["party.openv.filesystem.open"](path, "r", 0o444);
        try {
            const data = await fs["party.openv.filesystem.read.read"](fd, stat.size, 0);
            return new TextDecoder().decode(data);
        } finally {
            await fs["party.openv.filesystem.close"](fd);
        }
    } catch {
        return null;
    }
}

async function writeJson(fs: FsSystem, path: string, data: unknown): Promise<void> {
    await writeText(fs, path, JSON.stringify(data));
}

async function readJson<T>(fs: FsSystem, path: string): Promise<T | null> {
    const text = await readText(fs, path);
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

async function deletePath(fs: FsSystem, path: string): Promise<void> {
    try {
        const stat = await fs["party.openv.filesystem.read.stat"](path);
        if (stat.type === "DIRECTORY") {
            const entries = await fs["party.openv.filesystem.read.readdir"](path);
            for (const name of entries) await deletePath(fs, `${path}/${name}`);
            await fs["party.openv.filesystem.write.rmdir"](path);
        } else {
            await fs["party.openv.filesystem.write.unlink"](path);
        }
    } catch {
        return;
    }
}

async function listFileNames(fs: FsSystem, dir: string): Promise<string[]> {
    try {
        const names = await fs["party.openv.filesystem.read.readdir"](dir);
        const out: string[] = [];
        for (const name of names) {
            const st = await fs["party.openv.filesystem.read.lstat"]
                ? await fs["party.openv.filesystem.read.lstat"](`${dir}/${name}`)
                : await fs["party.openv.filesystem.read.stat"](`${dir}/${name}`);
            if (st.type === "FILE" || st.type === "SYMLINK") out.push(name);
        }
        return out;
    } catch {
        return [];
    }
}

async function writeMeta(fs: FsSystem, ctx: PersistContext): Promise<void> {
    const row: MetaRow = {
        id: "map",
        format: FORMAT,
        baseKey: ctx.baseKey,
        storeDir: ctx.storeDir,
        updatedAt: Date.now(),
    };
    await writeJson(fs, ctx.paths.meta, row);
}

async function readSnapshot(fs: FsSystem, ctx: PersistContext): Promise<Snapshot> {
    const meta = await readJson<MetaRow>(fs, ctx.paths.meta);
    if (!meta || meta.baseKey !== ctx.baseKey || meta.storeDir !== ctx.storeDir) {
        return { keys: [], entries: [] };
    }
    const [keyIds, entryIds] = await Promise.all([
        listFileNames(fs, ctx.paths.keys),
        listFileNames(fs, ctx.paths.entries),
    ]);
    const keysRaw = await Promise.all(keyIds.map(name => readJson<KeyRow>(fs, `${ctx.paths.keys}/${name}`)));
    const entriesRaw = await Promise.all(entryIds.map(name => readJson<EntryRow>(fs, `${ctx.paths.entries}/${name}`)));
    return {
        keys: keysRaw.filter((k): k is KeyRow => !!k && isWithinBase(k.path, ctx.baseKey)),
        entries: entriesRaw.filter((e): e is EntryRow => !!e && isWithinBase(e.key, ctx.baseKey)),
    };
}

async function writeKeyRow(fs: FsSystem, ctx: PersistContext, row: KeyRow): Promise<void> {
    await writeJson(fs, `${ctx.paths.keys}/${keyPathToIndexName(row.path)}.json`, row);
}

async function removeKeyRow(fs: FsSystem, ctx: PersistContext, keyPath: string): Promise<void> {
    await deletePath(fs, `${ctx.paths.keys}/${keyPathToIndexName(keyPath)}.json`);
}

async function writeEntryRow(fs: FsSystem, ctx: PersistContext, row: EntryRow): Promise<void> {
    await writeJson(fs, `${ctx.paths.entries}/${row.id}.json`, row);
    const idxName = keyEntryToIndexName(row.key, row.entry);
    const idxPath = `${ctx.paths.byKeyEntry}/${idxName}`;
    await deletePath(fs, idxPath);
    if (fs["party.openv.filesystem.write.symlink"]) {
        await fs["party.openv.filesystem.write.symlink"](`${ctx.paths.entries}/${row.id}.json`, idxPath).catch(async () => {
            await writeJson(fs, `${idxPath}.json`, { id: row.id });
        });
    } else {
        await writeJson(fs, `${idxPath}.json`, { id: row.id });
    }
}

async function findEntryIdByKeyEntry(fs: FsSystem, ctx: PersistContext, key: string, entry: string): Promise<string | null> {
    const idxName = keyEntryToIndexName(key, entry);
    const idxPath = `${ctx.paths.byKeyEntry}/${idxName}`;
    const readlink = fs["party.openv.filesystem.read.readlink"];
    if (readlink) {
        try {
            const target = await readlink(idxPath);
            const id = target.split("/").pop()?.replace(/\.json$/, "");
            if (id) return id;
        } catch {
            // fall through
        }
    }
    const ref = await readJson<{ id: string }>(fs, `${idxPath}.json`);
    return ref?.id ?? null;
}

async function removeEntryById(fs: FsSystem, ctx: PersistContext, id: string): Promise<void> {
    await deletePath(fs, `${ctx.paths.entries}/${id}.json`);
}

async function removeEntryByKeyEntry(fs: FsSystem, ctx: PersistContext, key: string, entry: string): Promise<void> {
    const id = await findEntryIdByKeyEntry(fs, ctx, key, entry);
    if (!id) return;
    const idxName = keyEntryToIndexName(key, entry);
    await Promise.all([
        removeEntryById(fs, ctx, id),
        deletePath(fs, `${ctx.paths.byKeyEntry}/${idxName}`),
        deletePath(fs, `${ctx.paths.byKeyEntry}/${idxName}.json`),
    ]);
}

async function removeEntriesByKey(fs: FsSystem, ctx: PersistContext, key: string): Promise<void> {
    const names = await listFileNames(fs, ctx.paths.byKeyEntry);
    const tasks: Promise<void>[] = [];
    for (const name of names) {
        const base = name.endsWith(".json") ? name.slice(0, -5) : name;
        const decoded = parseKeyEntryIndexName(base);
        if (!decoded || decoded.key !== key) continue;
        tasks.push(removeEntryByKeyEntry(fs, ctx, decoded.key, decoded.entry));
    }
    await Promise.all(tasks);
}

async function clearStore(fs: FsSystem, ctx: PersistContext): Promise<void> {
    await Promise.all([
        deletePath(fs, ctx.paths.keys),
        deletePath(fs, ctx.paths.entries),
        deletePath(fs, ctx.paths.byKey),
        deletePath(fs, ctx.paths.byKeyEntry),
        deletePath(fs, ctx.paths.meta),
    ]);
}

async function collectSnapshotForBase(registry: CoreRegistry, baseKey: string): Promise<Snapshot> {
    const keys: KeyRow[] = [];
    const entries: EntryRow[] = [];
    const exists = await registry["party.openv.registry.read.keyExists"](baseKey);
    if (!exists) return { keys, entries };

    const visit = async (key: string): Promise<void> => {
        keys.push({ path: key, parent: parentPath(key) });
        const [defaultValue, namedEntries, subkeys] = await Promise.all([
            registry["party.openv.registry.read.readDefault"](key),
            registry["party.openv.registry.read.listEntries"](key),
            registry["party.openv.registry.read.listSubkeys"](key),
        ]);
        if (defaultValue !== null) entries.push({ id: uuid(), key, entry: "", value: defaultValue });
        const names = namedEntries ?? [];
        const values = await Promise.all(names.map(name => registry["party.openv.registry.read.readEntry"](key, name)));
        for (let i = 0; i < names.length; i++) {
            const value = values[i];
            if (value !== null) entries.push({ id: uuid(), key, entry: names[i]!, value });
        }
        const children = subkeys ?? [];
        await Promise.all(children.map(sub => visit(`${key}/${sub}`)));
    };

    await visit(baseKey);
    return { keys, entries };
}

async function syncSnapshot(fs: FsSystem, ctx: PersistContext, snapshot: Snapshot): Promise<void> {
    await clearStore(fs, ctx);
    await Promise.all([
        ensureDir(fs, ctx.paths.keys),
        ensureDir(fs, ctx.paths.entries),
        ensureDir(fs, ctx.paths.byKey),
        ensureDir(fs, ctx.paths.byKeyEntry),
    ]);
    for (const key of snapshot.keys) await writeKeyRow(fs, ctx, key);
    for (const entry of snapshot.entries) await writeEntryRow(fs, ctx, entry);
    await writeMeta(fs, ctx);
}

function contextForKey(contexts: PersistContext[], key: string): PersistContext | null {
    const normalized = normalizePath(key);
    let best: PersistContext | null = null;
    for (const ctx of contexts) {
        if (!isWithinBase(normalized, ctx.baseKey)) continue;
        if (!best || ctx.baseKey.length > best.baseKey.length) best = ctx;
    }
    return best;
}

export async function hydrateRegistryFromFilesystem(registry: CoreRegistry, fs: FsSystem, map: RegistryFsMapEntry[]): Promise<void> {
    const contexts = resolveContexts(map);
    for (const ctx of contexts) {
        const snapshot = await readSnapshot(fs, ctx);
        if (snapshot.keys.length === 0 && snapshot.entries.length === 0) continue;
        const keys = [...snapshot.keys].sort((a, b) => depth(a.path) - depth(b.path));
        for (const key of keys) await registry["party.openv.registry.write.createKey"](key.path);
        for (const row of snapshot.entries) {
            if (row.entry === "*") continue;
            await registry["party.openv.registry.write.writeEntry"](row.key, row.entry, row.value);
        }
    }
}

export async function syncRegistryToFilesystem(registry: CoreRegistry, fs: FsSystem, map: RegistryFsMapEntry[]): Promise<void> {
    const contexts = resolveContexts(map);
    for (const ctx of contexts) {
        const snapshot = await collectSnapshotForBase(registry, ctx.baseKey);
        await syncSnapshot(fs, ctx, snapshot);
    }
}

async function persistEntryEvent(event: RegistryEntryWatchEvent, fs: FsSystem, contexts: PersistContext[]): Promise<void> {
    const ctx = contextForKey(contexts, event.key);
    if (!ctx) return;
    await Promise.all([
        ensureDir(fs, ctx.paths.keys),
        ensureDir(fs, ctx.paths.entries),
        ensureDir(fs, ctx.paths.byKeyEntry),
    ]);
    await writeKeyRow(fs, ctx, { path: event.key, parent: parentPath(event.key) });
    if (event.value === null) {
        await removeEntryByKeyEntry(fs, ctx, event.key, event.entry);
    } else {
        const existing = await findEntryIdByKeyEntry(fs, ctx, event.key, event.entry);
        await writeEntryRow(fs, ctx, {
            id: existing ?? uuid(),
            key: event.key,
            entry: event.entry,
            value: event.value,
        });
    }
    await writeMeta(fs, ctx);
}

async function persistKeyEvent(event: RegistryKeyWatchEvent, fs: FsSystem, contexts: PersistContext[]): Promise<void> {
    const ctx = contextForKey(contexts, event.key);
    if (!ctx) return;
    await ensureDir(fs, ctx.paths.keys);
    if (event.created) {
        await writeKeyRow(fs, ctx, { path: event.key, parent: parentPath(event.key) });
    } else {
        const allKeys = await listFileNames(fs, ctx.paths.keys);
        const toDelete: string[] = [];
        for (const file of allKeys) {
            const row = await readJson<KeyRow>(fs, `${ctx.paths.keys}/${file}`);
            if (!row || !isWithinBase(row.path, ctx.baseKey)) continue;
            if (row.path === event.key || row.path.startsWith(`${event.key}/`)) toDelete.push(row.path);
        }
        for (const keyPath of toDelete) {
            await Promise.all([
                removeKeyRow(fs, ctx, keyPath),
                removeEntriesByKey(fs, ctx, keyPath),
            ]);
        }
    }
    await writeMeta(fs, ctx);
}

export async function startRegistryFilesystemPersistence(registry: CoreRegistry, fs: FsSystem, map: RegistryFsMapEntry[]): Promise<void> {
    if (persistenceStarted) return;
    persistenceStarted = true;
    const contexts = resolveContexts(map);
    const watchers = await Promise.all(
        contexts.map(ctx =>
            Promise.all([
                registry["party.openv.impl.registry.preWatchEntry"](ctx.baseKey, "*", { recursive: true }),
                registry["party.openv.impl.registry.preWatchKey"](ctx.baseKey, { recursive: true }),
            ]),
        ),
    );

    for (const [entryWatcher, keyWatcher] of watchers) {
        (async () => {
            for await (const event of entryWatcher.changes) {
                await persistEntryEvent(event, fs, contexts).catch((err) => {
                    console.error("[registry-sync] failed to persist entry event:", err);
                });
            }
        })();
        (async () => {
            for await (const event of keyWatcher.changes) {
                await persistKeyEvent(event, fs, contexts).catch((err) => {
                    console.error("[registry-sync] failed to persist key event:", err);
                });
            }
        })();
    }
}
