import { WasiRuntime } from "rt.ts";
import openv from "./openv.ts";

async function main([_exe,path]: string[]) {
    let exit = 0;
    try {
        const stat = await openv.system["party.openv.filesystem.read.stat"](path); // will throw if not found
        let len = 0;
        if (stat.type !== "FILE" || !(len = stat.size)) {
            throw new Error(`Expected a file at path ${path}, but found type ${stat.type}`);
        }
        const fd = await openv.system["party.openv.filesystem.open"](path, "r");
        if (fd < 0) {
            throw new Error(`Failed to open file at path ${path}, got fd ${fd}`);
        }
        const wasmBytes = await openv.system["party.openv.filesystem.read.read"](fd, len, 0);
        await openv.system["party.openv.filesystem.close"](fd);

        const module = await WebAssembly.compile(wasmBytes.buffer as ArrayBuffer);
        let rt: WasiRuntime;
        const instance = await WebAssembly.instantiate(module, {
            wasi_snapshot_preview1: (rt = new WasiRuntime(openv, () => instance.exports.memory), await rt.init(), rt.toImportObject()),
        });

        if (instance.exports._start) {
            (instance.exports._start as Function)();
        } else {
            throw new Error("WASM module has no _start entrypoint");
        }
    } catch (e) {
        await openv.system["party.openv.filesystem.write.write"](2, new TextEncoder().encode("Error occurred in main: " + (e instanceof Error ? e.stack : String(e)) + "\n"));
        exit = 1;
    } finally {
        await openv.system["party.openv.process.local.exit"](exit);
    }
    // future: we should handle graceful kill signals async
}

openv.system["party.openv.process.local.getargs"]().then(main);