import { ProcessComponent, REGISTRY_READ_NAMESPACE, REGISTRY_READ_NAMESPACE_VERSIONED, REGISTRY_WRITE_NAMESPACE, REGISTRY_WRITE_NAMESPACE_VERSIONED, RegistryEntryWatchEvent, RegistryKeyWatchEvent, RegistryReadComponent, RegistryValue, RegistryWatchEvent, RegistryWatchOptions, RegistryWatcher, RegistryWriteComponent, SystemComponent } from "@openv-project/openv-api";
import { CoreProcessExt } from "./mod";

const CORE_REGISTRY_EXT_NAMESPACE = "party.openv.impl.registry" as const;
const CORE_REGISTRY_EXT_NAMESPACE_VERSIONED = `${CORE_REGISTRY_EXT_NAMESPACE}/0.1.0` as const;

const WILDCARD = "*" as const;

interface CoreRegistryExt extends SystemComponent<typeof CORE_REGISTRY_EXT_NAMESPACE_VERSIONED, typeof CORE_REGISTRY_EXT_NAMESPACE> {
    ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>>;
    ["party.openv.impl.registry.preWatchDefault"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>>;
    ["party.openv.impl.registry.preWatchKey"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryKeyWatchEvent>>;
    ["party.openv.impl.registry.preWatch"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryWatchEvent>>;
}

export class CoreRegistry implements RegistryReadComponent, RegistryWriteComponent, CoreRegistryExt {
    #store: Map<string, Map<string, RegistryValue>> = new Map();
    #entryWatchers: Map<string, Set<(event: RegistryEntryWatchEvent) => void>> = new Map();
    #keyWatchers: Map<string, Set<(event: RegistryKeyWatchEvent) => void>> = new Map();
    #allWatchers: Map<string, Set<(event: RegistryWatchEvent) => void>> = new Map();

    #normalizePath(key: string): string {
        const segments: string[] = [];
        let i = 0;
        while (i < key.length) {
            if (key[i] === "/") { i++; continue; }
            let seg = "";
            while (i < key.length && key[i] !== "/") { seg += key[i]; i++; }
            if (seg.length > 0) segments.push(seg);
        }
        if (segments.length === 0) return "/";
        return "/" + segments.join("/");
    }

    #ancestry(normalizedKey: string): string[] {
        if (normalizedKey === "/") return ["/"];
        const result: string[] = ["/"];
        let i = 1;
        while (i <= normalizedKey.length) {
            if (i === normalizedKey.length || normalizedKey[i] === "/") {
                const segment = normalizedKey.slice(0, i);
                if (segment !== "/") result.push(segment);
            }
            i++;
        }
        return result;
    }

    #validateEntry(entry: string, allowWildcard = false): void {
        if (!allowWildcard && entry === WILDCARD) {
            throw new Error(`Registry entry name "${WILDCARD}" is reserved and cannot be used directly.`);
        }
    }

    #getEntries(normalizedKey: string): Map<string, RegistryValue> | undefined {
        return this.#store.get(normalizedKey);
    }

    #ensureKey(normalizedKey: string): Map<string, RegistryValue> {
        for (const ancestor of this.#ancestry(normalizedKey)) {
            if (!this.#store.has(ancestor)) {
                this.#store.set(ancestor, new Map());
            }
        }
        return this.#store.get(normalizedKey)!;
    }

    #requireKey(normalizedKey: string): Map<string, RegistryValue> {
        const entries = this.#store.get(normalizedKey);
        if (!entries) throw new Error(`Registry key does not exist: "${normalizedKey}"`);
        return entries;
    }

    #entryWatchMapKey(normalizedKey: string, entry: string, recursive: boolean): string {
        return `${recursive ? "r" : "d"}\0${normalizedKey}\0${entry}`;
    }

    #keyWatchMapKey(normalizedKey: string, recursive: boolean): string {
        return `${recursive ? "r" : "d"}\0${normalizedKey}`;
    }

    #entryWatchKeysFor(normalizedKey: string, entry: string): string[] {
        const keys = new Set<string>();
        for (const ancestor of this.#ancestry(normalizedKey)) {
            const isSelf = ancestor === normalizedKey;
            const recursiveModes = isSelf ? [false, true] : [true];
            for (const recursive of recursiveModes) {
                keys.add(this.#entryWatchMapKey(ancestor, entry, recursive));
                keys.add(this.#entryWatchMapKey(ancestor, WILDCARD, recursive));
            }
        }
        return [...keys];
    }

    #keyWatchKeysFor(normalizedKey: string): string[] {
        const keys = new Set<string>();
        for (const ancestor of this.#ancestry(normalizedKey)) {
            const isSelf = ancestor === normalizedKey;
            const recursiveModes = isSelf ? [false, true] : [true];
            for (const recursive of recursiveModes) {
                keys.add(this.#keyWatchMapKey(ancestor, recursive));
            }
        }
        return [...keys];
    }

    async #notifyEntryWatchers(normalizedKey: string, entry: string, value: RegistryValue | null): Promise<void> {
        const event: RegistryEntryWatchEvent = { kind: "entry", key: normalizedKey, entry, value };
        for (const watchKey of this.#entryWatchKeysFor(normalizedKey, entry)) {
            const callbacks = this.#entryWatchers.get(watchKey);
            if (callbacks) {
                for (const cb of callbacks) cb(event);
            }
        }

        for (const watchKey of this.#keyWatchKeysFor(normalizedKey)) {
            const callbacks = this.#allWatchers.get(watchKey);
            if (callbacks) {
                for (const cb of callbacks) cb(event);
            }
        }
    }

    async #notifyKeyWatchers(normalizedKey: string, created: boolean): Promise<void> {
        const event: RegistryKeyWatchEvent = { kind: "key", key: normalizedKey, created };
        for (const watchKey of this.#keyWatchKeysFor(normalizedKey)) {
            const keyCallbacks = this.#keyWatchers.get(watchKey);
            if (keyCallbacks) {
                for (const cb of keyCallbacks) cb(event);
            }

            const allCallbacks = this.#allWatchers.get(watchKey);
            if (allCallbacks) {
                for (const cb of allCallbacks) cb(event);
            }
        }
    }

    #makeWatchIterable<T>(watchers: Map<string, Set<(event: T) => void>>, watchKey: string): RegistryWatcher<T> {
        if (!watchers.has(watchKey)) {
            watchers.set(watchKey, new Set());
        }
        const callbacks = watchers.get(watchKey)!;

        let aborted = false;
        const buffer: T[] = [];
        let notify: ((result: IteratorResult<T>) => void) | null = null;

        const callback = (value: T) => {
            if (aborted) return;
            if (notify) {
                const n = notify;
                notify = null;
                n({ value, done: false });
            } else {
                buffer.push(value);
            }
        };

        callbacks.add(callback);

        const cleanup = () => {
            if (aborted) return;
            aborted = true;
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                watchers.delete(watchKey);
            }
            if (notify) {
                const n = notify;
                notify = null;
                n({ value: undefined as any, done: true });
            }
        };

        const changes: AsyncIterable<T> = {
            [Symbol.asyncIterator]() {
                return {
                    next(): Promise<IteratorResult<T>> {
                        if (buffer.length > 0) {
                            return Promise.resolve({ value: buffer.shift()!, done: false });
                        }
                        if (aborted) {
                            return Promise.resolve({ value: undefined as any, done: true });
                        }
                        return new Promise<IteratorResult<T>>(r => { notify = r; });
                    },
                    return(): Promise<IteratorResult<T>> {
                        cleanup();
                        return Promise.resolve({ value: undefined as any, done: true });
                    }
                };
            }
        };

        return { changes, abort: async () => cleanup() };
    }

    ["party.openv.registry.read.readEntry"](key: string, entry: string): Promise<RegistryValue | null> {
        this.#validateEntry(entry);
        const norm = this.#normalizePath(key);
        const entries = this.#getEntries(norm);
        if (!entries) return Promise.resolve(null);
        return Promise.resolve(entries.get(entry) ?? null);
    }

    ["party.openv.registry.read.readDefault"](key: string): Promise<RegistryValue | null> {
        return this["party.openv.registry.read.readEntry"](key, "");
    }

    ["party.openv.registry.read.listEntries"](key: string): Promise<string[] | null> {
        const norm = this.#normalizePath(key);
        const entries = this.#getEntries(norm);
        if (!entries) return Promise.resolve(null);
        return Promise.resolve([...entries.keys()].filter(e => e !== "" && e !== WILDCARD));
    }

    ["party.openv.registry.read.listSubkeys"](key: string): Promise<string[] | null> {
        const norm = this.#normalizePath(key);
        if (!this.#store.has(norm)) return Promise.resolve(null);

        const prefix = norm === "/" ? "/" : norm + "/";
        const directChildren = new Set<string>();

        for (const k of this.#store.keys()) {
            if (k === norm) continue;
            if (!k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            if (rest.length === 0) continue;
            let hasSlash = false;
            for (let i = 0; i < rest.length; i++) {
                if (rest[i] === "/") { hasSlash = true; break; }
            }
            if (!hasSlash) directChildren.add(rest);
        }

        return Promise.resolve([...directChildren]);
    }

    ["party.openv.registry.read.keyExists"](key: string): Promise<boolean> {
        const norm = this.#normalizePath(key);
        return Promise.resolve(this.#store.has(norm));
    }

    ["party.openv.registry.read.watchEntry"](key: string, entry: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        this.#validateEntry(entry, true);
        const norm = this.#normalizePath(key);
        const watchKey = this.#entryWatchMapKey(norm, entry, Boolean(options?.recursive));
        return Promise.resolve(this.#makeWatchIterable(this.#entryWatchers, watchKey));
    }

    ["party.openv.registry.read.watchDefault"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        return this["party.openv.registry.read.watchEntry"](key, "", options);
    }

    ["party.openv.registry.read.watchKey"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryKeyWatchEvent>> {
        const norm = this.#normalizePath(key);
        const watchKey = this.#keyWatchMapKey(norm, Boolean(options?.recursive));
        return Promise.resolve(this.#makeWatchIterable(this.#keyWatchers, watchKey));
    }

    ["party.openv.registry.read.watch"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryWatchEvent>> {
        const norm = this.#normalizePath(key);
        const watchKey = this.#keyWatchMapKey(norm, Boolean(options?.recursive));
        return Promise.resolve(this.#makeWatchIterable(this.#allWatchers, watchKey));
    }

    async ["party.openv.registry.write.createKey"](key: string): Promise<void> {
        const norm = this.#normalizePath(key);
        for (const ancestor of this.#ancestry(norm)) {
            if (!this.#store.has(ancestor)) {
                this.#store.set(ancestor, new Map());
                await this.#notifyKeyWatchers(ancestor, true);
            }
        }
    }

    ["party.openv.registry.write.writeEntry"](key: string, entry: string, value: RegistryValue): Promise<void> {
        this.#validateEntry(entry);
        const norm = this.#normalizePath(key);
        return (async () => {
            await this["party.openv.registry.write.createKey"](norm);
            const entries = this.#ensureKey(norm);
            entries.set(entry, value);
            await this.#notifyEntryWatchers(norm, entry, value);
        })();
    }

    ["party.openv.registry.write.writeDefault"](key: string, value: RegistryValue): Promise<void> {
        return this["party.openv.registry.write.writeEntry"](key, "", value);
    }

    async ["party.openv.registry.write.deleteEntry"](key: string, entry: string): Promise<void> {
        this.#validateEntry(entry);
        const norm = this.#normalizePath(key);
        const entries = this.#requireKey(norm);
        entries.delete(entry);
        return this.#notifyEntryWatchers(norm, entry, null);
    }

    async ["party.openv.registry.write.deleteKey"](key: string): Promise<void> {
        const norm = this.#normalizePath(key);

        const toDelete: string[] = [];
        for (const k of this.#store.keys()) {
            if (k === norm || k.startsWith(norm + "/")) toDelete.push(k);
        }
        if (toDelete.length === 0) return;

        for (const k of toDelete) {
            const entries = this.#store.get(k);
            if (entries) {
                for (const entry of entries.keys()) {
                    if (entry === WILDCARD) continue;
                    await this.#notifyEntryWatchers(k, entry, null);
                }
            }
        }

        for (const k of toDelete) {
            this.#store.delete(k);
            await this.#notifyKeyWatchers(k, false);
        }
    }

    async ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        this.#validateEntry(entry, true);
        const norm = this.#normalizePath(key);
        const watchKey = this.#entryWatchMapKey(norm, entry, Boolean(options?.recursive));
        return this.#makeWatchIterable(this.#entryWatchers, watchKey);
    }

    async ["party.openv.impl.registry.preWatchDefault"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        return this["party.openv.impl.registry.preWatchEntry"](key, "", options);
    }

    async ["party.openv.impl.registry.preWatchKey"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryKeyWatchEvent>> {
        const norm = this.#normalizePath(key);
        const watchKey = this.#keyWatchMapKey(norm, Boolean(options?.recursive));
        return this.#makeWatchIterable(this.#keyWatchers, watchKey);
    }

    async ["party.openv.impl.registry.preWatch"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryWatchEvent>> {
        const norm = this.#normalizePath(key);
        const watchKey = this.#keyWatchMapKey(norm, Boolean(options?.recursive));
        return this.#makeWatchIterable(this.#allWatchers, watchKey);
    }

    async supports(ns: typeof REGISTRY_READ_NAMESPACE | typeof REGISTRY_READ_NAMESPACE_VERSIONED): Promise<typeof REGISTRY_READ_NAMESPACE_VERSIONED>;
    async supports(ns: typeof REGISTRY_WRITE_NAMESPACE | typeof REGISTRY_WRITE_NAMESPACE_VERSIONED): Promise<typeof REGISTRY_WRITE_NAMESPACE_VERSIONED>;
    async supports(ns: typeof CORE_REGISTRY_EXT_NAMESPACE_VERSIONED | typeof CORE_REGISTRY_EXT_NAMESPACE): Promise<typeof CORE_REGISTRY_EXT_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        switch (ns) {
            case REGISTRY_READ_NAMESPACE:
            case REGISTRY_READ_NAMESPACE_VERSIONED:
                return REGISTRY_READ_NAMESPACE_VERSIONED;
            case REGISTRY_WRITE_NAMESPACE:
            case REGISTRY_WRITE_NAMESPACE_VERSIONED:
                return REGISTRY_WRITE_NAMESPACE_VERSIONED;
            case CORE_REGISTRY_EXT_NAMESPACE:
            case CORE_REGISTRY_EXT_NAMESPACE_VERSIONED:
                return CORE_REGISTRY_EXT_NAMESPACE_VERSIONED;
            default:
                return null;
        }
    }
}

const ACL_KEY = "/system/party/openv/registry/acl" as const;

type RegistryACLEntry = {
    read: "any" | "owner" | number | number[];
    write: "any" | "owner" | number | number[];
    readGroups?: number[];
    writeGroups?: number[];
};

function matchesPattern(key: string, pattern: string): boolean {
    const keyParts = key === "/" ? [] : key.replace(/^\//, "").split("/");
    const patternParts = pattern === "/" ? [] : pattern.replace(/^\//, "").split("/");

    function match(ki: number, pi: number): boolean {
        if (ki === keyParts.length && pi === patternParts.length) return true;

        if (pi === patternParts.length) return false;

        const pp = patternParts[pi]!;

        if (pp === "**") {
            for (let ki2 = ki; ki2 <= keyParts.length; ki2++) {
                if (match(ki2, pi + 1)) return true;
            }
            return false;
        }

        if (ki === keyParts.length) return false;

        if (pp === "*") {
            return match(ki + 1, pi + 1);
        }

        return pp === keyParts[ki] && match(ki + 1, pi + 1);
    }

    return match(0, 0);
}

type CachedACL = {
    pattern: string;
    acl: RegistryACLEntry;
};

export class ProcessScopedRegistry implements RegistryReadComponent, RegistryWriteComponent {
    #system: ProcessComponent & CoreProcessExt & RegistryReadComponent;
    #pid: number;

    #aclCache: CachedACL[] | null = null;

    constructor(pid: number, system: ProcessComponent & CoreProcessExt & RegistryReadComponent) {
        this.#system = system;
        this.#pid = pid;

        this.#system["party.openv.registry.read.watchEntry"](
            ACL_KEY, "*",
        ).then(watcher => {
            (async () => {
                for await (const _ of watcher.changes) {
                    this.#aclCache = null;
                }
            })();
        }).catch(err => {
            console.error(`[ProcessScopedRegistry] failed to watch ACL changes:`, err);
        });
    }

    async #getUid(): Promise<number> {
        return this.#system["party.openv.process.getuid"](this.#pid);
    }

    async #getGid(): Promise<number> {
        return this.#system["party.openv.process.getgid"](this.#pid);
    }

    async #loadAclCache(): Promise<CachedACL[]> {
        if (this.#aclCache) return this.#aclCache;

        const patterns = await this.#system["party.openv.registry.read.listEntries"](ACL_KEY);
        if (!patterns) {
            this.#aclCache = [];
            return this.#aclCache;
        }

        const entries: CachedACL[] = [];
        for (const pattern of patterns) {
            const raw = await this.#system["party.openv.registry.read.readEntry"](ACL_KEY, pattern);
            if (!raw) continue;
            try {
                entries.push({ pattern, acl: JSON.parse(raw as string) as RegistryACLEntry });
            } catch {
                console.warn(`[ProcessScopedRegistry] invalid ACL for pattern "${pattern}"`);
            }
        }

        entries.sort((a, b) => b.pattern.length - a.pattern.length);
        this.#aclCache = entries;
        return entries;
    }

    async #checkAccess(key: string, mode: "read" | "write"): Promise<void> {
        const uid = await this.#getUid();

        if (uid === 0) return;

        const gid = await this.#getGid();
        const acls = await this.#loadAclCache();

        let matched: CachedACL | null = null;
        for (const entry of acls) {
            if (matchesPattern(key, entry.pattern)) {
                matched = entry;
                break;
            }
        }

        if (!matched) return;

        const rule = mode === "read" ? matched.acl.read : matched.acl.write;

        if (rule === "any") return;

        if (rule === "owner") {
            const lastSeg = key.split("/").filter(Boolean).pop();
            if (String(uid) === lastSeg) return;
            throw new Error(`EACCES: permission denied, ${mode} '${key}'`);
        }

        const allowed = Array.isArray(rule) ? rule : [rule as number];
        if (allowed.includes(uid)) return;

        const groupRule = mode === "read" ? matched.acl.readGroups : matched.acl.writeGroups;
        if (groupRule?.includes(gid)) return;

        throw new Error(`EACCES: permission denied, ${mode} '${key}'`);
    }

    async ["party.openv.registry.read.readEntry"](key: string, entry: string): Promise<RegistryValue | null> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.readEntry"](key, entry);
    }

    async ["party.openv.registry.read.readDefault"](key: string): Promise<RegistryValue | null> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.readDefault"](key);
    }

    async ["party.openv.registry.read.listEntries"](key: string): Promise<string[] | null> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.listEntries"](key);
    }

    async ["party.openv.registry.read.listSubkeys"](key: string): Promise<string[] | null> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.listSubkeys"](key);
    }

    async ["party.openv.registry.read.keyExists"](key: string): Promise<boolean> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.keyExists"](key);
    }

    async ["party.openv.registry.read.watchEntry"](key: string, entry: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watchEntry"](key, entry, options);
    }

    async ["party.openv.registry.read.watchDefault"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryEntryWatchEvent>> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watchDefault"](key, options);
    }

    async ["party.openv.registry.read.watchKey"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryKeyWatchEvent>> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watchKey"](key, options);
    }

    async ["party.openv.registry.read.watch"](key: string, options?: RegistryWatchOptions): Promise<RegistryWatcher<RegistryWatchEvent>> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watch"](key, options);
    }

    async ["party.openv.registry.write.createKey"](key: string): Promise<void> {
        await this.#checkAccess(key, "write");
        return this.#system["party.openv.registry.write.createKey"](key);
    }

    async ["party.openv.registry.write.writeEntry"](key: string, entry: string, value: RegistryValue): Promise<void> {
        await this.#checkAccess(key, "write");
        return this.#system["party.openv.registry.write.writeEntry"](key, entry, value);
    }

    async ["party.openv.registry.write.writeDefault"](key: string, value: RegistryValue): Promise<void> {
        await this.#checkAccess(key, "write");
        return this.#system["party.openv.registry.write.writeDefault"](key, value);
    }

    async ["party.openv.registry.write.deleteEntry"](key: string, entry: string): Promise<void> {
        await this.#checkAccess(key, "write");
        return this.#system["party.openv.registry.write.deleteEntry"](key, entry);
    }

    async ["party.openv.registry.write.deleteKey"](key: string): Promise<void> {
        await this.#checkAccess(key, "write");
        return this.#system["party.openv.registry.write.deleteKey"](key);
    }

    supports(ns: typeof REGISTRY_READ_NAMESPACE | typeof REGISTRY_READ_NAMESPACE_VERSIONED): Promise<typeof REGISTRY_READ_NAMESPACE_VERSIONED>;
    supports(ns: typeof REGISTRY_WRITE_NAMESPACE | typeof REGISTRY_WRITE_NAMESPACE_VERSIONED): Promise<typeof REGISTRY_WRITE_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        switch (ns) {
            case REGISTRY_READ_NAMESPACE:
            case REGISTRY_READ_NAMESPACE_VERSIONED:
                return REGISTRY_READ_NAMESPACE_VERSIONED;
            case REGISTRY_WRITE_NAMESPACE:
            case REGISTRY_WRITE_NAMESPACE_VERSIONED:
                return REGISTRY_WRITE_NAMESPACE_VERSIONED;
            default:
                return null;
        }
    }
}