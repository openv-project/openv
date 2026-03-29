/// <reference lib="webworker" />
import {
    CoreFS, CoreOpEnv, CoreProcess, CoreRegistry, DevFS, OPFS, TmpFs,
} from "@openv-project/openv-core";
import { CoreScriptEvaluator } from "@openv-project/openv-core/syscall/script";
import type { PlainParameter, RegistryValue } from "@openv-project/openv-api";
import { BRIDGE_DEFAULTS, applyBridgeConfig } from "./bridge.ts";
import { PEER_FILTER_DEFAULTS, applyPeerFilterConfig } from "./security.ts";
import { hydrateSystemRegistryFromIdb, startSystemRegistryPersistence, syncSystemRegistryToIdb } from "./regtab.ts";
import { runBootScripts } from "./boot.ts";

export const openv = new CoreOpEnv();
export const coreRegistry = new CoreRegistry();
export const coreFs = new CoreFS();
export const coreProcess = new CoreProcess();
export const coreScriptEvaluator = new CoreScriptEvaluator();
export const devFs = new DevFS();

export const FS_FSTAB_KEY = "/system/party/openv/filesystem/fstab" as const;
export const REGTAB_KEY = "/system/party/openv/registry/regtab" as const;
export const BOOT_KEY = "/system/party/openv/boot" as const;
const DEFAULT_FS_MOUNT_ID = "root" as const;
const DEFAULT_FS_MOUNT_PATH = "/" as const;
const DEFAULT_FS_MOUNT_IMPL = "party.openv.impl.opfs" as const;
const DEFAULT_FS_MOUNT_EXTRA = "opfs" as const;
const TMP_FS_MOUNT_ID = "tmp" as const;
const TMP_FS_MOUNT_IMPL = "party.openv.impl.tmpfs" as const;
const TMP_FS_MOUNT_PATH = "/tmp" as const;
const SHM_FS_MOUNT_ID = "shm" as const;
const SHM_FS_MOUNT_IMPL = "party.openv.impl.tmpfs" as const;
const SHM_FS_MOUNT_PATH = "/dev/shm" as const;
const DEV_FS_MOUNT_ID = "dev" as const;
const DEV_FS_MOUNT_IMPL = "party.openv.impl.devfs" as const;
const DEV_FS_MOUNT_PATH = "/dev" as const;
const DEFAULT_REGTAB_ID = "system" as const;
const DEFAULT_REGTAB_STORE_DIR = "/var/lib/registry/system" as const;

type FsMountTupleEntry = [impl: string, path: string, extra?: PlainParameter];
type FsMountObjectEntry = {
    impl: string;
    path: string;
    extra?: PlainParameter;
};

type RootMountConfig = {
    impl: string;
    path: string;
    extra?: PlainParameter;
};

function resolveRootMountConfig(rootParam?: string | null): RootMountConfig {
    switch ((rootParam ?? "").trim().toLowerCase()) {
        case "tmpfs":
            return { impl: TMP_FS_MOUNT_IMPL, path: DEFAULT_FS_MOUNT_PATH };
        case "opfs":
        case "":
            return { impl: DEFAULT_FS_MOUNT_IMPL, path: DEFAULT_FS_MOUNT_PATH, extra: DEFAULT_FS_MOUNT_EXTRA };
        default:
            return { impl: DEFAULT_FS_MOUNT_IMPL, path: DEFAULT_FS_MOUNT_PATH, extra: DEFAULT_FS_MOUNT_EXTRA };
    }
}

function fsFstabDefaults(rootMount: RootMountConfig): [string, string, string][] {
    const rootTuple: [string, string, PlainParameter?] = [rootMount.impl, rootMount.path, rootMount.extra];
    return [
        [FS_FSTAB_KEY, DEFAULT_FS_MOUNT_ID, JSON.stringify(rootTuple)],
        [FS_FSTAB_KEY, TMP_FS_MOUNT_ID, JSON.stringify([TMP_FS_MOUNT_IMPL, TMP_FS_MOUNT_PATH])],
        [FS_FSTAB_KEY, DEV_FS_MOUNT_ID, JSON.stringify([DEV_FS_MOUNT_IMPL, DEV_FS_MOUNT_PATH])],
        [FS_FSTAB_KEY, SHM_FS_MOUNT_ID, JSON.stringify([SHM_FS_MOUNT_IMPL, SHM_FS_MOUNT_PATH])],
    ];
}

const BOOT_DEFAULTS: [string, string, RegistryValue][] = [
    [BOOT_KEY, "enabled", true],
    [BOOT_KEY, "scripts", JSON.stringify(["/boot/**"])],
    [BOOT_KEY, "stopOnError", false],
];

const REGTAB_DEFAULTS: [string, string, RegistryValue][] = [
    [REGTAB_KEY, DEFAULT_REGTAB_ID, JSON.stringify({ baseKey: "/system", storeDir: DEFAULT_REGTAB_STORE_DIR })],
];

openv.installSystemComponent(coreRegistry);
openv.installSystemComponent(coreFs);
openv.installSystemComponent(devFs);
openv.installSystemComponent(coreProcess);
openv.installSystemComponent(coreScriptEvaluator);
coreProcess.setFsExt(coreFs);

// expose openv global for debug
(globalThis as any).openv = openv;

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const swUrl = new URL(self.location.href);
        const rootMount = resolveRootMountConfig(swUrl.searchParams.get("root"));

        await new TmpFs().register(coreFs);
        await new OPFS().register(coreFs);
        await devFs.register(coreFs);
        await coreFs["party.openv.filesystem.virtual.mount"](rootMount.impl, rootMount.path, rootMount.extra);

        await hydrateSystemRegistryFromIdb(coreRegistry, coreFs);
        await scaffoldRegistry();
        await applyFsMountsFromRegistry();
        await scaffoldBootDirectory();
        await syncSystemRegistryToIdb(coreRegistry, coreFs);
        await startSystemRegistryPersistence(coreRegistry, coreFs);
        await applyBridgeConfig();
        await applyPeerFilterConfig();

        // Run boot scripts after all core systems are initialized
        await runBootScripts(openv);

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
    await ensureKey(REGTAB_KEY);
    await ensureKey("/system/party/openv/serviceWorker");
    await ensureKey("/system/party/openv/serviceWorker/bridge");
    await ensureKey("/system/party/openv/serviceWorker/peerFilter");
    await ensureKey(BOOT_KEY);

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

    const swUrl = new URL(self.location.href);
    const rootMount = resolveRootMountConfig(swUrl.searchParams.get("root"));
    const defaults = fsFstabDefaults(rootMount);
    for (const [key, entry, value] of [...BRIDGE_DEFAULTS, ...PEER_FILTER_DEFAULTS, ...defaults, ...REGTAB_DEFAULTS, ...BOOT_DEFAULTS]) {
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

        try {
            await coreFs["party.openv.filesystem.virtual.mount"](mount.impl, mount.path, mount.extra);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("already") || message.includes("occupied")) continue;
            throw err;
        }
    }
}

async function scaffoldBootDirectory(): Promise<void> {
    try {
        await coreFs["party.openv.filesystem.write.mkdir"]("/boot", 0o755);
    } catch {
        // Directory may already exist
    }
}
