import type { FileSystemCoreComponent, FileSystemIoctlComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, ProcessComponent } from "@openv-project/openv-api";
import { CoreFSExt, CoreProcessExt, CoreSystemLinkPeer, createPostMessageTransport, ProcessScopedFS, ProcessScopedProcess, ProcessSpawnContext } from "../../mod.ts";

export type ProcessEnvBuilder = (ctx: ProcessSpawnContext) => Promise<Record<string, Function>>;

export interface WebExecutorRegistrationOptions {
    id?: string;
    class?: string;
}

export async function registerWebExecutor(
    system: FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemPipeComponent & FileSystemIoctlComponent & CoreFSExt & ProcessComponent & CoreProcessExt,
    buildEnv: ProcessEnvBuilder,
    options?: WebExecutorRegistrationOptions,
): Promise<void> {
    const workers = new Map<number, Worker>();
    const executorId = options?.id ?? `web-${crypto.randomUUID()}`;
    const executorClass = options?.class ?? "party.openv.executor.web";

    await system["party.openv.impl.process.registerExecutor"]({ id: executorId, class: executorClass }, async (ctx) => {
        try {
            const env = await buildEnv(ctx);

            let worker: Worker | undefined;
            const pendingListeners = new Set<(ev: MessageEvent) => void>();
            const pendingOutboundMessages: any[] = [];
            const localEndpoint = {
                postMessage(_msg: any) { },
                addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
                    pendingListeners.add(handler);
                    if (worker) worker.addEventListener("message", handler);
                },
                removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
                    pendingListeners.delete(handler);
                    if (worker) worker.removeEventListener("message", handler);
                },
            };
            const remoteEndpoint = {
                postMessage(msg: any) { 
                    if (worker) {
                        worker.postMessage(msg);
                    } else {
                        pendingOutboundMessages.push(msg);
                    }
                },
            };

            const transport = createPostMessageTransport(
                localEndpoint, remoteEndpoint, `openv-process-${ctx.pid}`
            );

            const peer = new CoreSystemLinkPeer();
            for (const [name, fn] of Object.entries(env)) {
                peer.storeFunction(name, fn as any);
            }
            peer.setTransport(transport);
            await peer.start();

            // NOW create the worker after everything is set up
            worker = new Worker(
                `/@${ctx.exe}?pid=${ctx.pid}&mimeType=application/javascript`,
                { type: "module" }
            );
            for (const handler of pendingListeners) {
                worker.addEventListener("message", handler);
            }
            for (const msg of pendingOutboundMessages.splice(0, pendingOutboundMessages.length)) {
                worker.postMessage(msg);
            }
            workers.set(ctx.pid, worker);

            const cleanupWorker = (reason: string) => {
                const w = workers.get(ctx.pid);
                if (!w) return;
                w.terminate();
                workers.delete(ctx.pid);
                peer.stop().catch(() => { });
            };

            worker.addEventListener("message", () => { });

            worker.addEventListener("error", async (e) => {
                console.error(`[executor] pid=${ctx.pid} worker error event:`, e);
                cleanupWorker("error");
                await system["party.openv.impl.process.exitProcess"](ctx.pid, 1).catch(() => { });
            });

            worker.addEventListener("messageerror", async (e) => {
                console.error(`[executor] pid=${ctx.pid} worker messageerror event:`, e.data);
                cleanupWorker("messageerror");
                await system["party.openv.impl.process.exitProcess"](ctx.pid, 1).catch(() => { });
            });

            system["party.openv.process.wait"](ctx.pid).then(() => {
                cleanupWorker("process exited");
            })

        } catch (err) {
            console.error(`[executor] pid=${ctx.pid} failed to spawn:`, err);
            await system["party.openv.impl.process.exitProcess"](ctx.pid, null).catch(() => { });
        }
    }, async () => true);
}
