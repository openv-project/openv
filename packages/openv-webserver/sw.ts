/// <reference lib="webworker" />
import {
    CoreFS,
    CoreOpEnv,
    CoreProcess,
    CoreRegistry,
    CoreSystemLinkPeer,
    createPostMessageTransport,
    TmpFs,
} from "@openv-project/openv-core";
import { parseTar } from "nanotar";
import type { RegistryValue } from "@openv-project/openv-api";

declare const self: ServiceWorkerGlobalScope;

const CHANNEL = "openv-sw-channel";

const openv = new CoreOpEnv();
(globalThis as any).openv = openv;

const coreRegistry = new CoreRegistry();
openv.installSystemComponent(coreRegistry);

const coreFs = new CoreFS();
openv.installSystemComponent(coreFs);

const coreProcess = new CoreProcess();
openv.installSystemComponent(coreProcess);
coreProcess.setFsExt(coreFs);

let bridgeEnabled = true;
let bridgePaths: [string, string][] = [["/@/", "/"], ["/", "/srv/openv-webos"]];

const UPDATER_BEHAVIOR_DISABLED = 0;
const UPDATER_BEHAVIOR_IF_MISSING = 1;
const UPDATER_BEHAVIOR_OVERWRITE = 2;

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();

        await new TmpFs().register(coreFs);
        await coreFs["party.openv.filesystem.virtual.mount"]("party.openv.impl.tmpfs", "/");

        async function ensureDefault(key: string, entry: string, value: RegistryValue): Promise<void> {
            await coreRegistry["party.openv.registry.write.createKey"](key).catch(() => { });
            const existing = await coreRegistry["party.openv.registry.read.readEntry"](key, entry);
            if (existing === null) {
                await coreRegistry["party.openv.registry.write.writeEntry"](key, entry, value);
            }
        }

        await ensureDefault("/ServiceWorker/Bridge", "Enabled", true);
        await ensureDefault("/ServiceWorker/Bridge", "Paths", JSON.stringify([
            ["/@/", "/"],
            ["/", "/srv/openv-webos"]
        ]));

        await ensureDefault("/Updater/Stage0", "Behavior", UPDATER_BEHAVIOR_OVERWRITE);
        await ensureDefault("/Updater/Stage0", "Src", "/stage0.tar");
        await ensureDefault("/Updater/Stage0", "Dest", "/");

        const enabledVal = await coreRegistry["party.openv.registry.read.readEntry"](
            "/ServiceWorker/Bridge", "Enabled"
        );
        bridgeEnabled = enabledVal !== false;

        const pathsRaw = await coreRegistry["party.openv.registry.read.readEntry"](
            "/ServiceWorker/Bridge", "Paths"
        );
        try {
            if (pathsRaw) bridgePaths = JSON.parse(pathsRaw as string);
        } catch { }

        await runUpdater();
    })());
});

async function runUpdater(): Promise<void> {
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
            const dir = "/" + parts.slice(0, i).join("/");
            await coreFs["party.openv.filesystem.write.mkdir"](dir).catch(() => { });
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

    console.log(`[updater] stage0 complete\n installed=${installed} skipped=${skipped}`);
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

self.addEventListener("fetch", (event: FetchEvent) => {
    if (event.request.method !== "GET") return;
    if (!bridgeEnabled) return;

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

    if (matchedWebPrefix === null) return;

    event.respondWith((async () => {
        const remainder = reqPath.slice(matchedWebPrefix!.length);
        const joined = matchedFsPrefix!.endsWith("/") || remainder.startsWith("/")
            ? `${matchedFsPrefix}${remainder}`
            : `${matchedFsPrefix}/${remainder}`;
        const normalized = "/" + joined.replace(/\/+/g, "/").replace(/^\/+/, "");

        return serveFsPath(normalized);
    })());
});

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

const clientPeers = new Map<string, CoreSystemLinkPeer>();
const clientListeners = new Map<string, Set<(ev: MessageEvent) => void>>();

function makeLocalEndpoint(clientId: string) {
    return {
        postMessage(_message: any) { },
        addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            if (!clientListeners.has(clientId)) clientListeners.set(clientId, new Set());
            clientListeners.get(clientId)!.add(handler);
        },
        removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            clientListeners.get(clientId)?.delete(handler);
        },
    };
}

function makeRemoteEndpoint(clientId: string) {
    return {
        postMessage(message: any) {
            self.clients.get(clientId).then((client) => {
                if (client) {
                    client.postMessage(message);
                } else {
                    clientPeers.delete(clientId);
                    clientListeners.delete(clientId);
                }
            });
        },
    };
}

async function createPeerForClient(clientId: string): Promise<void> {
    if (clientPeers.has(clientId)) return;
    clientPeers.set(clientId, null!);

    const transport = createPostMessageTransport(
        makeLocalEndpoint(clientId),
        makeRemoteEndpoint(clientId),
        CHANNEL
    );

    const peer = new CoreSystemLinkPeer();
    Object.entries(openv.system).forEach(([name, fn]) => {
        peer.storeFunction(name, fn);
    });

    peer.setTransport(transport);
    await peer.start();

    clientPeers.set(clientId, peer);
}

async function pruneDeadClients(): Promise<void> {
    for (const clientId of clientPeers.keys()) {
        const still = await self.clients.get(clientId);
        if (!still) {
            clientPeers.delete(clientId);
            clientListeners.delete(clientId);
        }
    }
}

setInterval(pruneDeadClients, 30_000);

self.addEventListener("message", (event: ExtendableMessageEvent) => {
    event.waitUntil((async () => {
        const source = event.source as Client | null;
        if (!source) return;

        const clientId = source.id;

        if (!clientPeers.has(clientId)) {
            await createPeerForClient(clientId);
        }

        clientListeners.get(clientId)?.forEach((handler) =>
            handler(event as unknown as MessageEvent)
        );
    })());
});

self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((existingClients) => {
        for (const client of existingClients) createPeerForClient(client.id);
    });