/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { ensureInitialized } from "./sw/init.ts";
import { handleFetch } from "./sw/bridge.ts";
import { handleMessage, createPeerForClient, pruneDeadClients } from "./sw/peer.ts";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();
        await ensureInitialized();
    })());
});

self.addEventListener("fetch", (event: FetchEvent) => {
    event.waitUntil(ensureInitialized());
    handleFetch(event);
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
    event.waitUntil((async () => {
        await ensureInitialized();
        handleMessage(event);
    })());
});

self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then(async (existingClients) => {
        await ensureInitialized();
        for (const client of existingClients) createPeerForClient(client.id);
    });

setInterval(pruneDeadClients, 30_000);