import type { SystemLinkMessage, SystemLinkTransport } from "@openv-project/openv-api";

export function createPairTransport(): [SystemLinkTransport, SystemLinkTransport] {
    let handlersA: Set<(message: SystemLinkMessage) => Promise<void>> = new Set();
    let handlersB: Set<(message: SystemLinkMessage) => Promise<void>> = new Set();

    let transportAQueue: SystemLinkMessage[] = [];
    let transportBQueue: SystemLinkMessage[] = [];

    let transportAOpen = false;
    let transportBOpen = false;

    async function flushQueue(queue: SystemLinkMessage[], handlers: Set<(message: SystemLinkMessage) => Promise<void>>): Promise<void> {
        if (handlers.size === 0) {
            // nothing to do, but clear the queue so old messages aren't re-processed
            queue.length = 0;
            return;
        }
        // Drain the queue so messages are handled only once.
        while (queue.length > 0) {
            const message = queue.shift()!;
            for (const handler of handlers) {
                await handler(message);
            }
        }
    }

    const transportA: SystemLinkTransport = {
        async start(): Promise<void> {
            transportAOpen = true;
            await flushQueue(transportAQueue, handlersA);
        },

        isOpen(): boolean {
            return transportAOpen;
        },

        async send(message: SystemLinkMessage): Promise<void> {
            transportBQueue.push(message);
            if (transportBOpen) {
                await flushQueue(transportBQueue, handlersB);
            }
        },

        onMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlersA.add(handler);
        },
        
        offMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlersA.delete(handler);
        },

        async close(): Promise<void> {
            transportAOpen = false;
        }
    };

    const transportB: SystemLinkTransport = {
        async start(): Promise<void> {
            transportBOpen = true;
            await flushQueue(transportBQueue, handlersB);
        },

        isOpen(): boolean {
            return transportBOpen;
        },

        async send(message: SystemLinkMessage): Promise<void> {
            transportAQueue.push(message);
            if (transportAOpen) {
                await flushQueue(transportAQueue, handlersA);
            }
        },

        onMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlersB.add(handler);
        },
        
        offMessage(handler: (message: SystemLinkMessage) => Promise<void>): void {
            handlersB.delete(handler);
        },

        async close(): Promise<void> {
            transportBOpen = false;
        }
    };

    return [transportA, transportB];
}