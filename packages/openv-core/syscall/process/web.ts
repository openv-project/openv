import type { FileSystemCoreComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, ProcessComponent } from "@openv-project/openv-api";
import { CoreFSExt, CoreProcessExt, CoreSystemLinkPeer, createPostMessageTransport, ProcessScopedFS, ProcessScopedProcess, ProcessSpawnContext } from "../../mod.ts";

export type ProcessEnvBuilder = (ctx: ProcessSpawnContext) => Promise<Record<string, Function>>;

export interface WebExecutorRegistrationOptions {
    id?: string;
    class?: string;
}

export async function registerWebExecutor(
    system: FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemPipeComponent & CoreFSExt & ProcessComponent & CoreProcessExt,
    buildEnv: ProcessEnvBuilder,
    options?: WebExecutorRegistrationOptions,
): Promise<void> {
    const workers = new Map<number, Worker>();
    const executorId = options?.id ?? `web-${crypto.randomUUID()}`;
    const executorClass = options?.class ?? "party.openv.executor.web";

    await system["party.openv.impl.process.registerExecutor"]({ id: executorId, class: executorClass }, async (ctx) => {
        try {
            console.debug(`[executor] spawning process with pid=${ctx.pid} using executor '${executorId}'`);
            const worker = new Worker(
                `/@${ctx.exe}?pid=${ctx.pid}`,
                { type: "module" }
            );
            workers.set(ctx.pid, worker);

            const env = await buildEnv(ctx);

            const localEndpoint = {
                postMessage(_msg: any) { },
                addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
                    worker.addEventListener("message", handler);
                },
                removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
                    worker.removeEventListener("message", handler);
                },
            };
            const remoteEndpoint = {
                postMessage(msg: any) { worker.postMessage(msg); },
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

            const cleanupWorker = (reason: string) => {
                const w = workers.get(ctx.pid);
                if (!w) return;
                w.terminate();
                workers.delete(ctx.pid);
                peer.stop().catch(() => { });
            };

            worker.addEventListener("message", () => { });

            worker.addEventListener("error", async (e) => {
                console.error(`[executor] pid=${ctx.pid} worker error:`, e.message);
                cleanupWorker("error");
                await system["party.openv.impl.process.exitProcess"](ctx.pid, 1).catch(() => { });
            });

            worker.addEventListener("messageerror", async (e) => {
                console.error(`[executor] pid=${ctx.pid} worker messageerror:`, e);
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