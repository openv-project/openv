import { FileSystemCoreComponent, FileSystemPipeComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemSocketComponent, ProcessComponent } from "@openv-project/openv-api";
import { ClientOpEnv, CoreFSExt, CoreProcessExt, createPostMessageTransport, ProcessScopedFS, ProcessScopedProcess, ProcessScopedRegistry, registerWebExecutor } from "@openv-project/openv-core";

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

const FILE_PATH = "/test.js";
const FIFO_DIR = "/demo-ipc";
const FIFO_A = `${FIFO_DIR}/proc-a.fifo`;
const FIFO_B = `${FIFO_DIR}/proc-b.fifo`;
const STREAM_SOCKET_PATH = `${FIFO_DIR}/phase2.stream.sock`;
const DGRAM_SERVER_PATH = `${FIFO_DIR}/phase3.dgram.server.sock`;
const DGRAM_CLIENT_PATH = `${FIFO_DIR}/phase3.dgram.client.sock`;
const DEFAULT_CONTENT =
    `import { connect } from "/@/lib/openv/openv-core/mod.js";
const openv = await connect();

const enc = new TextEncoder();
const dec = new TextDecoder();

const writeStdout = async (msg) => {
    await openv.system["party.openv.filesystem.write.write"](1, enc.encode(msg));
};

const now = () => new Date().toISOString();
const pid = await openv.system["party.openv.process.local.getpid"]();
const args = await openv.system["party.openv.process.local.getargs"]();

function getArg(flag, fallback) {
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return fallback;
}

const fifoPath = getArg("--fifo", "/demo-ipc/default.fifo");
const socketPath = getArg("--socket", "/demo-ipc/default.stream.sock");
const mode = getArg("--mode", "fifo");
const workerName = getArg("--name", "worker");

async function runFifoMode() {
    await writeStdout("[" + now() + "] [" + workerName + "] pid=" + pid + " starting fifo=" + fifoPath + "\\n");

    let controlFd;
    let carry = "";

    try {
        controlFd = await openv.system["party.openv.filesystem.open"](fifoPath, "r", 0o666);
        await writeStdout("[" + now() + "] [" + workerName + "] control fifo opened for read\\n");

        while (true) {
            const chunk = await openv.system["party.openv.filesystem.read.read"](controlFd, 4096);
            if (chunk.byteLength === 0) {
                throw new Error("control fifo closed by peer (EOF)");
            }

            carry += dec.decode(chunk, { stream: true });
            const lines = carry.split("\\n");
            carry = lines.pop() ?? "";

            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;

                if (line === "quit") {
                    await writeStdout("[" + now() + "] [" + workerName + "] quit received, exiting cleanly\\n");
                    await openv.system["party.openv.process.local.exit"](0);
                }

                await writeStdout("[" + now() + "] [" + workerName + "] message=" + line + "\\n");
            }
        }
    } catch (err) {
        await writeStdout("[" + now() + "] [" + workerName + "] ERROR " + String(err) + "\\n");
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        if (controlFd !== undefined) {
            try {
                await openv.system["party.openv.filesystem.close"](controlFd);
            } catch {}
        }
    }
}

async function runStreamServer() {
    let listenFd;
    let connFd;
    let carry = "";
    try {
        listenFd = await openv.system["party.openv.filesystem.socket.create"]("stream");
        await openv.system["party.openv.filesystem.socket.bind"](listenFd, { path: socketPath });
        await openv.system["party.openv.filesystem.socket.listen"](listenFd, 8);
        await writeStdout("[" + now() + "] [" + workerName + "] listening socket=" + socketPath + "\\n");

        connFd = await openv.system["party.openv.filesystem.socket.accept"](listenFd);
        await writeStdout("[" + now() + "] [" + workerName + "] accepted stream client\\n");

        while (true) {
            const chunk = await openv.system["party.openv.filesystem.read.read"](connFd, 4096);
            if (chunk.byteLength === 0) {
                await writeStdout("[" + now() + "] [" + workerName + "] stream peer closed\\n");
                await openv.system["party.openv.process.local.exit"](0);
            }

            carry += dec.decode(chunk, { stream: true });
            const lines = carry.split("\\n");
            carry = lines.pop() ?? "";

            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                await writeStdout("[" + now() + "] [" + workerName + "] stream message=" + line + "\\n");
                if (line === "quit") {
                    await writeStdout("[" + now() + "] [" + workerName + "] quit received over stream\\n");
                    await openv.system["party.openv.process.local.exit"](0);
                }
            }
        }
    } catch (err) {
        await writeStdout("[" + now() + "] [" + workerName + "] ERROR " + String(err) + "\\n");
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        try { if (connFd !== undefined) await openv.system["party.openv.filesystem.close"](connFd); } catch {}
        try { if (listenFd !== undefined) await openv.system["party.openv.filesystem.close"](listenFd); } catch {}
    }
}

async function runStreamClient() {
    let fd;
    try {
        fd = await openv.system["party.openv.filesystem.socket.create"]("stream");
        await writeStdout("[" + now() + "] [" + workerName + "] connecting socket=" + socketPath + "\\n");
        let connected = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= 40; attempt++) {
            try {
                await openv.system["party.openv.filesystem.socket.connect"](fd, { path: socketPath });
                connected = true;
                if (attempt > 1) {
                    await writeStdout("[" + now() + "] [" + workerName + "] connect succeeded after attempt=" + attempt + "\\n");
                }
                break;
            } catch (err) {
                lastErr = err;
                const msg = String(err);
                if (!msg.includes("ECONNREFUSED")) {
                    throw err;
                }
                await writeStdout("[" + now() + "] [" + workerName + "] waiting for server attempt=" + attempt + "\\n");
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        if (!connected) {
            throw new Error("connect timeout: " + String(lastErr));
        }
        await writeStdout("[" + now() + "] [" + workerName + "] connected\\n");

        const payload = [
            "hello-from-client",
            "phase2-stream-check",
            "quit",
        ].join("\\n") + "\\n";
        await openv.system["party.openv.filesystem.write.write"](fd, enc.encode(payload));
        await writeStdout("[" + now() + "] [" + workerName + "] sent payload and exiting\\n");
        await openv.system["party.openv.process.local.exit"](0);
    } catch (err) {
        await writeStdout("[" + now() + "] [" + workerName + "] ERROR " + String(err) + "\\n");
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        try { if (fd !== undefined) await openv.system["party.openv.filesystem.close"](fd); } catch {}
    }
}

async function runDgramServer() {
    let fd;
    try {
        fd = await openv.system["party.openv.filesystem.socket.create"]("dgram");
        await openv.system["party.openv.filesystem.socket.bind"](fd, { path: socketPath });
        await writeStdout("[" + now() + "] [" + workerName + "] dgram server bound socket=" + socketPath + "\\n");

        while (true) {
            const packet = await openv.system["party.openv.filesystem.socket.recvfrom"](fd, 4096);
            const message = dec.decode(packet.data).trim();
            const from = packet.address?.path ?? "(anonymous)";
            await writeStdout("[" + now() + "] [" + workerName + "] datagram from=" + from + " message=" + message + "\\n");
            if (message === "quit") {
                await writeStdout("[" + now() + "] [" + workerName + "] quit received over dgram\\n");
                await openv.system["party.openv.process.local.exit"](0);
            }
        }
    } catch (err) {
        await writeStdout("[" + now() + "] [" + workerName + "] ERROR " + String(err) + "\\n");
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        try { if (fd !== undefined) await openv.system["party.openv.filesystem.close"](fd); } catch {}
    }
}

async function runDgramClient() {
    let fd;
    try {
        fd = await openv.system["party.openv.filesystem.socket.create"]("dgram");
        const localPath = getArg("--local", "/demo-ipc/default.dgram.client.sock");
        await openv.system["party.openv.filesystem.socket.bind"](fd, { path: localPath });
        await writeStdout("[" + now() + "] [" + workerName + "] dgram client bound local=" + localPath + "\\n");

        const messages = [
            "hello-from-dgram-client",
            "phase3-dgram-check",
            "quit",
        ];

        for (const message of messages) {
            await openv.system["party.openv.filesystem.socket.sendto"](fd, enc.encode(message + "\\n"), { path: socketPath });
            await writeStdout("[" + now() + "] [" + workerName + "] sent datagram message=" + message + "\\n");
        }

        await openv.system["party.openv.process.local.exit"](0);
    } catch (err) {
        await writeStdout("[" + now() + "] [" + workerName + "] ERROR " + String(err) + "\\n");
        await openv.system["party.openv.process.local.exit"](1);
    } finally {
        try { if (fd !== undefined) await openv.system["party.openv.filesystem.close"](fd); } catch {}
    }
}

if (mode === "fifo") {
    await runFifoMode();
} else if (mode === "stream-server") {
    await runStreamServer();
} else if (mode === "stream-client") {
    await runStreamClient();
} else if (mode === "dgram-server") {
    await runDgramServer();
} else if (mode === "dgram-client") {
    await runDgramClient();
} else {
    await writeStdout("[" + now() + "] [" + workerName + "] ERROR unknown mode='" + mode + "'\\n");
    await openv.system["party.openv.process.local.exit"](2);
}
`;

const root = (document.getElementById("app") ?? document.body) as HTMLElement;
root.innerHTML = `
    <h2 style="margin:0 0 0.5rem 0">OpEnv IPC Demo</h2>
    <p style="margin:0 0 0.75rem 0;font-size:12px;opacity:0.85">
        Phase 1 (FIFO): spawn two long-running processes and control each over its named FIFO.<br>
        Phase 2 (stream socket): spawn server/client processes and exchange messages over a path-bound stream socket.
    </p>
    <code>${FILE_PATH}</code>
    <textarea id="editor" rows="18" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px">${DEFAULT_CONTENT}</textarea>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <button id="save">Save Script</button>
        <button id="load">Load Script</button>
        <button id="spawn">Run FIFO Demo (2 procs)</button>
        <button id="ping">Send Ping</button>
        <button id="quit">Send Quit</button>
        <button id="cleanup">Force Cleanup</button>
        <button id="proclist">List Processes</button>
        <button id="phase2" title="Run stream socket server/client demo">Run Stream Socket Demo</button>
        <button id="phase3" title="Run datagram socket demo">Run Datagram Socket Demo</button>
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
const spawnBtn = document.getElementById("spawn")! as HTMLButtonElement;
const pingBtn = document.getElementById("ping")! as HTMLButtonElement;
const quitBtn = document.getElementById("quit")! as HTMLButtonElement;
const cleanupBtn = document.getElementById("cleanup")! as HTMLButtonElement;
const listBtn = document.getElementById("proclist")! as HTMLButtonElement;
const phase2Btn = document.getElementById("phase2")! as HTMLButtonElement;
const phase3Btn = document.getElementById("phase3")! as HTMLButtonElement;
const statusEl = document.getElementById("status")! as HTMLSpanElement;
const stdoutEl = document.getElementById("stdout")! as HTMLPreElement;
const logEl = document.getElementById("log")! as HTMLPreElement;
const enc = new TextEncoder();

type DemoProc = {
    name: string;
    pid: number;
    fifoPath: string;
    controlOfd: number;
    stdoutOfd?: number;
    stderrOfd?: number;
};

const active = new Map<number, DemoProc>();

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

async function ensureFreshFifo(path: string): Promise<void> {
    try {
        await openv.system["party.openv.filesystem.write.unlink"](path);
        log(`removed stale fifo ${path}`);
    } catch {}
    await openv.system["party.openv.filesystem.write.mkfifo"](path, 0o666);
    log(`created fifo ${path}`);
}

async function closeOfdSafe(ofd: number | undefined): Promise<void> {
    if (ofd === undefined) return;
    try {
        await openv.system["party.openv.impl.filesystem.closeByOfd"](ofd);
    } catch (e) {
        log(`close ofd=${ofd} ignored: ${String(e)}`);
    }
}

async function openControlWriter(path: string): Promise<number> {
    const ofd = await openv.system["party.openv.filesystem.open"](path, "w", 0o666);
    log(`opened control writer ofd=${ofd} for ${path}`);
    return ofd;
}

async function writeControl(proc: DemoProc, message: string): Promise<void> {
    const payload = `${message}\n`;
    await openv.system["party.openv.filesystem.write.write"](proc.controlOfd, enc.encode(payload));
    log(`sent -> ${proc.name} (${proc.pid}) message='${message}'`);
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

async function spawnDemoWorker(name: string, fifoPath: string): Promise<DemoProc> {
    const pid = await openv.system["party.openv.process.spawn"](FILE_PATH, [
        FILE_PATH,
        "--fifo",
        fifoPath,
        "--name",
        name,
    ], {
        cwd: "/",
        env: {},
        stdio: [null, "pipe", "pipe"],
    });

    log(`spawned ${name} pid=${pid}`);
    const stdio = await openv.system["party.openv.process.getstdio"](pid);
    if (stdio.stdout === undefined) {
        throw new Error(`missing stdout pipe for pid ${pid}`);
    }

    const proc: DemoProc = {
        name,
        pid,
        fifoPath,
        controlOfd: -1,
        stdoutOfd: stdio.stdout,
        stderrOfd: stdio.stderr,
    };

    pumpOfd("stdout", pid, stdio.stdout).catch((e) => log(`stdout pump failed pid=${pid}: ${String(e)}`));
    if (stdio.stderr !== undefined) {
        pumpOfd("stderr", pid, stdio.stderr).catch((e) => log(`stderr pump failed pid=${pid}: ${String(e)}`));
    }

    proc.controlOfd = await openControlWriter(fifoPath);
    active.set(pid, proc);

    (async () => {
        const code = await openv.system["party.openv.process.wait"](pid);
        log(`${name} pid=${pid} exited code=${String(code)}`);
        await closeOfdSafe(proc.controlOfd);
        active.delete(pid);
        if (active.size === 0) {
            setStatus("all demo processes exited", code === 0);
        }
    })().catch((e) => {
        log(`wait failed pid=${pid}: ${String(e)}`);
    });

    return proc;
}

async function spawnPipedProcess(name: string, args: string[]): Promise<number> {
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

spawnBtn.onclick = async () => {
    try {
        stdoutEl.textContent = "";
        setStatus("starting two-process fifo demo...");

        for (const proc of active.values()) {
            await closeOfdSafe(proc.controlOfd);
        }
        active.clear();

        await ensureDir(FIFO_DIR);
        await ensureFreshFifo(FIFO_A);
        await ensureFreshFifo(FIFO_B);

        const procA = await spawnDemoWorker("proc-A", FIFO_A);
        const procB = await spawnDemoWorker("proc-B", FIFO_B);

        await writeControl(procA, "hello-from-orchestrator");
        await writeControl(procB, "hello-from-orchestrator");

        setStatus(`running pids: ${procA.pid}, ${procB.pid}`, true);
        log(`demo started with two workers over FIFOs ${FIFO_A} and ${FIFO_B}`);

    } catch (e) {
        setStatus(`error: ${e}`, false);
        log(`ERROR: ${e}`);
    }
};

pingBtn.onclick = async () => {
    try {
        if (active.size === 0) {
            setStatus("no running demo processes", false);
            return;
        }
        for (const proc of active.values()) {
            await writeControl(proc, `ping ${ts()}`);
        }
        setStatus(`sent ping to ${active.size} processes`, true);
    } catch (e) {
        setStatus(`ping failed: ${String(e)}`, false);
        log(`ERROR: ping failed: ${String(e)}`);
    }
};

quitBtn.onclick = async () => {
    try {
        if (active.size === 0) {
            setStatus("no running demo processes", false);
            return;
        }
        for (const proc of active.values()) {
            await writeControl(proc, "quit");
        }
        setStatus(`quit sent to ${active.size} processes`);
    } catch (e) {
        setStatus(`quit failed: ${String(e)}`, false);
        log(`ERROR: quit failed: ${String(e)}`);
    }
};

cleanupBtn.onclick = async () => {
    try {
        for (const proc of active.values()) {
            await closeOfdSafe(proc.controlOfd);
        }
        active.clear();
        try { await openv.system["party.openv.filesystem.write.unlink"](FIFO_A); } catch {}
        try { await openv.system["party.openv.filesystem.write.unlink"](FIFO_B); } catch {}
        setStatus("cleanup complete", true);
        log("forced cleanup complete");
    } catch (e) {
        setStatus(`cleanup failed: ${String(e)}`, false);
        log(`ERROR: cleanup failed: ${String(e)}`);
    }
};

phase2Btn.onclick = async () => {
    try {
        stdoutEl.textContent = "";
        setStatus("starting phase 2 stream socket demo...");

        await ensureDir(FIFO_DIR);
        try { await openv.system["party.openv.filesystem.write.unlink"](STREAM_SOCKET_PATH); } catch {}

        const serverPid = await spawnPipedProcess("phase2-server", [
            FILE_PATH,
            "--mode", "stream-server",
            "--name", "stream-server",
            "--socket", STREAM_SOCKET_PATH,
        ]);

        await new Promise((resolve) => setTimeout(resolve, 50));

        const clientPid = await spawnPipedProcess("phase2-client", [
            FILE_PATH,
            "--mode", "stream-client",
            "--name", "stream-client",
            "--socket", STREAM_SOCKET_PATH,
        ]);

        const [serverCode, clientCode] = await Promise.all([
            openv.system["party.openv.process.wait"](serverPid),
            openv.system["party.openv.process.wait"](clientPid),
        ]);

        try { await openv.system["party.openv.filesystem.write.unlink"](STREAM_SOCKET_PATH); } catch {}

        const ok = serverCode === 0 && clientCode === 0;
        setStatus(`phase2 complete: server=${String(serverCode)} client=${String(clientCode)}`, ok);
        log(`phase2 stream demo finished server=${String(serverCode)} client=${String(clientCode)}`);
    } catch (e) {
        setStatus(`phase2 failed: ${String(e)}`, false);
        log(`ERROR: phase2 failed: ${String(e)}`);
    }
};

phase3Btn.onclick = async () => {
    try {
        stdoutEl.textContent = "";
        setStatus("starting phase 3 datagram demo...");

        await ensureDir(FIFO_DIR);
        try { await openv.system["party.openv.filesystem.write.unlink"](DGRAM_SERVER_PATH); } catch {}
        try { await openv.system["party.openv.filesystem.write.unlink"](DGRAM_CLIENT_PATH); } catch {}

        const serverPid = await spawnPipedProcess("phase3-server", [
            FILE_PATH,
            "--mode", "dgram-server",
            "--name", "dgram-server",
            "--socket", DGRAM_SERVER_PATH,
        ]);

        await new Promise((resolve) => setTimeout(resolve, 50));

        const clientPid = await spawnPipedProcess("phase3-client", [
            FILE_PATH,
            "--mode", "dgram-client",
            "--name", "dgram-client",
            "--socket", DGRAM_SERVER_PATH,
            "--local", DGRAM_CLIENT_PATH,
        ]);

        const [serverCode, clientCode] = await Promise.all([
            openv.system["party.openv.process.wait"](serverPid),
            openv.system["party.openv.process.wait"](clientPid),
        ]);

        try { await openv.system["party.openv.filesystem.write.unlink"](DGRAM_SERVER_PATH); } catch {}
        try { await openv.system["party.openv.filesystem.write.unlink"](DGRAM_CLIENT_PATH); } catch {}

        const ok = serverCode === 0 && clientCode === 0;
        setStatus(`phase3 complete: server=${String(serverCode)} client=${String(clientCode)}`, ok);
        log(`phase3 datagram demo finished server=${String(serverCode)} client=${String(clientCode)}`);
    } catch (e) {
        setStatus(`phase3 failed: ${String(e)}`, false);
        log(`ERROR: phase3 failed: ${String(e)}`);
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