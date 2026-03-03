import { OpEnv } from "../../../openv/openv";
import { FileSystemCoreComponent, FileSystemReadOnlyComponent, SystemComponent } from "../../../openv/syscall";
import { ProcessComponent } from "../../../openv/syscall/process";
import { createPostMessageTransport } from "../../systemlink/transport/postmessage";
import { CoreProcessExt, ProcessExecutor, ProcessSpawnContext } from "./process";

export type EnvironmentBuilder<T extends FileSystemCoreComponent & FileSystemReadOnlyComponent, U extends FileSystemCoreComponent & FileSystemReadOnlyComponent> = (sys: T, ctx: ProcessSpawnContext) => Promise<U>;

export class WebExecutor<T extends FileSystemCoreComponent & FileSystemReadOnlyComponent> implements ProcessExecutor {
    #sys: T;
    #environmentBuilder: EnvironmentBuilder<T, FileSystemCoreComponent & FileSystemReadOnlyComponent>;
    #workers: Map<number, Worker> = new Map();

    constructor(sys: T, environmentBuilder: EnvironmentBuilder<T, FileSystemCoreComponent & FileSystemReadOnlyComponent>) {
        this.#sys = sys;
        this.#environmentBuilder = environmentBuilder;
    }

    async run(ctx: ProcessSpawnContext): Promise<void> {
        const newSys = await this.#environmentBuilder(this.#sys, ctx);
        if (!newSys) {
            throw new Error("Failed to build environment");
        }

        const size = (await this.#sys["party.openv.filesystem.read.stat"](ctx.exe)).size;
        const fd = await this.#sys["party.openv.filesystem.open"](ctx.exe, "r");
        if (fd < 0) {
            throw new Error("Failed to open file");
        }

        const buffer = new Uint8Array(size);

        let offset = 0;
        while (offset < size) {
            const chunkSize = Math.min(1024, size - offset);
            const bytesRead = await this.#sys["party.openv.filesystem.read.read"](fd, buffer, offset, chunkSize);
            if (bytesRead <= 0) {
                throw new Error("Failed to read file");
            }
            offset += bytesRead;
        }

        await this.#sys["party.openv.filesystem.close"](fd);

        const decoder = new TextDecoder();
        const code = decoder.decode(buffer);

        console.log(`Executing process ${ctx.exe} with code:\n${code}`);

        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));

        this.#workers.set(ctx.pid, worker);

        const tp = createPostMessageTransport(
            worker,
            worker,
            `openv-process-${ctx.pid}`
        );
        tp.start();
    }

    destroy(pid: number): Promise<void> {
        const worker = this.#workers.get(pid);
        if (worker) {
            worker.terminate();
            this.#workers.delete(pid);
        }
        return Promise.resolve();
    }

    setEnvironmentBuilder(builder: EnvironmentBuilder<T, FileSystemCoreComponent & FileSystemReadOnlyComponent>): void {
        this.#environmentBuilder = builder;
    }
}