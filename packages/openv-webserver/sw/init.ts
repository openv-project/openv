/// <reference lib="webworker" />
import {
    CoreFS, CoreOpEnv, CoreProcess, CoreRegistry, OPFS, TmpFs,
} from "@openv-project/openv-core";
import type { PlainParameter, RegistryValue } from "@openv-project/openv-api";
import { DEFAULT_PATCH_KEY, UPDATER_KEY, runUpdater } from "./updater.ts";
import { BRIDGE_DEFAULTS, applyBridgeConfig } from "./bridge.ts";
import { UPDATER_DEFAULTS } from "./updater.ts";
import { PEER_FILTER_DEFAULTS, applyPeerFilterConfig } from "./security.ts";
import { hydrateSystemRegistryFromIdb, startSystemRegistryPersistence, syncSystemRegistryToIdb } from "./system-registry-idb.ts";

export const openv = new CoreOpEnv();
export const coreRegistry = new CoreRegistry();
export const coreFs = new CoreFS();
export const coreProcess = new CoreProcess();

export const FS_FSTAB_KEY = "/system/party/openv/filesystem/fstab" as const;
const DEFAULT_FS_MOUNT_ID = "root" as const;
const DEFAULT_FS_MOUNT_IMPL = "party.openv.impl.opfs" as const;
const DEFAULT_FS_MOUNT_PATH = "/" as const;

type FsMountTupleEntry = [impl: string, path: string, extra?: PlainParameter];
type FsMountObjectEntry = {
    impl: string;
    path: string;
    extra?: PlainParameter;
};

const FS_FSTAB_DEFAULTS: [string, string, string][] = [
    [FS_FSTAB_KEY, DEFAULT_FS_MOUNT_ID, JSON.stringify([DEFAULT_FS_MOUNT_IMPL, DEFAULT_FS_MOUNT_PATH])],
];

openv.installSystemComponent(coreRegistry);
openv.installSystemComponent(coreFs);
openv.installSystemComponent(coreProcess);
coreProcess.setFsExt(coreFs);

// expose openv global for debug
(globalThis as any).openv = openv;

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        await new TmpFs().register(coreFs);
        await new OPFS().register(coreFs);

        await hydrateSystemRegistryFromIdb(coreRegistry);
        await scaffoldRegistry();
        await applyFsMountsFromRegistry();
        await syncSystemRegistryToIdb(coreRegistry);
        await startSystemRegistryPersistence(coreRegistry);
        await runUpdater();
        await applyBridgeConfig();
        await applyPeerFilterConfig();

        initialized = true;
        initPromise = null;
    })();

    return initPromise;
}

export async function ensureDefault(key: string, entry: string, value: RegistryValue): Promise<void> {
    await coreRegistry["party.openv.registry.write.createKey"](key).catch(() => { });
    const existing = await coreRegistry["party.openv.registry.read.readEntry"](key, entry);
    if (existing === null) {
        await coreRegistry["party.openv.registry.write.writeEntry"](key, entry, value);
    }
}

const ACL_KEY = "/system/party/openv/registry/acl" as const;

type ACLEntry = {
    read: "any" | "owner" | number | number[];
    write: "any" | "owner" | number | number[];
    readGroups?: number[];
    writeGroups?: number[];
};

function acl(entry: ACLEntry): string {
    return JSON.stringify(entry);
}

async function ensureKey(key: string): Promise<void> {
    await coreRegistry["party.openv.registry.write.createKey"](key).catch(() => { });
}

async function scaffoldRegistry(): Promise<void> {
    await ensureKey("/system");
    await ensureKey("/api");
    await ensureKey("/users");
    await ensureKey("/groups");

    await ensureKey("/system/party");
    await ensureKey("/system/party/openv");
    await ensureKey("/system/party/openv/filesystem");
    await ensureKey(FS_FSTAB_KEY);
    await ensureKey("/system/party/openv/registry");
    await ensureKey("/system/party/openv/registry/acl");
    await ensureKey("/system/party/openv/serviceWorker");
    await ensureKey("/system/party/openv/serviceWorker/bridge");
    await ensureKey("/system/party/openv/serviceWorker/peerFilter");
    await ensureKey(UPDATER_KEY);
    await ensureKey(DEFAULT_PATCH_KEY);

    await ensureKey("/api/party");
    await ensureKey("/api/party/openv");

    await ensureDefault(ACL_KEY, "/system/party/openv/registry/acl/**", acl({
        read: "any",
        write: 0,
    }));

    await ensureDefault(ACL_KEY, "/system/**", acl({
        read: "any",
        write: 0,
    }));

    await ensureDefault(ACL_KEY, "/users/*/**", acl({
        read: "any",
        write: "owner",
    }));

    await ensureDefault(ACL_KEY, "/users/*", acl({
        read: "any",
        write: "owner",
    }));

    await ensureDefault(ACL_KEY, "/groups/**", acl({
        read: "any",
        write: 0,
    }));

    for (const [key, entry, value] of [...BRIDGE_DEFAULTS, ...PEER_FILTER_DEFAULTS, ...UPDATER_DEFAULTS, ...FS_FSTAB_DEFAULTS]) {
        await ensureDefault(key, entry, value);
    }
}

function parseFsMountEntry(raw: RegistryValue): FsMountObjectEntry | null {
    if (typeof raw !== "string") return null;

    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        return null;
    }

    if (Array.isArray(decoded)) {
        const tuple = decoded as FsMountTupleEntry;
        if (typeof tuple[0] !== "string" || typeof tuple[1] !== "string") return null;
        return {
            impl: tuple[0],
            path: tuple[1],
            extra: tuple[2],
        };
    }

    if (decoded && typeof decoded === "object") {
        const obj = decoded as FsMountObjectEntry;
        if (typeof obj.impl !== "string" || typeof obj.path !== "string") return null;
        return obj;
    }

    return null;
}

async function applyFsMountsFromRegistry(): Promise<void> {
    const mountIds = await coreRegistry["party.openv.registry.read.listEntries"](FS_FSTAB_KEY) ?? [];
    mountIds.sort((a, b) => {
        if (a === DEFAULT_FS_MOUNT_ID) return -1;
        if (b === DEFAULT_FS_MOUNT_ID) return 1;
        return a.localeCompare(b);
    });

    for (const mountId of mountIds) {
        const rawEntry = await coreRegistry["party.openv.registry.read.readEntry"](FS_FSTAB_KEY, mountId);
        if (rawEntry === null) continue;

        const mount = parseFsMountEntry(rawEntry);
        if (!mount) {
            console.warn(`[init] invalid fstab mount entry at ${FS_FSTAB_KEY}/${mountId}; expected JSON tuple [impl, path, extra?] or object { impl, path, extra? }`);
            continue;
        }

        await coreFs["party.openv.filesystem.virtual.mount"](mount.impl, mount.path, mount.extra);
    }
}