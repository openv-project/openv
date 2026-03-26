import { FileSystemCoreComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemSocketComponent, ProcessComponent } from "@openv-project/openv-api";
import { ClientOpEnv, CoreFSExt, CoreProcessExt, createPostMessageTransport, ProcessScopedFS, ProcessScopedProcess, ProcessScopedRegistry, registerWebExecutor } from "@openv-project/openv-core";
import { DOMRemoteReceiver } from '@remote-dom/core/receivers';

const r = document.querySelector('#root');

const receiver = new DOMRemoteReceiver();
receiver.connect(r!);

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
    FileSystemSocketComponent &
    CoreFSExt &
    ProcessComponent &
    CoreProcessExt &
    FileSystemPipeComponent
>(transport);
await openv.enumerateRemote();
globalThis.openv = openv;

await registerWebExecutor(openv.system, async (ctx) => {
    const scopedFs = new ProcessScopedFS(ctx.pid, openv.system as any);
    if (ctx.stdioOfds) {
        for (let i = 0; i < ctx.stdioOfds.length; i++) {
            const ofd = ctx.stdioOfds[i];
            if (ofd !== undefined) {
                await scopedFs["party.openv.filesystem.local.setfd"](i, ofd);
            }
        }
    }
    const scopedRegistry = new ProcessScopedRegistry(ctx.pid, openv.system as any);
    const scopedProcess = new ProcessScopedProcess(ctx.pid, openv.system as any);

    const result: Record<string, Function> = {};
    for (const scoped of [scopedFs, scopedProcess, scopedRegistry]) {
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

const SOCKET_PATH = "/dom.sock";

async function startDOM() {
    try {
        try {
            const stat = await openv.system["party.openv.filesystem.read.stat"]("/var/lib/shopify/remote-dom");
            if (stat.type !== "DIRECTORY") {
                throw new Error("path exists but is not a directory");
            }
        } catch {
            await openv.system["party.openv.filesystem.write.mkdir"]("/var/lib/shopify/remote-dom", 0o755);
        }

        try {
            await openv.system["party.openv.filesystem.write.unlink"](SOCKET_PATH);
        } catch { }

        const listenFd = await openv.system["party.openv.filesystem.socket.create"]("stream");
        await openv.system["party.openv.filesystem.socket.bind"](listenFd, { path: SOCKET_PATH });
        await openv.system["party.openv.filesystem.socket.listen"](listenFd, 8);

        console.log(`[DOM] Listening on ${SOCKET_PATH}`);

        (async () => {
            while (true) {
                try {
                    const connFd = await openv.system["party.openv.filesystem.socket.accept"](listenFd);
                    console.log(`[DOM] Accepted connection`);

                    // Handle this connection
                    (async () => {
                        let carry = "";
                        const decoder = new TextDecoder();

                        try {
                            while (true) {
                                const chunk = await openv.system["party.openv.filesystem.read.read"](connFd, 4096);
                                if (chunk.byteLength === 0) {
                                    console.log(`[DOM] Connection closed`);
                                    break;
                                }

                                carry += decoder.decode(chunk, { stream: true });

                                // Process complete JSON lines
                                let idx;
                                while ((idx = carry.indexOf("\n")) !== -1) {
                                    const line = carry.substring(0, idx).trim();
                                    carry = carry.substring(idx + 1);

                                    if (!line) continue;

                                    try {
                                        const mutation = JSON.parse(line);
                                        receiver.connection.mutate(mutation);
                                    } catch (err) {
                                        console.error(`[DOM] Failed to parse/apply mutation:`, err, line);
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`[DOM] Connection error:`, err);
                        } finally {
                            try {
                                await openv.system["party.openv.filesystem.close"](connFd);
                            } catch { }
                        }
                    })();
                } catch (err) {
                    console.error(`[DOM] Accept error:`, err);
                    break;
                }
            }
        })();

    } catch (err) {
        console.error(`[DOM] Failed to start:`, err);
    }
}

await startDOM();

const FILE_PATH = "/test.js";
const DEFAULT_CONTENT =
    `import { connect } from "/@/lib/openv/openv-core/mod.js";
const openv = await connect();

const enc = new TextEncoder();

const writeStdout = async (msg) => {
    await openv.system["party.openv.filesystem.write.write"](1, enc.encode(msg));
};

const now = () => new Date().toISOString();

import { window } from '/@/lib/remote-dom/core/polyfill/polyfill.js';
import { RemoteRootElement } from '/@/lib/remote-dom/core/elements.js';
import { createRemoteConnection } from '/@/lib/remote-dom/core/connection.js';

async function main() {
    const fd = await openv.system["party.openv.filesystem.socket.create"]("stream");
    
    try {
        let connected = false;
        for (let attempt = 1; attempt <= 40; attempt++) {
            try {
                await openv.system["party.openv.filesystem.socket.connect"](fd, { path: "/dom.sock" });
                connected = true;
                await writeStdout("[" + now() + "] Connected to dom\\n");
                break;
            } catch (err) {
                if (attempt < 40) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
        }

        if (!connected) {
            throw new Error("Could not connect to DOM socket");
        }

        // Create a connection that sends mutations over the socket
        const connection = createRemoteConnection({
            send(message) {
                const json = JSON.stringify(message);
                openv.system["party.openv.filesystem.write.write"](fd, enc.encode(json + "\\n")).catch(e => {
                    console.error("Failed to send mutation:", e);
                });
            },
        });

        // Create a remote root element
        // const root = new RemoteRootElement(connection);
        // import {RemoteRootElement} from '@remote-dom/core/elements';
 
        customElements.define('remote-root', RemoteRootElement);
        const root = document.createElement('remote-root');
        root.connect(connection);
        root.append("Hello, Remote DOM!");

        // Now use normal DOM APIs to create elements
        const div = document.createElement('div');
        div.setAttribute('style', 'padding: 1rem; margin: 1rem 0; border: 1px solid #ccc; background-color: #f9f9f9;');
        
        const title = document.createElement('h3');
        title.textContent = 'Hello from Remote DOM!';
        div.appendChild(title);

        const description = document.createElement('p');
        description.textContent = 'This content was created by a process using the remote-dom polyfill and sent over a Unix socket.';
        description.setAttribute('style', 'font-size: 0.9rem; color: #666;');
        div.appendChild(description);

        const button = document.createElement('button');
        button.textContent = 'Click Me!';
        button.setAttribute('style', 'padding: 0.5rem 1rem; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;');
        button.onclick = () => {
            description.textContent = 'You clicked the button!';
        };
        div.appendChild(button);

        // Append the div to the root
        root.appendChild(div);

        await writeStdout("[" + now() + "] Created elements via remote-dom\\n");

        // Give socket time to send all mutations
        await new Promise((resolve) => setTimeout(resolve, 100));

        await writeStdout("[" + now() + "] Done\\n");
        await openv.system["party.openv.process.local.exit"](0);
    } catch (err) {
        await writeStdout("[" + now() + "] Error: " + String(err) + "\\n");
        console.error("Demo error:", err);
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        try {
            await openv.system["party.openv.filesystem.close"](fd);
        } catch {}
    }
}

await main();
`;

const root = (document.getElementById("app") ?? document.body) as HTMLElement;
root.innerHTML = `
    <h2 style="margin:0 0 0.5rem 0">DOM</h2>
    <code>${FILE_PATH}</code>
    <textarea id="editor" rows="18" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px">${DEFAULT_CONTENT}</textarea>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <button id="save">Save Script</button>
        <button id="load">Load Script</button>
        <button id="run">Run Demo</button>
        <button id="cleanup">Force Cleanup</button>
        <button id="proclist">List Processes</button>
        <span id="status" style="font-size:12px"></span>
    </div>
    <details open style="margin-top:1rem">
        <summary>process stdout/stderr</summary>
        <pre id="stdout" style="font-size:11px;max-height:220px;overflow:auto;border:1px solid;padding:0.5rem;margin:0.25rem 0;min-height:1.5rem"></pre>
    </details>
    <details open style="margin-top:0.5rem">
        <summary>orchestrator log</summary>
        <pre id="log" style="font-size:11px;max-height:220px;overflow:auto;border:1px solid;padding:0.5rem;margin:0.25rem 0"></pre>
    </details>
`;

const editor = document.getElementById("editor")! as HTMLTextAreaElement;
const saveBtn = document.getElementById("save")! as HTMLButtonElement;
const loadBtn = document.getElementById("load")! as HTMLButtonElement;
const runBtn = document.getElementById("run")! as HTMLButtonElement;
const cleanupBtn = document.getElementById("cleanup")! as HTMLButtonElement;
const listBtn = document.getElementById("proclist")! as HTMLButtonElement;
const statusEl = document.getElementById("status")! as HTMLSpanElement;
const stdoutEl = document.getElementById("stdout")! as HTMLPreElement;
const logEl = document.getElementById("log")! as HTMLPreElement;
const enc = new TextEncoder();

type ActiveProc = {
    name: string;
    pid: number;
    stdoutOfd?: number;
    stderrOfd?: number;
};

const active = new Map<number, ActiveProc>();

function ts(): string {
    return new Date().toISOString();
}

function log(msg: string) {
    logEl.textContent += `[${ts()}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function appendStdout(msg: string) {
    stdoutEl.textContent += msg;
    stdoutEl.scrollTop = stdoutEl.scrollHeight;
}

function setStatus(msg: string, ok?: boolean) {
    statusEl.textContent = msg;
    statusEl.style.color = ok === true ? "green" : ok === false ? "red" : "";
}

async function ensureDir(path: string): Promise<void> {
    try {
        const stat = await openv.system["party.openv.filesystem.read.stat"](path);
        if (stat.type !== "DIRECTORY") {
            throw new Error(`${path} exists but is not a directory`);
        }
    } catch {
        await openv.system["party.openv.filesystem.write.mkdir"](path, 0o755);
    }
}

async function closeOfdSafe(ofd: number | undefined): Promise<void> {
    if (ofd === undefined) return;
    try {
        await openv.system["party.openv.impl.filesystem.closeByOfd"](ofd);
    } catch (e) {
        log(`close ofd=${ofd} ignored: ${String(e)}`);
    }
}

function pumpOfd(label: string, pid: number, ofd: number): Promise<void> {
    const decoder = new TextDecoder();
    let out = "";
    return (async () => {
        try {
            while (true) {
                const chunk = await openv.system["party.openv.filesystem.read.read"](ofd, 4096);
                if (chunk.byteLength === 0) {
                    break;
                }
                out += decoder.decode(chunk, { stream: true });
                appendStdout(`[${label} pid=${pid}] ${out}`);
                out = "";
            }
        } catch (e) {
            log(`${label} stream pid=${pid} ended with error: ${String(e)}`);
        } finally {
            await closeOfdSafe(ofd);
            log(`${label} stream pid=${pid} closed`);
        }
    })();
}

async function spawnServer(name: string, args: string[]): Promise<number> {
    const pid = await openv.system["party.openv.process.spawn"](FILE_PATH, args, {
        cwd: "/",
        env: {},
        stdio: [null, "pipe", "pipe"],
    });
    log(`spawned ${name} pid=${pid}`);

    const stdio = await openv.system["party.openv.process.getstdio"](pid);
    if (stdio.stdout !== undefined) {
        pumpOfd(`${name}:stdout`, pid, stdio.stdout).catch((e) => log(`${name} stdout pump failed pid=${pid}: ${String(e)}`));
    }
    if (stdio.stderr !== undefined) {
        pumpOfd(`${name}:stderr`, pid, stdio.stderr).catch((e) => log(`${name} stderr pump failed pid=${pid}: ${String(e)}`));
    }

    const proc: ActiveProc = { name, pid, stdoutOfd: stdio.stdout, stderrOfd: stdio.stderr };
    active.set(pid, proc);

    (async () => {
        const code = await openv.system["party.openv.process.wait"](pid);
        log(`${name} pid=${pid} exited code=${String(code)}`);
        active.delete(pid);
        if (active.size === 0) {
            setStatus("server process exited", code === 0);
        }
    })().catch((e) => {
        log(`wait failed pid=${pid}: ${String(e)}`);
    });

    return pid;
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

runBtn.onclick = async () => {
    try {
        stdoutEl.textContent = "";
        setStatus("running demo...");

        for (const proc of active.values()) {
            await closeOfdSafe(proc.stdoutOfd);
            await closeOfdSafe(proc.stderrOfd);
        }
        active.clear();

        await spawnServer("demo", [FILE_PATH]);
        setStatus("demo running", true);
    } catch (e) {
        setStatus(`failed to run demo: ${e}`, false);
        log(`ERROR: ${e}`);
    }
};

cleanupBtn.onclick = async () => {
    try {
        for (const proc of active.values()) {
            await closeOfdSafe(proc.stdoutOfd);
            await closeOfdSafe(proc.stderrOfd);
        }
        active.clear();
        setStatus("cleanup complete", true);
        log("forced cleanup complete");
    } catch (e) {
        setStatus(`cleanup failed: ${String(e)}`, false);
        log(`ERROR: cleanup failed: ${String(e)}`);
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