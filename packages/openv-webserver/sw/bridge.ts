/// <reference lib="webworker" />
import { coreFs, coreRegistry, ensureInitialized } from "./init.ts";

export const BRIDGE_KEY = "/system/party/openv/serviceWorker/bridge" as const;

export let bridgeEnabled = true;
export let bridgePaths: [string, string][] = [
    ["/@/", "/"],
    ["/", "/srv/openv-webos"],
];

export const BRIDGE_DEFAULTS: [string, string, string | boolean][] = [
    [BRIDGE_KEY, "enabled", true],
    [BRIDGE_KEY, "paths", JSON.stringify(bridgePaths)],
];

export async function applyBridgeConfig(): Promise<void> {
    const enabledVal = await coreRegistry["party.openv.registry.read.readEntry"](BRIDGE_KEY, "enabled");
    bridgeEnabled = enabledVal !== false;

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

        return serveFsPath(normalized);
    })());
}

async function serveFsPath(fsPath: string): Promise<Response> {
    try {
        const stat = await coreFs["party.openv.filesystem.read.stat"](fsPath);

        if (stat.type === "DIRECTORY") {
            try {
                const indexPath = fsPath.replace(/\/$/, "") + "/index.html";
                const indexStat = await coreFs["party.openv.filesystem.read.stat"](indexPath);
                const fd = await coreFs["party.openv.filesystem.open"](indexPath, "r", 0o444);
                const data = await coreFs["party.openv.filesystem.read.read"](fd, indexStat.size);
                await coreFs["party.openv.filesystem.close"](fd);
                return new Response(new Blob([data]), { headers: { "Content-Type": "text/html" } });
            } catch {
                const entries = await coreFs["party.openv.filesystem.read.readdir"](fsPath);
                return new Response(JSON.stringify({ ok: entries }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        const fd = await coreFs["party.openv.filesystem.open"](fsPath, "r", 0o444);
        const data = await coreFs["party.openv.filesystem.read.read"](fd, stat.size);
        await coreFs["party.openv.filesystem.close"](fd);

        return new Response(new Blob([data]), {
            headers: { "Content-Type": guessContentType(fsPath) }
        });

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes("ENOENT") ? 404 : 500;
        return new Response(JSON.stringify({ err: msg }), {
            status,
            headers: { "Content-Type": "application/json" }
        });
    }
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