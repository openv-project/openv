/// <reference lib="webworker" />
import { coreFs, coreRegistry, ensureInitialized } from "./init.ts";

export const BRIDGE_KEY = "/system/party/openv/serviceWorker/bridge" as const;
const BRIDGE_FS_CACHE_NAME = "party-openv-serviceworker-bridge-fscache-v1";
const BRIDGE_DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

type BridgeCacheValidationMode = "strict" | "async";

export let bridgeEnabled = true;
export let bridgeCacheEnabled = true;
export let bridgeCacheMaxBytes = BRIDGE_DEFAULT_CACHE_MAX_BYTES;
export let bridgeCacheValidationMode: BridgeCacheValidationMode = "async";
export let bridgePaths: [string, string][] = [
    ["/@/", "/"],
    ["/", "/srv/openv-webos"],
];

export const BRIDGE_DEFAULTS: [string, string, string | number | boolean][] = [
    [BRIDGE_KEY, "enabled", true],
    [BRIDGE_KEY, "cacheEnabled", true],
    [BRIDGE_KEY, "cacheMaxBytes", BRIDGE_DEFAULT_CACHE_MAX_BYTES],
    [BRIDGE_KEY, "cacheValidationMode", "async"],
    [BRIDGE_KEY, "paths", JSON.stringify(bridgePaths)],
];

let fsCachePromise: Promise<Cache> | null = null;

export async function applyBridgeConfig(): Promise<void> {
    const enabledVal = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "enabled");
    bridgeEnabled = enabledVal !== false;

    const cacheEnabledVal = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "cacheEnabled");
    bridgeCacheEnabled = cacheEnabledVal !== false;

    const cacheMaxBytesVal = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "cacheMaxBytes");
    if (typeof cacheMaxBytesVal === "number" && Number.isFinite(cacheMaxBytesVal) && cacheMaxBytesVal >= 0) {
        bridgeCacheMaxBytes = Math.floor(cacheMaxBytesVal);
    } else {
        bridgeCacheMaxBytes = BRIDGE_DEFAULT_CACHE_MAX_BYTES;
    }

    const validationModeVal = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "cacheValidationMode");
    bridgeCacheValidationMode = validationModeVal === "strict" ? "strict" : "async";

    const pathsRaw = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "paths");
    try {
        if (pathsRaw) bridgePaths = JSON.parse(pathsRaw as string);
    } catch { }
}

export function handleFetch(event: FetchEvent): void {
    if (event.request.method !== "GET") return;

    event.respondWith((async () => {
        await ensureInitialized();

        if (!bridgeEnabled) return fetch(event.request);

        const url = new URL(event.request.url);
        const reqPath = url.pathname;

        let matchedWebPrefix: string | null = null;
        let matchedFsPrefix: string | null = null;

        for (const [webPrefix, fsPrefix] of bridgePaths) {
            if (reqPath.startsWith(webPrefix)) {
                if (matchedWebPrefix === null || webPrefix.length > matchedWebPrefix.length) {
                    matchedWebPrefix = webPrefix;
                    matchedFsPrefix = fsPrefix;
                }
            }
        }

        if (matchedWebPrefix === null) return fetch(event.request);

        const remainder = reqPath.slice(matchedWebPrefix.length);
        const joined = matchedFsPrefix!.endsWith("/") || remainder.startsWith("/")
            ? `${matchedFsPrefix}${remainder}`
            : `${matchedFsPrefix}/${remainder}`;
        const normalized = "/" + joined.replace(/\/+/g, "/").replace(/^\/+/, "");

        return serveFsPath(normalized, event);
    })());
}

async function serveFsPath(fsPath: string, event?: FetchEvent): Promise<Response> {
    try {
        if (bridgeCacheEnabled && bridgeCacheValidationMode === "async") {
            const fastCached = await tryServeCachedFast(fsPath, event);
            if (fastCached) return fastCached;
        }

        const stat = await coreFs["party.openv.filesystem.read.stat"](fsPath);

        if (stat.type === "DIRECTORY") {
            try {
                const indexPath = fsPath.replace(/\/$/, "") + "/index.html";
                const indexStat = await coreFs["party.openv.filesystem.read.stat"](indexPath);
                return serveFsFile(indexPath, indexStat, "text/html");
            } catch {
                const entries = await coreFs["party.openv.filesystem.read.readdir"](fsPath);
                return new Response(JSON.stringify({ ok: entries }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        return serveFsFile(fsPath, stat);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes("ENOENT") ? 404 : 500;
        return new Response(JSON.stringify({ err: msg }), {
            status,
            headers: { "Content-Type": "application/json" }
        });
    }
}

type FsStat = {
    type: "DIRECTORY" | "FILE";
    size: number;
    atime: number;
    mtime: number;
    ctime: number;
    name: string;
    uid: number;
    gid: number;
    mode: number;
    node: string;
};

async function serveFsFile(fsPath: string, stat: FsStat, forcedContentType?: string): Promise<Response> {
    const contentType = forcedContentType ?? guessContentType(fsPath);
    const validator = makeValidator(fsPath, stat);

    if (bridgeCacheEnabled && stat.size <= bridgeCacheMaxBytes) {
        const cache = await getFsCache();
        const cacheKey = buildCacheRequest(fsPath);
        const cached = await cache.match(cacheKey);

        if (cached && cached.headers.get("X-Openv-Fs-Validator") === validator) {
            return cached;
        }

        const fresh = await readAndBuildFileResponse(fsPath, stat, contentType, validator);
        await cache.put(cacheKey, fresh.clone()).catch(() => { });
        return fresh;
    }

    return readAndBuildFileResponse(fsPath, stat, contentType, validator);
}

async function tryServeCachedFast(fsPath: string, event?: FetchEvent): Promise<Response | null> {
    const cache = await getFsCache();
    const cacheKey = buildCacheRequest(fsPath);
    const cached = await cache.match(cacheKey);
    if (!cached) return null;

    if (event) {
        const priorValidator = cached.headers.get("X-Openv-Fs-Validator");
        event.waitUntil(refreshCachedEntry(fsPath, priorValidator));
    }

    return cached;
}

async function refreshCachedEntry(fsPath: string, priorValidator: string | null): Promise<void> {
    try {
        const stat = await coreFs["party.openv.filesystem.read.stat"](fsPath);
        if (stat.type !== "FILE") return;

        const cacheKey = buildCacheRequest(fsPath);
        const cache = await getFsCache();

        if (stat.size > bridgeCacheMaxBytes) {
            await cache.delete(cacheKey).catch(() => { });
            return;
        }

        const validator = makeValidator(fsPath, stat);
        if (priorValidator === validator) return;

        const fresh = await readAndBuildFileResponse(fsPath, stat, guessContentType(fsPath), validator);
        await cache.put(cacheKey, fresh).catch(() => { });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ENOENT")) {
            console.warn(`[bridge] async cache refresh failed for ${fsPath}:`, err);
        }
    }
}

async function readAndBuildFileResponse(
    fsPath: string,
    stat: FsStat,
    contentType: string,
    validator: string,
): Promise<Response> {
    const data = await readFsBytes(fsPath, stat.size);
    const body = new Uint8Array(data.byteLength);
    body.set(data);
    return new Response(body, {
        headers: {
            "Content-Type": contentType,
            "Cache-Control": "no-cache",
            "Last-Modified": new Date(stat.mtime).toUTCString(),
            "ETag": `W/\"${validator}\"`,
            "X-Openv-Fs-Validator": validator,
        }
    });
}

async function readFsBytes(fsPath: string, length: number): Promise<Uint8Array> {
    const fd = await coreFs["party.openv.filesystem.open"](fsPath, "r", 0o444);
    try {
        return await coreFs["party.openv.filesystem.read.read"](fd, length);
    } finally {
        await coreFs["party.openv.filesystem.close"](fd).catch(() => { });
    }
}

function buildCacheRequest(fsPath: string): Request {
    const url = new URL(`/__openv_fs_cache__/${encodeURIComponent(fsPath)}`, self.location.origin);
    return new Request(url.toString(), { method: "GET" });
}

function getFsCache(): Promise<Cache> {
    fsCachePromise ??= caches.open(BRIDGE_FS_CACHE_NAME);
    return fsCachePromise;
}

function makeValidator(fsPath: string, stat: FsStat): string {
    return [fsPath, stat.type, stat.size, stat.mtime, stat.ctime, stat.node].join("|");
}

function guessContentType(path: string): string {
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
    if (path.endsWith(".ts")) return "application/typescript";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".txt")) return "text/plain";
    if (path.endsWith(".wasm")) return "application/wasm";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".svg")) return "image/svg+xml";
    return "application/octet-stream";
}