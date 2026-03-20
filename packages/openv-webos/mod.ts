import { FileSystemCoreComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, ProcessComponent } from "@openv-project/openv-api";
import { ClientOpEnv, CoreFSExt, CoreProcessExt, createPostMessageTransport, ProcessScopedFS, ProcessScopedProcess, registerWebExecutor } from "@openv-project/openv-core";

const CHANNEL = "openv-sw-channel";

const controller = navigator.serviceWorker.controller!;

const localEndpoint = {
    postMessage(_msg: any) { },
    addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
        navigator.serviceWorker.addEventListener("message", handler);
    },
    removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
        navigator.serviceWorker.removeEventListener("message", handler);
    },
};

const remoteEndpoint = {
    postMessage(msg: any) {
        controller.postMessage(msg);
    },
};

const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, CHANNEL);
const openv = new ClientOpEnv<
    FileSystemCoreComponent &
    FileSystemReadOnlyComponent &
    FileSystemReadWriteComponent &
    CoreFSExt &
    ProcessComponent &
    CoreProcessExt &
    FileSystemPipeComponent
>(transport);
await openv.enumerateRemote();
globalThis.openv = openv;

await registerWebExecutor(openv.system, async (ctx) => {
    const scopedFs = new ProcessScopedFS(openv.system as any);
    if (ctx.stdioOfds) {
        for (let i = 0; i < ctx.stdioOfds.length; i++) {
            const ofd = ctx.stdioOfds[i];
            if (ofd !== undefined) {
                await scopedFs["party.openv.filesystem.local.setfd"](i, ofd);
            }
        }
    }
    const scopedProcess = new ProcessScopedProcess(ctx.pid, openv.system as any);

    const result: Record<string, Function> = {};
    for (const scoped of [scopedFs, scopedProcess]) {
        let obj = Object.getPrototypeOf(scoped);
        while (obj && obj !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(obj)) {
                if (name === "constructor" || name === "supports" || result[name]) continue;
                const val = (scoped as any)[name];
                if (typeof val === "function") result[name] = val.bind(scoped);
            }
            obj = Object.getPrototypeOf(obj);
        }
    }
    return result;
});

const FILE_PATH = "/test.js";
const DEFAULT_CONTENT =
    `import { createOpEnv } from "/@/lib/openv/openv-core/mod.js";
const openv = await createOpEnv();

const enc = new TextEncoder();
const write = (msg) => openv.system["party.openv.filesystem.write.write"](1, enc.encode(msg));

const pid = await openv.system["party.openv.process.local.getpid"]();
await write("hello from process pid=" + pid + "\\n");
await write("cwd: " + await openv.system["party.openv.process.local.getcwd"]() + "\\n");
await openv.system["party.openv.process.local.exit"](0);
`;

document.body.style.cssText = "font-family:monospace;padding:1rem;max-width:900px";
document.body.innerHTML = `
    <code>${FILE_PATH}</code>
    <textarea id="editor" rows="14" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px">${DEFAULT_CONTENT}</textarea>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <button id="save">Save</button>
        <button id="load">Load from FS</button>
        <button id="spawn">Run</button>
        <button id="proclist">List Processes</button>
        <span id="status" style="font-size:12px"></span>
    </div>
    <details open style="margin-top:1rem">
        <summary>stdout</summary>
        <pre id="stdout" style="font-size:11px;max-height:180px;overflow:auto;border:1px solid;padding:0.5rem;margin:0.25rem 0;min-height:1.5rem"></pre>
    </details>
    <details open style="margin-top:0.5rem">
        <summary>log</summary>
        <pre id="log" style="font-size:11px;max-height:180px;overflow:auto;border:1px solid;padding:0.5rem;margin:0.25rem 0"></pre>
    </details>
`;

const editor = document.getElementById("editor")! as HTMLTextAreaElement;
const saveBtn = document.getElementById("save")! as HTMLButtonElement;
const loadBtn = document.getElementById("load")! as HTMLButtonElement;
const spawnBtn = document.getElementById("spawn")! as HTMLButtonElement;
const listBtn = document.getElementById("proclist")! as HTMLButtonElement;
const statusEl = document.getElementById("status")! as HTMLSpanElement;
const stdoutEl = document.getElementById("stdout")! as HTMLPreElement;
const logEl = document.getElementById("log")! as HTMLPreElement;

function log(msg: string) {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(msg: string, ok?: boolean) {
    statusEl.textContent = msg;
    statusEl.style.color = ok === true ? "green" : ok === false ? "red" : "";
}

async function ensureFile() {
    try {
        await openv.system["party.openv.filesystem.read.stat"](FILE_PATH);
    } catch {
        await openv.system["party.openv.filesystem.write.create"](FILE_PATH);
        const fd = await openv.system["party.openv.filesystem.open"](FILE_PATH, "w", 0o644);
        await openv.system["party.openv.filesystem.write.write"](fd, new TextEncoder().encode(DEFAULT_CONTENT));
        await openv.system["party.openv.filesystem.close"](fd);
        log(`created ${FILE_PATH} with default content`);
    }
}
await ensureFile();

saveBtn.onclick = async () => {
    try {
        const data = new TextEncoder().encode(editor.value);
        try { await openv.system["party.openv.filesystem.write.unlink"](FILE_PATH); } catch { }
        await openv.system["party.openv.filesystem.write.create"](FILE_PATH);
        const fd = await openv.system["party.openv.filesystem.open"](FILE_PATH, "w", 0o644);
        await openv.system["party.openv.filesystem.write.write"](fd, data);
        await openv.system["party.openv.filesystem.close"](fd);
        setStatus(`saved ${data.byteLength} bytes`, true);
        log(`saved ${FILE_PATH} (${data.byteLength} bytes)`);
    } catch (e) {
        setStatus(`save failed: ${e}`, false);
        log(`ERROR: ${e}`);
    }
};

loadBtn.onclick = async () => {
    try {
        const stat = await openv.system["party.openv.filesystem.read.stat"](FILE_PATH);
        const fd = await openv.system["party.openv.filesystem.open"](FILE_PATH, "r", 0o444);
        const data = await openv.system["party.openv.filesystem.read.read"](fd, stat.size);
        await openv.system["party.openv.filesystem.close"](fd);
        editor.value = new TextDecoder().decode(data);
        setStatus(`loaded ${stat.size} bytes`, true);
        log(`loaded ${FILE_PATH} (${stat.size} bytes)`);
    } catch (e) {
        setStatus(`load failed: ${e}`, false);
        log(`ERROR: ${e}`);
    }
};

spawnBtn.onclick = async () => {
    try {
        stdoutEl.textContent = "";
        setStatus("spawning...");

        const pid = await openv.system["party.openv.process.spawn"](FILE_PATH, [FILE_PATH], {
            cwd: "/",
            env: {},
            stdio: [null, "pipe", null],
        });
        log(`spawned pid=${pid}`);
        setStatus(`pid=${pid} running`);

        const { stdout: readOfd } = await openv.system["party.openv.process.getstdio"](pid);

        const decoder = new TextDecoder();
        let out = "";
        const readLoop = (async () => {
            try {
                while (true) {
                    const chunk = await openv.system["party.openv.filesystem.read.read"](readOfd!, 4096);
                    if (chunk.byteLength === 0) break;
                    out += decoder.decode(chunk, { stream: true });
                    stdoutEl.textContent = out;
                }
            } catch (e) {
                log(`stdout ended: ${e}`);
            } finally {
                await openv.system["party.openv.impl.filesystem.closeByOfd"](readOfd!).catch(() => { });
            }
        })();

        const code = await openv.system["party.openv.process.wait"](pid);
        setStatus(`pid=${pid} exited code=${code}`, code === 0);
        log(`pid=${pid} exited code=${code}`);
        await readLoop;

    } catch (e) {
        setStatus(`error: ${e}`, false);
        log(`ERROR: ${e}`);
    }
};

listBtn.onclick = async () => {
    try {
        const procs = await openv.system["party.openv.process.list"]();
        log(`processes: ${JSON.stringify(procs)}`);
    } catch (e) {
        log(`ERROR: ${e}`);
    }
};

(globalThis as any).reboot = async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    location.reload();
};

log("ready");