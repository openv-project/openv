/// <reference lib="webworker" />
import {
    CoreFS, CoreOpEnv, CoreProcess, CoreRegistry, TmpFs,
} from "@openv-project/openv-core";
import type { RegistryValue } from "@openv-project/openv-api";
import { runUpdater } from "./updater.ts";
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

(globalThis as any).openv = openv;

// ─── Lazy init ────────────────────────────────────────────────────────────────

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        await new TmpFs().register(coreFs);
        await coreFs["party.openv.filesystem.virtual.mount"]("party.openv.impl.tmpfs", "/");

        await applyRegistryDefaults();
        await applyBridgeConfig();
        await runUpdater();

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

async function applyRegistryDefaults(): Promise<void> {
    for (const [key, entry, value] of [...BRIDGE_DEFAULTS, ...UPDATER_DEFAULTS]) {
        await ensureDefault(key, entry, value);
    }
}