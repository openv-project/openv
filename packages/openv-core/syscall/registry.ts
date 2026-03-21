import { ProcessComponent, REGISTRY_READ_NAMESPACE, REGISTRY_READ_NAMESPACE_VERSIONED, REGISTRY_WRITE_NAMESPACE, REGISTRY_WRITE_NAMESPACE_VERSIONED, RegistryReadComponent, RegistryValue, RegistryWriteComponent, SystemComponent } from "@openv-project/openv-api";
import { CoreProcessExt } from "./mod";

const CORE_REGISTRY_EXT_NAMESPACE = "party.openv.impl.registry" as const;
const CORE_REGISTRY_EXT_NAMESPACE_VERSIONED = `${CORE_REGISTRY_EXT_NAMESPACE}/0.1.0` as const;

const WILDCARD = "*" as const;

interface CoreRegistryExt extends SystemComponent<typeof CORE_REGISTRY_EXT_NAMESPACE_VERSIONED, typeof CORE_REGISTRY_EXT_NAMESPACE> {
    ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void>;
    ["party.openv.impl.registry.preWatchDefault"](key: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void>;
}

export class CoreRegistry implements RegistryReadComponent, RegistryWriteComponent, CoreRegistryExt {
    #store: Map<string, Map<string, RegistryValue>> = new Map();
    #watchers: Map<string, Set<{ wait: boolean; handler: (value: RegistryValue | null) => Promise<void> | void }>> = new Map();

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

    #validateEntry(entry: string): void {
        if (entry === WILDCARD) {
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

    #watchKeysFor(normalizedKey: string, entry: string): string[] {
        const keys = [`${normalizedKey}\0${entry}`];
        const wildcardKey = `${normalizedKey}\0${WILDCARD}`;
        if (this.#watchers.has(wildcardKey)) keys.push(wildcardKey);
        return keys;
    }

    async #notifyWatchers(normalizedKey: string, entry: string, value: RegistryValue | null): Promise<void> {
        for (const watchKey of this.#watchKeysFor(normalizedKey, entry)) {
            const callbacks = this.#watchers.get(watchKey);
            if (!callbacks) continue;
            for (const cb of callbacks) {
                if (cb.wait) {
                    await cb.handler(value);
                } else {
                    cb.handler(value);
                }
            }
        }
    }

    #makeWatchIterable(watchKey: string): { changes: AsyncIterable<RegistryValue | null>; abort: () => Promise<void> } {
        if (!this.#watchers.has(watchKey)) {
            this.#watchers.set(watchKey, new Set());
        }
        const callbacks = this.#watchers.get(watchKey)!;

        let aborted = false;
        const buffer: (RegistryValue | null)[] = [];
        let notify: ((result: IteratorResult<RegistryValue | null>) => void) | null = null;

        const callback = {
            wait: false,
            handler: (value: RegistryValue | null) => {
                if (aborted) return;
                if (notify) {
                    const n = notify;
                    notify = null;
                    n({ value, done: false });
                } else {
                    buffer.push(value);
                }
            }
        };

        callbacks.add(callback);

        const cleanup = () => {
            aborted = true;
            callbacks.delete(callback);
            if (notify) {
                const n = notify;
                notify = null;
                n({ value: undefined as any, done: true });
            }
        };

        const changes: AsyncIterable<RegistryValue | null> = {
            [Symbol.asyncIterator]() {
                return {
                    next(): Promise<IteratorResult<RegistryValue | null>> {
                        if (buffer.length > 0) {
                            return Promise.resolve({ value: buffer.shift()!, done: false });
                        }
                        if (aborted) {
                            return Promise.resolve({ value: undefined as any, done: true });
                        }
                        return new Promise<IteratorResult<RegistryValue | null>>(r => { notify = r; });
                    },
                    return(): Promise<IteratorResult<RegistryValue | null>> {
                        cleanup();
                        return Promise.resolve({ value: undefined as any, done: true });
                    }
                };
            }
        };

        return { changes, abort: async () => cleanup() };
    }

    ["party.openv.registry.read.readEntry"](key: string, entry: string): Promise<RegistryValue | null> {
        if (entry === WILDCARD) return Promise.resolve(null); // wildcard is not a real entry
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

    ["party.openv.registry.read.watchEntry"](key: string, entry: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }> {
        const norm = this.#normalizePath(key);
        const watchKey = entry === WILDCARD
            ? `${norm}\0${WILDCARD}`
            : `${norm}\0${entry}`;
        return Promise.resolve(this.#makeWatchIterable(watchKey));
    }

    ["party.openv.registry.read.watchDefault"](key: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }> {
        return this["party.openv.registry.read.watchEntry"](key, "");
    }

    async ["party.openv.registry.write.createKey"](key: string): Promise<void> {
        const norm = this.#normalizePath(key);
        this.#ensureKey(norm);
    }

    ["party.openv.registry.write.writeEntry"](key: string, entry: string, value: RegistryValue): Promise<void> {
        this.#validateEntry(entry);
        const norm = this.#normalizePath(key);
        const entries = this.#ensureKey(norm);
        entries.set(entry, value);
        return this.#notifyWatchers(norm, entry, value);
    }

    ["party.openv.registry.write.writeDefault"](key: string, value: RegistryValue): Promise<void> {
        return this["party.openv.registry.write.writeEntry"](key, "", value);
    }

    async ["party.openv.registry.write.deleteEntry"](key: string, entry: string): Promise<void> {
        this.#validateEntry(entry);
        const norm = this.#normalizePath(key);
        const entries = this.#requireKey(norm);
        entries.delete(entry);
        return this.#notifyWatchers(norm, entry, null);
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
                    await this.#notifyWatchers(k, entry, null);
                }
            }
        }

        for (const k of toDelete) this.#store.delete(k);
    }

    async ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void> {
        const norm = this.#normalizePath(key);
        const watchKey = entry === WILDCARD
            ? `${norm}\0${WILDCARD}`
            : `${norm}\0${entry}`;
        if (!this.#watchers.has(watchKey)) {
            this.#watchers.set(watchKey, new Set());
        }
        this.#watchers.get(watchKey)!.add({ wait: true, handler });
    }

    async ["party.openv.impl.registry.preWatchDefault"](key: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void> {
        return this["party.openv.impl.registry.preWatchEntry"](key, "", handler);
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

    async ["party.openv.registry.read.watchEntry"](key: string, entry: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watchEntry"](key, entry);
    }

    async ["party.openv.registry.read.watchDefault"](key: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }> {
        await this.#checkAccess(key, "read");
        return this.#system["party.openv.registry.read.watchDefault"](key);
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