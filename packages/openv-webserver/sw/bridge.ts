/// <reference lib="webworker" />
import { coreFs, coreRegistry, ensureInitialized } from "./init.ts";

declare const self: ServiceWorkerGlobalScope;

export const BRIDGE_KEY = "/system/party/openv/serviceWorker/bridge" as const;
const BRIDGE_FS_CACHE_NAME = "party-openv-serviceworker-bridge-fscache-v1";
const BRIDGE_DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const IPC_FILE_MODE_MASK = 0o170000;
const IPC_FILE_MODE_FIFO = 0o010000;
const IPC_FILE_MODE_SOCKET = 0o140000;
const IPC_CHUNK_SIZE = 4096;
const IPC_BRIDGE_MESSAGE_TAG = "party.openv.bridge.ipc";

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

type BridgeIpcKind = "fifo" | "socket";

type BridgeIpcSession = {
    clientId: string;
    sessionId: string;
    stop: () => Promise<void>;
};

type BridgeIpcSubscriber = {
    clientId: string;
    sessionId: string;
};

type BridgeFifoFanout = {
    fsPath: string;
    fd?: number;
    connected: boolean;
    closed: boolean;
    subscribers: Map<string, BridgeIpcSubscriber>;
};

const ipcSessions = new Map<string, BridgeIpcSession>();
const fifoFanouts = new Map<string, BridgeFifoFanout>();

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

        const ipcKind = detectIpcKind(stat.mode);
        if (ipcKind) {
            return serveIpcViewerPage(fsPath, ipcKind);
        }

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

function detectIpcKind(mode: number): BridgeIpcKind | null {
        const typeBits = mode & IPC_FILE_MODE_MASK;
        if (typeBits === IPC_FILE_MODE_FIFO) return "fifo";
        if (typeBits === IPC_FILE_MODE_SOCKET) return "socket";
        return null;
}

function serveIpcViewerPage(fsPath: string, kind: BridgeIpcKind): Response {
        const html = renderIpcViewerHtml(fsPath, kind);
        return new Response(html, {
                headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store",
                },
        });
}

function renderIpcViewerHtml(fsPath: string, kind: BridgeIpcKind): string {
        const safePath = JSON.stringify(fsPath);
        const safeKind = JSON.stringify(kind);
        const title = kind === "fifo" ? "Pipe Viewer" : "Socket Viewer";
        const autoStart = kind === "fifo" ? "true" : "false";

        return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
        body { margin: 0; padding: 12px; font: 12px/1.4 monospace; background: #fff; color: #111; }
        .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
        button { font: inherit; }
        #status { color: #555; }
        #out { white-space: pre-wrap; border: 1px solid #bbb; padding: 8px; min-height: 240px; max-height: 70vh; overflow: auto; }
    </style>
</head>
<body>
    <div class="row">
        <strong>${title}</strong>
        <span id="status">idle</span>
    </div>
    <div class="row">
        <button id="start">start</button>
        <button id="stop">stop</button>
        <span>path: <span id="path"></span></span>
        <span>kind: <span id="kind"></span></span>
    </div>
    <div id="out"></div>
    <script>
        (() => {
            const TAG = ${JSON.stringify(IPC_BRIDGE_MESSAGE_TAG)};
            const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
            const fsPath = ${safePath};
            const kind = ${safeKind};
            const shouldAutoStart = ${autoStart};

            const statusEl = document.getElementById("status");
            const outEl = document.getElementById("out");
            const startBtn = document.getElementById("start");
            const stopBtn = document.getElementById("stop");
            const pathEl = document.getElementById("path");
            const kindEl = document.getElementById("kind");

            pathEl.textContent = fsPath;
            kindEl.textContent = kind;

            function setStatus(text) { statusEl.textContent = text; }
            function append(text) {
                outEl.textContent += text;
                outEl.scrollTop = outEl.scrollHeight;
            }

            function send(type) {
                if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
                    setStatus("no service worker controller");
                    return;
                }
                navigator.serviceWorker.controller.postMessage({
                    __openvBridgeIpc: true,
                    tag: TAG,
                    type,
                    sessionId,
                    fsPath,
                    kind,
                });
            }

            startBtn.onclick = () => {
                append("\\n[start]\\n");
                setStatus("starting...");
                send("start");
            };

            stopBtn.onclick = () => {
                setStatus("stopping...");
                send("stop");
            };

            navigator.serviceWorker.addEventListener("message", (event) => {
                const data = event.data;
                if (!data || data.tag !== TAG || data.sessionId !== sessionId) return;
                if (data.type === "status") {
                    setStatus(data.status || "status");
                } else if (data.type === "chunk") {
                    append(data.text || "");
                } else if (data.type === "done") {
                    setStatus("done: " + (data.reason || "finished"));
                } else if (data.type === "error") {
                    append("\\n[error] " + (data.error || "unknown") + "\\n");
                    setStatus("error");
                }
            });

            addEventListener("beforeunload", () => send("stop"));
            if (shouldAutoStart) startBtn.click();
        })();
    </script>
</body>
</html>`;
}

function makeSessionKey(clientId: string, sessionId: string): string {
        return `${clientId}:${sessionId}`;
}

function postIpcMessage(client: Client, message: Record<string, unknown>): void {
        client.postMessage({
                tag: IPC_BRIDGE_MESSAGE_TAG,
                ...message,
        });
}

async function postIpcMessageById(clientId: string, message: Record<string, unknown>): Promise<void> {
    const client = await self.clients.get(clientId);
    if (client) {
        postIpcMessage(client, message);
    }
}

async function broadcastFifoMessage(fanout: BridgeFifoFanout, message: Record<string, unknown>): Promise<void> {
    await Promise.all(Array.from(fanout.subscribers.values()).map((sub) =>
        postIpcMessageById(sub.clientId, {
            sessionId: sub.sessionId,
            ...message,
        }),
    ));
}

async function closeFifoFanout(fsPath: string): Promise<void> {
    const fanout = fifoFanouts.get(fsPath);
    if (!fanout || fanout.closed) return;
    fanout.closed = true;
    if (fanout.fd !== undefined) {
        await coreFs["party.openv.filesystem.close"](fanout.fd).catch(() => { });
        fanout.fd = undefined;
    }
    fifoFanouts.delete(fsPath);
}

async function startFifoFanoutLoop(fsPath: string): Promise<void> {
    const fanout = fifoFanouts.get(fsPath);
    if (!fanout || fanout.closed) return;

    try {
        fanout.fd = await coreFs["party.openv.filesystem.open"](fsPath, "r", 0o444);
        fanout.connected = true;
        await broadcastFifoMessage(fanout, { type: "status", status: "connected" });

        const decoder = new TextDecoder();
        while (!fanout.closed && fanout.fd !== undefined) {
            const chunk = await coreFs["party.openv.filesystem.read.read"](fanout.fd, IPC_CHUNK_SIZE);
            if (fanout.closed) break;
            if (chunk.byteLength === 0) {
                await broadcastFifoMessage(fanout, { type: "done", reason: "eof" });
                break;
            }
            const text = decoder.decode(chunk, { stream: true });
            await broadcastFifoMessage(fanout, { type: "chunk", text });
        }
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await broadcastFifoMessage(fanout, { type: "error", error });
    } finally {
        const subscribers = Array.from(fanout.subscribers.values());
        for (const sub of subscribers) {
            ipcSessions.delete(makeSessionKey(sub.clientId, sub.sessionId));
        }
        await closeFifoFanout(fsPath);
    }
}

async function attachToFifoFanout(clientId: string, sessionId: string, fsPath: string): Promise<void> {
    let fanout = fifoFanouts.get(fsPath);
    if (!fanout) {
        fanout = {
            fsPath,
            connected: false,
            closed: false,
            subscribers: new Map(),
        };
        fifoFanouts.set(fsPath, fanout);
        void startFifoFanoutLoop(fsPath);
    }

    const key = makeSessionKey(clientId, sessionId);
    fanout.subscribers.set(key, { clientId, sessionId });

    ipcSessions.set(key, {
        clientId,
        sessionId,
        stop: async () => {
            const source = fifoFanouts.get(fsPath);
            if (!source) return;
            source.subscribers.delete(key);
            if (source.subscribers.size === 0) {
                await closeFifoFanout(fsPath);
            }
        },
    });

    if (fanout.connected) {
        await postIpcMessageById(clientId, { sessionId, type: "status", status: "connected" });
    } else {
        await postIpcMessageById(clientId, { sessionId, type: "status", status: "starting" });
    }
}

async function stopIpcSession(clientId: string, sessionId: string): Promise<void> {
        const key = makeSessionKey(clientId, sessionId);
        const existing = ipcSessions.get(key);
        if (!existing) return;
        ipcSessions.delete(key);
        await existing.stop().catch(() => { });
}

export async function handleBridgeMessage(event: ExtendableMessageEvent): Promise<boolean> {
        const source = event.source as Client | null;
        const data = event.data as any;
        if (!source || !data || data.__openvBridgeIpc !== true || data.tag !== IPC_BRIDGE_MESSAGE_TAG) {
                return false;
        }

        const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
        const fsPath = typeof data.fsPath === "string" ? data.fsPath : "";
        const kind = data.kind === "socket" ? "socket" : data.kind === "fifo" ? "fifo" : null;
        const type = data.type === "start" ? "start" : data.type === "stop" ? "stop" : null;

        if (!sessionId || !type) return true;

        if (type === "stop") {
                await stopIpcSession(source.id, sessionId);
                postIpcMessage(source, { sessionId, type: "done", reason: "stopped" });
                return true;
        }

        if (!fsPath || !kind) {
                postIpcMessage(source, { sessionId, type: "error", error: "invalid bridge ipc request" });
                return true;
        }

        await ensureInitialized();
        await stopIpcSession(source.id, sessionId);

        if (kind === "fifo") {
            await attachToFifoFanout(source.id, sessionId, fsPath);
            return true;
        }

        let closed = false;
        let fd: number | undefined;
        let socketFd: number | undefined;
        const closeCurrent = async () => {
                if (closed) return;
                closed = true;
                if (fd !== undefined) {
                        await coreFs["party.openv.filesystem.close"](fd).catch(() => { });
                        fd = undefined;
                }
                if (socketFd !== undefined) {
                        await coreFs["party.openv.filesystem.close"](socketFd).catch(() => { });
                        socketFd = undefined;
                }
        };

        const key = makeSessionKey(source.id, sessionId);
        ipcSessions.set(key, {
                clientId: source.id,
                sessionId,
                stop: closeCurrent,
        });

        void (async () => {
                try {
                        postIpcMessage(source, { sessionId, type: "status", status: "starting" });

                socketFd = await coreFs["party.openv.filesystem.socket.create"]("stream");
                await coreFs["party.openv.filesystem.socket.connect"](socketFd, { path: fsPath });
                fd = socketFd;
                postIpcMessage(source, { sessionId, type: "status", status: "connected" });

                        const decoder = new TextDecoder();
                        while (!closed && fd !== undefined) {
                                const chunk = await coreFs["party.openv.filesystem.read.read"](fd, IPC_CHUNK_SIZE);
                                if (closed) break;
                                if (chunk.byteLength === 0) {
                                        postIpcMessage(source, { sessionId, type: "done", reason: "eof" });
                                        break;
                                }
                                const text = decoder.decode(chunk, { stream: true });
                                postIpcMessage(source, { sessionId, type: "chunk", text });
                        }
                } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        postIpcMessage(source, { sessionId, type: "error", error: message });
                } finally {
                        await closeCurrent();
                        ipcSessions.delete(key);
                }
        })();

        return true;
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