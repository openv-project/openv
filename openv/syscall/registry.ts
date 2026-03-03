import type { SystemComponent } from "./index.ts";

export type RegistryValue = string | number | boolean | ArrayBuffer;

export const REGISTRY_READ_NAMESPACE = "party.openv.registry.read" as const;
export const REGISTRY_READ_NAMESPACE_VERSIONED = `${REGISTRY_READ_NAMESPACE}/0.1.0` as const;
export const REGISTRY_WRITE_NAMESPACE = "party.openv.registry.write" as const;
export const REGISTRY_WRITE_NAMESPACE_VERSIONED = `${REGISTRY_WRITE_NAMESPACE}/0.1.0` as const;

/**
 * The universal registry read system component.
 * This namespace allows querying the system registry for configuration values and other information.
 *
 * Registry structure: The registry is a tree of (sub)keys. Each key can contain:
 * 1. A default value (accessed via readDefault)
 * 2. Named entries (key-value pairs where keys are strings and values are RegistryValue)
 * 3. Children (subkeys)
 *
 * Importantly, an entry in a key and a subkey of that same key can share a name. For example,
 * "/System" can have both an entry named "Boot" (value 456) and a child subkey "/System/Boot"
 * (which itself has a default value of 123). These are distinct and accessed differently:
 *   await system["party.openv.registry.readEntry"]("/System", "Boot")   // 456
 *   await system["party.openv.registry.readDefault"]("/System/Boot") // 123
 * 
 * The registry is similar to the Windows registry in structure and purpose, but has a more limited scope,
 * and makes no assumptions about how the registry is implemented on the backend.
 */
export interface RegistryReadComponent extends SystemComponent<typeof REGISTRY_READ_NAMESPACE_VERSIONED, typeof REGISTRY_READ_NAMESPACE> {
   
    /**
     * Reads a named entry from a registry key.
     * @param key The key to read from, specified as a path string (e.g. "/System/Boot")
     * @param entry The name of the entry to read (e.g. "LogLevel")
     * @returns The value of the entry, or null if the key or entry does not exist
     * 
     * @example
     * const logLevel = await system["party.openv.registry.readEntry"]("/System/Boot", "LogLevel");
     */
    ["party.openv.registry.read.readEntry"](key: string, entry: string): Promise<RegistryValue | null>;

    /**
     * Reads the default entry from a registry key.
     * @param key The key to read from, specified as a path string (e.g. "/System/Boot")
     * @returns The default value of the key, or null if the key does not exist
     *
     * @example
     * const cmdline = await system["party.openv.registry.readDefault"]("/System/Boot");
     * const logLevel = await system["party.openv.registry.readEntry"]("/System/Boot", "LogLevel");
     */
    ["party.openv.registry.read.readDefault"](key: string): Promise<RegistryValue | null>;

    /**
     * Lists all entries (excluding the default entry) from a registry key.
     * @param key The key to list entries from, specified as a path string (e.g. "/System/Associations")
     * @return An array of entry names, or null if the key does not exist
     * 
     * @example
     * const ext = ".txt";
     * const associations = await system["party.openv.registry.listEntries"]("/System/Associations");
     * if (associations.includes(ext)) {
     *     const mimeType = await system["party.openv.registry.readEntry"]("/System/Associations", ext);
     *     // ...
     * }
     */
    ["party.openv.registry.read.listEntries"](key: string): Promise<string[] | null>;

    /**
     * Lists all subkeys of a registry key.
     * @param key The key to list subkeys from, specified as a path string (e.g. "/System")
     * @return An array of subkey names, or null if the key does not exist
     * 
     * @example
     * const systemSubkeys = await system["party.openv.registry.listSubkeys"]("/System");
     * console.log("Subkeys of /System:", systemSubkeys);
     */
    ["party.openv.registry.read.listSubkeys"](key: string): Promise<string[] | null>;

    /**
     * Checks if a registry key exists.
     * @param key The key to check, specified as a path string (e.g. "/System/Boot")
     * @return True if the key exists, false otherwise
     *
     * @example
     * const keyExists = await system["party.openv.registry.keyExists"]("/System/Boot");
     * if (!keyExists) {
     *   throw new Error("No boot configuration present in registry");
     * }
     * // ...
     */
    ["party.openv.registry.read.keyExists"](key: string): Promise<boolean>;

    /**
     * Watches for changes to a specific registry entry. This is very powerful for reactive applications.
     * @param key The key to watch, specified as a path string (e.g. "/System/Boot")
     * @param entry The name of the entry to watch (e.g. "LogLevel")
     * @returns An object containing an async iterable of changes to the entry, and an abort function to stop watching
     * 
     * @example
     * const watcher = await system["party.openv.registry.watchEntry"]("/System/Boot", "LogLevel");
     * (async () => {
     *     for await (const newValue of watcher.changes) {
     *         console.log("LogLevel changed to:", newValue);
     *         // ... reconfigure logger
     *     }
     * })();
     */
    ["party.openv.registry.read.watchEntry"](key: string, entry: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }>;

    /**
     * Watches for changes to the default entry of a specific registry key. This is very powerful for reactive applications.
     * @param key The key to watch, specified as a path string (e.g. "/System/Boot")
     * @returns An object containing an async iterable of changes to the default entry, and an abort function to stop watching
     * 
     * @example
     * const watcher = await system["party.openv.registry.watchDefault"]("/System/Boot");
     * (async () => {
     *     for await (const newValue of watcher.changes) {
     *         console.log("Default boot configuration changed to:", newValue);
     *         // ... remind user to reboot system for changes to take effect
     *     }
     * })();
     */
    ["party.openv.registry.read.watchDefault"](key: string): Promise<{
        changes: AsyncIterable<RegistryValue | null>;
        abort: () => Promise<void>;
    }>;
}

/**
 * A system component for writing to the registry.
 * This namespace allows writing values to the system registry for configuration and other purposes.
 */
export interface RegistryWriteComponent extends SystemComponent<typeof REGISTRY_WRITE_NAMESPACE_VERSIONED, typeof REGISTRY_WRITE_NAMESPACE> {
    /**
     * Writes a value to a specific registry entry.
     * @param key The key to write to, specified as a path string (e.g. "/System/Boot")
     * @param entry The name of the entry to write (e.g. "LogLevel")
     * @param value The value to write to the entry
     * 
     * @example
     * await system["party.openv.registry.writeEntry"]("/System/Boot", "LogLevel", 4);
     */
    ["party.openv.registry.write.writeEntry"](key: string, entry: string, value: RegistryValue): Promise<void>;

    /**
     * Writes a value to the default entry of a specific registry key.
     * @param key The key to write to, specified as a path string (e.g. "/System/Boot")
     * @param value The value to write to the default entry
     * 
     * @example
     * await system["party.openv.registry.writeDefault"]("/System/Boot", "quiet");
     */
    ["party.openv.registry.write.writeDefault"](key: string, value: RegistryValue): Promise<void>;

    /**
     * Deletes a specific registry entry.
     * @param key The key to delete from, specified as a path string (e.g. "/System/Associations")
     * @param entry The name of the entry to delete (e.g. "LogLevel")
     * 
     * @example
     * await system["party.openv.registry.deleteEntry"]("/System/Associations", ".txt");
     */
    ["party.openv.registry.write.deleteEntry"](key: string, entry: string): Promise<void>;

    /**
     * Deletes a specific registry key.
     * @param key The key to delete, specified as a path string (e.g. "/System/Boot")
     * 
     * @example
     * await system["party.openv.registry.deleteKey"]("/System/Boot");
     * console.log("Bricked the registry :3");
     */
    ["party.openv.registry.write.deleteKey"](key: string): Promise<void>;

    /**
     * Creates a specific registry key.
     * @param key The key to create, specified as a path string (e.g. "/System/Boot")
     * 
     * @example
     * await system["party.openv.registry.createKey"]("/System/Boot");
     */
    ["party.openv.registry.write.createKey"](key: string): Promise<void>;
}
