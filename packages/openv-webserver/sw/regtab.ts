/// <reference lib="webworker" />
import type { FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent } from "@openv-project/openv-api";
import type { CoreRegistry } from "@openv-project/openv-core";
import {
    hydrateRegistryFromFilesystem,
    startRegistryFilesystemPersistence,
    syncRegistryToFilesystem,
    type RegistryFsMapEntry,
} from "@openv-project/openv-core";

const DEFAULT_REGTAB_KEY = "/system/party/openv/registry/regtab";
const DEFAULT_BASE_KEY = "/system";
const DEFAULT_STORE_DIR = "/var/lib/registry/system";

type FsSystem = FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent;

async function readRegtabMap(registry: CoreRegistry): Promise<RegistryFsMapEntry[]> {
    const entries = await registry["party.openv.registry.read.listEntries"](DEFAULT_REGTAB_KEY);
    if (!entries || entries.length === 0) {
        return [{ baseKey: DEFAULT_BASE_KEY, storeDir: DEFAULT_STORE_DIR }];
    }

    const map: RegistryFsMapEntry[] = [];
    for (const id of entries) {
        const raw = await registry["party.openv.registry.read.readEntry"](DEFAULT_REGTAB_KEY, id);
        if (typeof raw !== "string") continue;
        try {
            const parsed = JSON.parse(raw) as { baseKey?: unknown; storeDir?: unknown };
            if (typeof parsed.baseKey === "string" && typeof parsed.storeDir === "string") {
                map.push({ baseKey: parsed.baseKey, storeDir: parsed.storeDir });
            }
        } catch {
            continue;
        }
    }

    if (map.length === 0) {
        return [{ baseKey: DEFAULT_BASE_KEY, storeDir: DEFAULT_STORE_DIR }];
    }
    return map;
}

export async function hydrateSystemRegistryFromIdb(registry: CoreRegistry, fs: FsSystem): Promise<void> {
    const map = await readRegtabMap(registry);
    await hydrateRegistryFromFilesystem(registry, fs, map);
}

export async function syncSystemRegistryToIdb(registry: CoreRegistry, fs: FsSystem): Promise<void> {
    const map = await readRegtabMap(registry);
    await syncRegistryToFilesystem(registry, fs, map);
}

export async function startSystemRegistryPersistence(registry: CoreRegistry, fs: FsSystem): Promise<void> {
    const map = await readRegtabMap(registry);
    await startRegistryFilesystemPersistence(registry, fs, map);
}
