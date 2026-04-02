import SyncAPI, { SyncBlockingClient } from "@openv-project/api-sync";
import { FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, OpEnv, ProcessLocalComponent } from "@openv-project/openv-api";

export class WasiRuntime {
    #openv: OpEnv<FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent>;
    #client: SyncBlockingClient;
    #getmemory: () => WebAssembly.Memory;
    constructor(openv: OpEnv<any>, getmemory: () => WebAssembly.Memory) {
        this.#openv = openv;
        this.#getmemory = getmemory;
    }

    async init(): Promise<void> {
        this.#client = await (this.#openv.api["party.openv.api.sync"] as SyncAPI).createBlockingClient();
    }

    fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number): number {
        try {
            const memory = this.#getmemory();
            const view = new DataView(memory.buffer);
            let nwritten = 0;
            for (let i = 0; i < iovs_len; i++) {
                const ptr = view.getUint32(iovs_ptr + i * 8, true);
                const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                const chunk = new Uint8Array(memory.buffer, ptr, len);
                this.#client.call<FileSystemReadWriteComponent>("party.openv.filesystem.write.write", fd, chunk);
                nwritten += len;
            }
            view.setUint32(nwritten_ptr, nwritten, true);
            return 0;
        } catch (e) {
            console.error("Error in fd_write:", e);
            return 1;
        }
    }

    proc_exit(code: number)  {
        this.#client.call<ProcessLocalComponent>("party.openv.process.local.exit", code);
    }

    toImportObject(): WebAssembly.ModuleImports {
        const fd_write = this.fd_write.bind(this);
        const proc_exit = this.proc_exit.bind(this);
        return {
            fd_write,
            proc_exit,
        };
    }

}