/// <reference lib="webworker" />
import { parseTar } from "nanotar";
import { coreFs, coreRegistry } from "./init.ts";

export const UPDATER_KEY = "/system/party/openv/serviceWorker/updater" as const;
export const UPDATER_HISTORY_FILE = "/var/lib/serviceWorker/updaterhistory.jsonl" as const;

export const UPDATER_BEHAVIOR_DISABLED = 0;
export const UPDATER_BEHAVIOR_IF_MISSING = 1;
export const UPDATER_BEHAVIOR_OVERWRITE = 2;

export const DEFAULT_PATCH_TASK = {
    id: "stage0",
    apply: true,
    consumed: false,
    behavior: UPDATER_BEHAVIOR_OVERWRITE,
    src: "/stage0.tar",
    dest: "/",
} as const;

export const DEFAULT_PATCH_KEY = `${UPDATER_KEY}/${DEFAULT_PATCH_TASK.id}` as const;

export const UPDATER_DEFAULTS: [string, string, string | number | boolean][] = [
    [UPDATER_KEY, "enabled", true],
    [DEFAULT_PATCH_KEY, "apply", DEFAULT_PATCH_TASK.apply],
    [DEFAULT_PATCH_KEY, "consumed", DEFAULT_PATCH_TASK.consumed],
    [DEFAULT_PATCH_KEY, "behavior", DEFAULT_PATCH_TASK.behavior],
    [DEFAULT_PATCH_KEY, "src", DEFAULT_PATCH_TASK.src],
    [DEFAULT_PATCH_KEY, "dest", DEFAULT_PATCH_TASK.dest],
];

type UpdaterTask = {
    id: string;
    key: string;
    apply: boolean;
    consumed: boolean;
    behavior: number;
    src: string;
    dest: string;
    timestamp: number | null;
};

type TaskApplyResult = {
    status: "success" | "partial" | "failed";
    installed: number;
    skipped: number;
    failedWrites: number;
    errors: string[];
};

type HistoryRecord = {
    taskId: string;
    key: string;
    src: string;
    dest: string;
    behavior: number;
    timestamp: number | null;
    startedAt: number;
    finishedAt: number;
    status: "success" | "partial" | "failed";
    installed: number;
    skipped: number;
    failedWrites: number;
    errors: string[];
};

export async function runUpdater(): Promise<void> {
    const enabled = await coreRegistry["party.openv.registry.read.readEntry"](UPDATER_KEY, "enabled");
    if (enabled === false) {
        console.log("[updater] updater disabled at root key, skipping all tasks");
        return;
    }

    const taskNames = await coreRegistry["party.openv.registry.read.listSubkeys"](UPDATER_KEY) ?? [];
    const tasks = (await Promise.all(taskNames.map((taskName) => readTask(taskName))))
        .filter((task): task is UpdaterTask => task !== null)
        .filter((task) => task.apply && !task.consumed)
        .sort(compareTasks);

    if (tasks.length === 0) {
        console.log("[updater] no pending tasks");
        return;
    }

    console.log(`[updater] found ${tasks.length} pending task(s)`);

    for (const task of tasks) {
        const startedAt = Date.now();
        console.log(`[updater] task=${task.id} behavior=${task.behavior} src=${task.src} dest=${task.dest}`);

        const result = await applyTask(task);
        const finishedAt = Date.now();

        if (result.status === "success") {
            await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "consumed", true).catch(() => { });
            await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "apply", false).catch(() => { });
            await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "lastAppliedAt", finishedAt).catch(() => { });
            await coreRegistry["party.openv.registry.write.deleteEntry"](task.key, "lastError").catch(() => { });
        } else {
            const errorText = result.errors.join("; ").slice(0, 1_500);
            await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "lastError", errorText).catch(() => { });
        }

        await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "lastResult", result.status).catch(() => { });
        await coreRegistry["party.openv.registry.write.writeEntry"](task.key, "lastRunAt", finishedAt).catch(() => { });

        const history: HistoryRecord = {
            taskId: task.id,
            key: task.key,
            src: task.src,
            dest: task.dest,
            behavior: task.behavior,
            timestamp: task.timestamp,
            startedAt,
            finishedAt,
            status: result.status,
            installed: result.installed,
            skipped: result.skipped,
            failedWrites: result.failedWrites,
            errors: result.errors,
        };
        await appendHistory(history);

        console.log(
            `[updater] task=${task.id} status=${result.status} installed=${result.installed} skipped=${result.skipped} failedWrites=${result.failedWrites}`
        );
    }

    console.log(`[updater] run complete: processed=${tasks.length}`);
}

async function readTask(taskName: string): Promise<UpdaterTask | null> {
    const key = `${UPDATER_KEY}/${taskName}`;

    const [applyVal, consumedVal, behaviorVal, srcVal, destVal, timestampVal] = await Promise.all([
        coreRegistry["party.openv.registry.read.readEntry"](key, "apply"),
        coreRegistry["party.openv.registry.read.readEntry"](key, "consumed"),
        coreRegistry["party.openv.registry.read.readEntry"](key, "behavior"),
        coreRegistry["party.openv.registry.read.readEntry"](key, "src"),
        coreRegistry["party.openv.registry.read.readEntry"](key, "dest"),
        coreRegistry["party.openv.registry.read.readEntry"](key, "timestamp"),
    ]);

    if (typeof srcVal !== "string" || srcVal.length === 0) return null;
    if (typeof destVal !== "string" || destVal.length === 0) return null;

    return {
        id: taskName,
        key,
        apply: applyVal === true,
        consumed: consumedVal === true,
        behavior: typeof behaviorVal === "number" ? behaviorVal : UPDATER_BEHAVIOR_OVERWRITE,
        src: srcVal,
        dest: destVal,
        timestamp: typeof timestampVal === "number" ? timestampVal : null,
    };
}

function compareTasks(a: UpdaterTask, b: UpdaterTask): number {
    if (a.timestamp === null && b.timestamp !== null) return 1;
    if (a.timestamp !== null && b.timestamp === null) return -1;
    if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
    }
    return a.id.localeCompare(b.id);
}

async function applyTask(task: UpdaterTask): Promise<TaskApplyResult> {
    if (task.behavior === UPDATER_BEHAVIOR_DISABLED) {
        return {
            status: "success",
            installed: 0,
            skipped: 0,
            failedWrites: 0,
            errors: [],
        };
    }

    let tarData: Uint8Array;
    try {
        const res = await fetch(task.src);
        if (!res.ok) throw new Error(`fetch ${task.src} failed: ${res.status}`);
        tarData = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        return {
            status: "failed",
            installed: 0,
            skipped: 0,
            failedWrites: 0,
            errors: [stringifyError(err)],
        };
    }

    const files = parseTar(tarData);

    let installed = 0;
    let skipped = 0;
    let failedWrites = 0;
    const errors: string[] = [];

    for (const file of files) {
        if (!file.name || file.type === "directory") continue;

        const destPath = task.dest.endsWith("/") ? task.dest + file.name : task.dest + "/" + file.name;
        const normalized = "/" + destPath.replace(/\/+/g, "/").replace(/^\/+/, "");

        if (task.behavior === UPDATER_BEHAVIOR_IF_MISSING) {
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

        if (task.behavior === UPDATER_BEHAVIOR_OVERWRITE) {
            await coreFs["party.openv.filesystem.write.unlink"](normalized).catch(() => { });
        }

        try {
            await coreFs["party.openv.filesystem.write.create"](normalized);
            const fd = await coreFs["party.openv.filesystem.open"](normalized, "w", 0o644);
            await coreFs["party.openv.filesystem.write.write"](fd, file.data!);
            await coreFs["party.openv.filesystem.close"](fd);
            installed++;
        } catch (err) {
            failedWrites++;
            errors.push(`write ${normalized}: ${stringifyError(err)}`);
            console.warn(`[updater] failed to write ${normalized}:`, err);
        }
    }

    return {
        status: failedWrites > 0 ? "partial" : "success",
        installed,
        skipped,
        failedWrites,
        errors,
    };
}

async function appendHistory(record: HistoryRecord): Promise<void> {
    await ensureParentDirs(UPDATER_HISTORY_FILE);
    await coreFs["party.openv.filesystem.write.create"](UPDATER_HISTORY_FILE).catch(() => { });

    const fd = await coreFs["party.openv.filesystem.open"](UPDATER_HISTORY_FILE, "a", 0o644);
    try {
        const line = JSON.stringify(record) + "\n";
        await coreFs["party.openv.filesystem.write.write"](fd, new TextEncoder().encode(line));
    } finally {
        await coreFs["party.openv.filesystem.close"](fd).catch(() => { });
    }
}

async function ensureParentDirs(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
        await coreFs["party.openv.filesystem.write.mkdir"]("/" + parts.slice(0, i).join("/")).catch(() => { });
    }
}

function stringifyError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}