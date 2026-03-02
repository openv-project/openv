import type { SystemComponent } from "../../openv/syscall/index.ts";
import type { RegistryReadComponent, RegistryValue, RegistryWriteComponent } from "../../openv/syscall/registry";

/**
 * Local extension to the registry component.
 * This is included to allow watchers to be notified prior to the promise of the registry change being resolved.
 * For example, a watcher that writes registry changes to disk would be able to guarantee that the change is fully 
 * flushed to disk before the promise of the registry change is resolved.
 */
interface CoreRegistryExt extends SystemComponent<"party.openv.impl.registry/0.1.0", "party.openv.impl.registry"> {
    ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void>;
    ["party.openv.impl.registry.preWatchDefault"](key: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void>;
}

export class CoreRegistry implements RegistryReadComponent, RegistryWriteComponent, CoreRegistryExt {
    #store: Map<string, Map<string, RegistryValue>> = new Map();
    #watchers: Map<string, Set<{wait: boolean; handler: (value: RegistryValue | null) => Promise<void> | void}>> = new Map();

    ["party.openv.registry.write.writeDefault"](key: string, value: RegistryValue): Promise<void> {
        return this["party.openv.registry.write.writeEntry"](key, "", value); 
    }

    async ["party.openv.registry.write.createKey"](key: string): Promise<void> {
        this.#ensureKey(key);
    }

    #getEntries(key: string): Map<string, RegistryValue> | undefined {
        return this.#store.get(key);
    }

    #ensureKey(key: string): Map<string, RegistryValue> {
        const parts = key.split("/");

        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;

            if (!this.#store.has(current)) {
                this.#store.set(current, new Map());
            }
        }

        return this.#store.get(key)!;
    }

    async #notifyWatchers(key: string, entry: string, value: RegistryValue | null): Promise<void> {
        const watchKey = `${key}\0${entry}`;
        const callbacks = this.#watchers.get(watchKey);
        if (callbacks) {
            for (const cb of callbacks) {
                if (cb.wait) {
                    await cb.handler(value);
                } else {
                    cb.handler(value);
                }
            }
        }
    }

    ["party.openv.registry.read.readEntry"](key: string, entry: string): Promise<RegistryValue | null> {
        const entries = this.#getEntries(key);
        if (!entries) return Promise.resolve(null);
        return Promise.resolve(entries.get(entry) ?? null);
    }

    ["party.openv.registry.read.readDefault"](key: string): Promise<RegistryValue | null> {
        return this["party.openv.registry.read.readEntry"](key, "");
    }

    ["party.openv.registry.read.listEntries"](key: string): Promise<string[] | null> {
        const entries = this.#getEntries(key);
        if (!entries) return Promise.resolve(null);
        return Promise.resolve([...entries.keys()].filter(e => e !== ""));
    }

    ["party.openv.registry.read.listSubkeys"](key: string): Promise<string[] | null> {
        const prefix = key.endsWith("/") ? key : key + "/";
        const subkeys = new Set<string>();
        for (const k of this.#store.keys()) {
            if (k.startsWith(prefix)) {
                const rest = k.slice(prefix.length);
                const nextSegment = rest.split("/")[0];
                if (nextSegment) {
                    subkeys.add(nextSegment);
                }
            }
        }
        if (subkeys.size === 0 && !this.#store.has(key)) return Promise.resolve(null);
        console.log(`Listing subkeys of ${key}:`, [...subkeys]);
        return Promise.resolve([...subkeys]);
    }

    ["party.openv.registry.read.keyExists"](key: string): Promise<boolean> {
        return Promise.resolve(this.#store.has(key));
    }

    ["party.openv.registry.read.watchEntry"](key: string, entry: string): Promise<{ changes: AsyncIterable<RegistryValue | null>; abort: () => Promise<void>; }> {
        const watchKey = `${key}\0${entry}`;
        if (!this.#watchers.has(watchKey)) {
            this.#watchers.set(watchKey, new Set());
        }
        const callbacks = this.#watchers.get(watchKey)!;

        let aborted = false;
        const buffer: (RegistryValue | null)[] = [];
        let resolve: ((value: IteratorResult<RegistryValue | null>) => void) | null = null;

        const callback = {wait: false, handler: (value: RegistryValue | null) => {
            if (aborted) return;
            if (resolve) {
                const r = resolve;
                resolve = null;
                r({ value, done: false });
            } else {
                buffer.push(value);
            }
        }};

        callbacks.add(callback);

        const changes: AsyncIterable<RegistryValue | null> = {
            [Symbol.asyncIterator]() {
                return {
                    next(): Promise<IteratorResult<RegistryValue | null>> {
                        if (buffer.length > 0) {
                            return Promise.resolve({ value: buffer.shift()!, done: false });
                        }
                        if (aborted) {
                            return Promise.resolve({ value: undefined, done: true });
                        }
                        return new Promise<IteratorResult<RegistryValue | null>>(r => {
                            resolve = r;
                        });
                    },
                    return(): Promise<IteratorResult<RegistryValue | null>> {
                        aborted = true;
                        callbacks.delete(callback);
                        return Promise.resolve({ value: null, done: true });
                    }
                };
            }
        };

        const abort = async () => {
            aborted = true;
            callbacks.delete(callback);
            if (resolve) {
                const r = resolve;
                resolve = null;
                r({ value: undefined, done: true });
            }
        };

        return Promise.resolve({ changes, abort });
    }

    ["party.openv.registry.read.watchDefault"](key: string): Promise<{ changes: AsyncIterable<RegistryValue | null>; abort: () => Promise<void>; }> {
        return this["party.openv.registry.read.watchEntry"](key, "");
    }

    ["party.openv.registry.write.writeEntry"](key: string, entry: string, value: RegistryValue): Promise<void> {
        const entries = this.#ensureKey(key);
        entries.set(entry, value);
        return this.#notifyWatchers(key, entry, value);
    }

    async ["party.openv.registry.write.deleteEntry"](key: string, entry: string): Promise<void> {
        const entries = this.#getEntries(key);
        if (!entries) return Promise.resolve();
        entries.delete(entry);
        return this.#notifyWatchers(key, entry, null);
    }

    async ["party.openv.registry.write.deleteKey"](key: string): Promise<void> {
        const entries = this.#getEntries(key);
        if (entries) {
            for (const entry of entries.keys()) {
               await this.#notifyWatchers(key, entry, null);
            }
        }
        this.#store.delete(key);
    }

    async ["party.openv.impl.registry.preWatchEntry"](key: string, entry: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void> {
        const watchKey = `${key}\0${entry}`;
        if (!this.#watchers.has(watchKey)) {
            this.#watchers.set(watchKey, new Set());
        }
        const callbacks = this.#watchers.get(watchKey)!;

        const callback = {wait: true, handler};
        callbacks.add(callback);
    }

    async ["party.openv.impl.registry.preWatchDefault"](key: string, handler: (value: RegistryValue | null) => Promise<void>): Promise<void> {
        return this["party.openv.impl.registry.preWatchEntry"](key, "", handler);
    }

    supports(ns: "party.openv.registry.read" | "party.openv.registry.read/0.1.0"): Promise<"party.openv.registry.read/0.1.0">;
    supports(ns: "party.openv.registry.write" | "party.openv.registry.write/0.1.0"): Promise<"party.openv.registry.write/0.1.0">;
    supports(ns: "party.openv.impl.registry" | "party.openv.impl.registry/0.1.0"): Promise<"party.openv.impl.registry/0.1.0">;
    supports(ns: string): Promise<string | null> {
        switch (ns) {
            case "party.openv.registry.read":
            case "party.openv.registry.read/0.1.0":
                return Promise.resolve("party.openv.registry.read/0.1.0");
            case "party.openv.registry.write":
            case "party.openv.registry.write/0.1.0":
                return Promise.resolve("party.openv.registry.write/0.1.0");
            case "party.openv.impl.registry":
            case "party.openv.impl.registry/0.1.0":
                return Promise.resolve("party.openv.impl.registry/0.1.0");
            default:
                return Promise.resolve(null);
        }
    }
}