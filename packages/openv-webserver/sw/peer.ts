/// <reference lib="webworker" />
import { CoreSystemLinkPeer, createPostMessageTransport } from "@openv-project/openv-core";
import { openv } from "./init.ts";

declare const self: ServiceWorkerGlobalScope;

const CHANNEL = "openv-sw-channel";

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

export async function createPeerForClient(clientId: string): Promise<void> {
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

export function handleMessage(event: ExtendableMessageEvent): void {
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
}

export async function pruneDeadClients(): Promise<void> {
    for (const clientId of clientPeers.keys()) {
        const still = await self.clients.get(clientId);
        if (!still) {
            clientPeers.delete(clientId);
            clientListeners.delete(clientId);
        }
    }
}