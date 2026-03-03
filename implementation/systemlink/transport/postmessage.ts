import type { SystemLinkMessage, SystemLinkTransport } from "../../../openv/systemlink/wire";

type PostMessageEndpoint = {
    postMessage(message: any, transfer?: any): void;
    addEventListener?(type: "message", handler: (ev: MessageEvent) => void): void;
    removeEventListener?(type: "message", handler: (ev: MessageEvent) => void): void;
    onmessage?: ((ev: MessageEvent) => void) | null;
};

const NAMESPACE = "party.openv.systemlink";

export function createPostMessageTransport(
    localEndpoint: PostMessageEndpoint,
    remoteEndpoint: PostMessageEndpoint,
    channel: string
): SystemLinkTransport {
    let handlers: Set<(message: SystemLinkMessage) => Promise<void>> = new Set();

    let inboundQueue: SystemLinkMessage[] = [];

    let outboundQueue: SystemLinkMessage[] = [];

    let localOpen = false; 
    let remoteOpen = false;

    async function flushInbound(): Promise<void> {
        if (handlers.size === 0) {
            inboundQueue.length = 0;
            return;
        }
        while (inboundQueue.length > 0) {
            const msg = inboundQueue.shift()!;
            for (const h of handlers) {
                await h(msg);
            }
        }
    }

    function flushOutbound(): void {
        if (!remoteOpen) return;
        while (outboundQueue.length > 0) {
            const msg = outboundQueue.shift()!;
            remoteEndpoint.postMessage({
                [NAMESPACE]: {
                    channel,
                    control: false
                },
                payload: msg
            });
        }
    }

    const listener = async (ev: MessageEvent) => {
        const data = ev.data;
        if (!data || typeof data !== "object") return;
        if (data[NAMESPACE].channel !== channel) return;

        const control = data[NAMESPACE].control;
        if (control === true) {
            const action: "open" | "close" = data.action;
            if (action === "open") {
                remoteOpen = true;
                flushOutbound();
            } else if (action === "close") {
                remoteOpen = false;
            }
            return;
        }

        const payload: SystemLinkMessage = data.payload;
        inboundQueue.push(payload);
        if (localOpen) {
            await flushInbound();
        }
    };

    function attachListener(): void {
        if (localEndpoint.addEventListener) {
            localEndpoint.addEventListener("message", listener);
        } else if ("onmessage" in localEndpoint) {
            // preserve existing onmessage if any
            const prev = localEndpoint.onmessage ?? null;
            localEndpoint.onmessage = (ev: MessageEvent) => {
                if (prev) {
                    try { (prev as Function).call(localEndpoint, ev); } catch { /* ignore */ }
                }
                listener(ev).catch(() => { /* ignore */ });
            };
        } else {
            throw new Error("localEndpoint must support addEventListener or onmessage");
        }
    }

    function detachListener(): void {
        if (localEndpoint.removeEventListener) {
            localEndpoint.removeEventListener("message", listener);
        } else if ("onmessage" in localEndpoint) {
            localEndpoint.onmessage = null;
        }
    }

    attachListener();

    const transport: SystemLinkTransport = {
        async start(): Promise<void> {
            localOpen = true;
            remoteEndpoint.postMessage({
                [NAMESPACE]: {
                    channel,
                    control: true
                },
                action: "open"
            });
            await flushInbound();
            flushOutbound();
        },

        isOpen(): boolean {
            return localOpen;
        },

        async send(message: SystemLinkMessage): Promise<void> {
            if (remoteOpen) {
                remoteEndpoint.postMessage({
                    [NAMESPACE]: {
                        channel,
                        control: false
                    },
                    payload: message
                });
            } else {
                outboundQueue.push(message);
            }
        },

        onMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlers.add(handler);
        },

        offMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlers.delete(handler);
        },

        async close(): Promise<void> {
            localOpen = false;
            remoteEndpoint.postMessage({
                [NAMESPACE]: {
                    channel,
                    control: true
                },
                action: "close"
            });
            detachListener();
        }
    };

    return transport;
}