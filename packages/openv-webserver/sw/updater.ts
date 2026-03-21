/// <reference lib="webworker" />
import { parseTar } from "nanotar";
import { coreFs, coreRegistry } from "./init.ts";

export const UPDATER_BEHAVIOR_DISABLED = 0;
export const UPDATER_BEHAVIOR_IF_MISSING = 1;
export const UPDATER_BEHAVIOR_OVERWRITE = 2;

export const UPDATER_DEFAULTS: [string, string, string | number][] = [
    ["/Updater/Stage0", "Behavior", UPDATER_BEHAVIOR_OVERWRITE],
    ["/Updater/Stage0", "Src", "/stage0.tar"],
    ["/Updater/Stage0", "Dest", "/"],
];

export async function runUpdater(): Promise<void> {
    const behavior = await coreRegistry["party.openv.registry.read.readEntry"](
        "/Updater/Stage0", "Behavior"
    ) as number;

    if (behavior === UPDATER_BEHAVIOR_DISABLED) {
        console.log("[updater] stage0 disabled, skipping");
        return;
    }

    const src = await coreRegistry["party.openv.registry.read.readEntry"]("/Updater/Stage0", "Src") as string;
    const dest = await coreRegistry["party.openv.registry.read.readEntry"]("/Updater/Stage0", "Dest") as string;

    console.log(`[updater] stage0 behavior=${behavior} src=${src} dest=${dest}`);

    let tarData: Uint8Array;
    try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`fetch ${src} failed: ${res.status}`);
        tarData = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        console.error("[updater] failed to fetch tar:", err);
        return;
    }

    const files = parseTar(tarData);
    console.log(`[updater] tar contains ${files.length} entries`);

    let installed = 0;
    let skipped = 0;

    for (const file of files) {
        if (!file.name || file.type === "directory") continue;

        const destPath = dest.endsWith("/") ? dest + file.name : dest + "/" + file.name;
        const normalized = "/" + destPath.replace(/\/+/g, "/").replace(/^\/+/, "");

        if (behavior === UPDATER_BEHAVIOR_IF_MISSING) {
            try {
                await coreFs["party.openv.filesystem.read.stat"](normalized);
                skipped++;
                continue;
            } catch { }
        }

        const parts = normalized.split("/").filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            await coreFs["party.openv.filesystem.write.mkdir"](
                "/" + parts.slice(0, i).join("/")
            ).catch(() => { });
        }

        if (behavior === UPDATER_BEHAVIOR_OVERWRITE) {
            await coreFs["party.openv.filesystem.write.unlink"](normalized).catch(() => { });
        }

        try {
            await coreFs["party.openv.filesystem.write.create"](normalized);
            const fd = await coreFs["party.openv.filesystem.open"](normalized, "w", 0o644);
            await coreFs["party.openv.filesystem.write.write"](fd, file.data!);
            await coreFs["party.openv.filesystem.close"](fd);
            installed++;
        } catch (err) {
            console.warn(`[updater] failed to write ${normalized}:`, err);
        }
    }

    console.log(`[updater] stage0 complete: installed=${installed} skipped=${skipped}`);
}