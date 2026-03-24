/// <reference lib="webworker" />
import type { RegistryEntryWatchEvent, RegistryKeyWatchEvent, RegistryValue } from "@openv-project/openv-api";
import type { CoreRegistry } from "@openv-project/openv-core";

const SYSTEM_ROOT = "/system" as const;

const DB_NAME = "party.openv.registry" + SYSTEM_ROOT;
const DB_VERSION = 1;

const META_STORE = "meta";
const KEYS_STORE = "keys";
const ENTRIES_STORE = "entries";

const META_ID = "system" as const;
const META_FORMAT = "party.openv.registry.idb.system/0.1.0" as const;

type MetaRow = {
    id: typeof META_ID;
    format: typeof META_FORMAT;
    root: typeof SYSTEM_ROOT;
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

type SystemSnapshot = {
    keys: KeyRow[];
    entries: EntryRow[];
};

let persistenceStarted = false;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
}

function continueCursor(cursor: IDBCursorWithValue): Promise<IDBCursorWithValue | null> {
    const req = cursor.request as IDBRequest<IDBCursorWithValue | null>;
    cursor.continue();
    return requestToPromise(req);
}

function openRegistryDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const db = req.result;

            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: "id" });
            }

            if (!db.objectStoreNames.contains(KEYS_STORE)) {
                const keys = db.createObjectStore(KEYS_STORE, { keyPath: "path" });
                keys.createIndex("byParent", "parent", { unique: false });
            }

            if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
                const entries = db.createObjectStore(ENTRIES_STORE, { keyPath: "id" });
                entries.createIndex("byKey", "key", { unique: false });
                entries.createIndex("byKeyEntry", ["key", "entry"], { unique: true });
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    });
}

function isSystemPath(path: string): boolean {
    return path === SYSTEM_ROOT || path.startsWith(`${SYSTEM_ROOT}/`);
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

async function readSystemSnapshot(): Promise<SystemSnapshot> {
    const db = await openRegistryDb();
    try {
        const tx = db.transaction([KEYS_STORE, ENTRIES_STORE, META_STORE], "readonly");
        const keyStore = tx.objectStore(KEYS_STORE);
        const entryStore = tx.objectStore(ENTRIES_STORE);
        const metaStore = tx.objectStore(META_STORE);

        const [metaRow, keysRaw, entriesRaw] = await Promise.all([
            requestToPromise(metaStore.get(META_ID) as IDBRequest<MetaRow | undefined>),
            requestToPromise(keyStore.getAll() as IDBRequest<KeyRow[]>),
            requestToPromise(entryStore.getAll() as IDBRequest<EntryRow[]>),
        ]);

        await transactionDone(tx);

        if (!metaRow || metaRow.format !== META_FORMAT || metaRow.root !== SYSTEM_ROOT) {
            return { keys: [], entries: [] };
        }

        return {
            keys: keysRaw.filter(k => isSystemPath(k.path)),
            entries: entriesRaw.filter(e => isSystemPath(e.key)),
        };
    } finally {
        db.close();
    }
}

function uuid(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function upsertEntryInTx(
    entryStore: IDBObjectStore,
    entryIndex: IDBIndex,
    row: Omit<EntryRow, "id">,
): Promise<void> {
    const cursorReq = entryIndex.openCursor(IDBKeyRange.only([row.key, row.entry]));
    const cursor = await requestToPromise(cursorReq as IDBRequest<IDBCursorWithValue | null>);
    if (cursor) {
        const existing = cursor.value as EntryRow;
        await requestToPromise(entryStore.put({ ...row, id: existing.id }));
    } else {
        await requestToPromise(entryStore.put({ ...row, id: uuid() }));
    }
}

async function deleteEntryInTx(entryIndex: IDBIndex, key: string, entry: string): Promise<void> {
    const cursorReq = entryIndex.openCursor(IDBKeyRange.only([key, entry]));
    const cursor = await requestToPromise(cursorReq as IDBRequest<IDBCursorWithValue | null>);
    if (!cursor) return;
    await requestToPromise(cursor.delete());
}

async function deleteEntriesByKeyInTx(entryByKey: IDBIndex, key: string): Promise<void> {
    let cursor = await requestToPromise(entryByKey.openCursor(IDBKeyRange.only(key)) as IDBRequest<IDBCursorWithValue | null>);
    while (cursor) {
        await requestToPromise(cursor.delete());
        cursor = await continueCursor(cursor);
    }
}

async function persistMetaInTx(metaStore: IDBObjectStore): Promise<void> {
    const row: MetaRow = {
        id: META_ID,
        format: META_FORMAT,
        root: SYSTEM_ROOT,
        updatedAt: Date.now(),
    };
    await requestToPromise(metaStore.put(row));
}

export async function hydrateSystemRegistryFromIdb(registry: CoreRegistry): Promise<void> {
    const snapshot = await readSystemSnapshot();
    if (snapshot.keys.length === 0 && snapshot.entries.length === 0) return;

    const keys = [...snapshot.keys].sort((a, b) => depth(a.path) - depth(b.path));
    for (const key of keys) {
        await registry["party.openv.registry.write.createKey"](key.path);
    }

    for (const row of snapshot.entries) {
        if (row.entry === "*") continue;
        await registry["party.openv.registry.write.writeEntry"](row.key, row.entry, row.value);
    }
}

async function collectSystemSnapshot(registry: CoreRegistry): Promise<SystemSnapshot> {
    const keys: KeyRow[] = [];
    const entries: EntryRow[] = [];

    const exists = await registry["party.openv.registry.read.keyExists"](SYSTEM_ROOT);
    if (!exists) {
        return { keys, entries };
    }

    const visit = async (key: string): Promise<void> => {
        keys.push({ path: key, parent: parentPath(key) });

        const [defaultValue, namedEntries, subkeys] = await Promise.all([
            registry["party.openv.registry.read.readDefault"](key),
            registry["party.openv.registry.read.listEntries"](key),
            registry["party.openv.registry.read.listSubkeys"](key),
        ]);

        if (defaultValue !== null) {
            entries.push({ id: uuid(), key, entry: "", value: defaultValue });
        }

        const names = namedEntries ?? [];
        const values = await Promise.all(names.map(name => registry["party.openv.registry.read.readEntry"](key, name)));
        for (let i = 0; i < names.length; i++) {
            const value = values[i];
            if (value !== null) {
                entries.push({ id: uuid(), key, entry: names[i]!, value });
            }
        }

        const children = subkeys ?? [];
        await Promise.all(children.map(sub => visit(`${key}/${sub}`)));
    };

    await visit(SYSTEM_ROOT);

    return { keys, entries };
}

export async function syncSystemRegistryToIdb(registry: CoreRegistry): Promise<void> {
    const snapshot = await collectSystemSnapshot(registry);

    const db = await openRegistryDb();
    try {
        const tx = db.transaction([META_STORE, KEYS_STORE, ENTRIES_STORE], "readwrite");
        const metaStore = tx.objectStore(META_STORE);
        const keyStore = tx.objectStore(KEYS_STORE);
        const entryStore = tx.objectStore(ENTRIES_STORE);

        await Promise.all([
            requestToPromise(keyStore.clear()),
            requestToPromise(entryStore.clear()),
        ]);

        for (const key of snapshot.keys) {
            await requestToPromise(keyStore.put(key));
        }

        for (const entry of snapshot.entries) {
            await requestToPromise(entryStore.put(entry));
        }

        await persistMetaInTx(metaStore);
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

async function persistEntryEvent(event: RegistryEntryWatchEvent): Promise<void> {
    if (!isSystemPath(event.key)) return;

    const db = await openRegistryDb();
    try {
        const tx = db.transaction([META_STORE, KEYS_STORE, ENTRIES_STORE], "readwrite");
        const metaStore = tx.objectStore(META_STORE);
        const keyStore = tx.objectStore(KEYS_STORE);
        const entryStore = tx.objectStore(ENTRIES_STORE);
        const entryByKeyEntry = entryStore.index("byKeyEntry");

        await requestToPromise(keyStore.put({ path: event.key, parent: parentPath(event.key) } satisfies KeyRow));

        if (event.value === null) {
            await deleteEntryInTx(entryByKeyEntry, event.key, event.entry);
        } else {
            await upsertEntryInTx(entryStore, entryByKeyEntry, {
                key: event.key,
                entry: event.entry,
                value: event.value,
            });
        }

        await persistMetaInTx(metaStore);
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

async function persistKeyEvent(event: RegistryKeyWatchEvent): Promise<void> {
    if (!isSystemPath(event.key)) return;

    const db = await openRegistryDb();
    try {
        const tx = db.transaction([META_STORE, KEYS_STORE, ENTRIES_STORE], "readwrite");
        const metaStore = tx.objectStore(META_STORE);
        const keyStore = tx.objectStore(KEYS_STORE);
        const entryStore = tx.objectStore(ENTRIES_STORE);
        const entryByKey = entryStore.index("byKey");

        if (event.created) {
            await requestToPromise(keyStore.put({ path: event.key, parent: parentPath(event.key) } satisfies KeyRow));
        } else {
            const lower = event.key;
            const upper = `${event.key}\uffff`;
            let cursor = await requestToPromise(
                keyStore.openCursor(IDBKeyRange.bound(lower, upper)) as IDBRequest<IDBCursorWithValue | null>
            );

            const toDelete: string[] = [];
            while (cursor) {
                const keyPath = (cursor.value as KeyRow).path;
                if (isSystemPath(keyPath)) toDelete.push(keyPath);
                cursor = await continueCursor(cursor);
            }

            for (const keyPath of toDelete) {
                await requestToPromise(keyStore.delete(keyPath));
                await deleteEntriesByKeyInTx(entryByKey, keyPath);
            }
        }

        await persistMetaInTx(metaStore);
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function startSystemRegistryPersistence(registry: CoreRegistry): Promise<void> {
    if (persistenceStarted) return;
    persistenceStarted = true;

    const [entryWatcher, keyWatcher] = await Promise.all([
        registry["party.openv.impl.registry.preWatchEntry"](SYSTEM_ROOT, "*", { recursive: true }),
        registry["party.openv.impl.registry.preWatchKey"](SYSTEM_ROOT, { recursive: true }),
    ]);

    (async () => {
        for await (const event of entryWatcher.changes) {
            await persistEntryEvent(event).catch((err) => {
                console.error("[system-registry-idb] failed to persist entry event:", err);
            });
        }
    })();

    (async () => {
        for await (const event of keyWatcher.changes) {
            await persistKeyEvent(event).catch((err) => {
                console.error("[system-registry-idb] failed to persist key event:", err);
            });
        }
    })();
}
