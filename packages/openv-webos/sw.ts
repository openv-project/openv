/// <reference lib="webworker" />
import {
    CoreOpEnv,
    CoreRegistry,
    CoreSystemLinkPeer,
    createPostMessageTransport,
} from "@openv-project/openv-core";

declare const self: ServiceWorkerGlobalScope;

const CHANNEL = "openv-sw-channel";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(clients.claim()); });

const openv = new CoreOpEnv();
(globalThis as any).openv = openv;
openv.installSystemComponent(new CoreRegistry());

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
    if (clientPeers.has(clientId)) {
        return;
    }
    clientPeers.set(clientId, null!);

    const transport = createPostMessageTransport(
        makeLocalEndpoint(clientId),
        makeRemoteEndpoint(clientId),
        CHANNEL
    );

    const peer = new CoreSystemLinkPeer();
    Object.entries(openv.system).forEach(([name, fn]) => {
        peer.storeFunction(name, (fn as Function).bind(openv.system));
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

        const listeners = clientListeners.get(clientId);
        listeners?.forEach((handler) =>
            handler(event as unknown as MessageEvent)
        );
    })());
});

self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((existingClients) => {
        for (const client of existingClients) {
            createPeerForClient(client.id);
        }
    });