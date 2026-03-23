/// <reference lib="webworker" />
import {
    CoreFS, CoreOpEnv, CoreProcess, CoreRegistry, OPFS, TmpFs,
} from "@openv-project/openv-core";
import type { RegistryValue } from "@openv-project/openv-api";
import { DEFAULT_PATCH_KEY, UPDATER_KEY, runUpdater } from "./updater.ts";
import { BRIDGE_DEFAULTS, applyBridgeConfig } from "./bridge.ts";
import { UPDATER_DEFAULTS } from "./updater.ts";

export const openv = new CoreOpEnv();
export const coreRegistry = new CoreRegistry();
export const coreFs = new CoreFS();
export const coreProcess = new CoreProcess();

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
        const opfs = new OPFS();
        await opfs.register(coreFs);
        await coreFs["party.openv.filesystem.virtual.mount"]("party.openv.impl.opfs", "/");

        await scaffoldRegistry();
        await runUpdater();
        await applyBridgeConfig();

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
    await ensureKey("/system/party/openv/registry");
    await ensureKey("/system/party/openv/registry/acl");
    await ensureKey("/system/party/openv/serviceWorker");
    await ensureKey("/system/party/openv/serviceWorker/bridge");
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

    for (const [key, entry, value] of [...BRIDGE_DEFAULTS, ...UPDATER_DEFAULTS]) {
        await ensureDefault(key, entry, value);
    }
}