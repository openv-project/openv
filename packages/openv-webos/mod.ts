import {
  FileSystemCoreComponent,
  FileSystemIoctlComponent,
  FileSystemPipeComponent,
  FileSystemReadOnlyComponent,
  FileSystemReadWriteComponent,
  ProcessComponent,
  RegistryReadComponent,
  RegistryWriteComponent,
} from "@openv-project/openv-api";
import {
  ClientOpEnv,
  CoreFSExt,
  CoreProcessExt,
  ProcessScopedFS,
  ProcessScopedProcess,
  ProcessScopedRegistry,
  createPostMessageTransport,
  registerWebExecutor,
} from "@openv-project/openv-core";

const CHANNEL = "openv-sw-channel";
const controller = navigator.serviceWorker.controller;
if (!controller) {
  throw new Error("No service worker controller available");
}

const localEndpoint = {
  postMessage(_msg: unknown) {},
  addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
    navigator.serviceWorker.addEventListener("message", handler);
  },
  removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
    navigator.serviceWorker.removeEventListener("message", handler);
  },
};

const remoteEndpoint = {
  postMessage(msg: unknown) {
    controller.postMessage(msg);
  },
};

const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, CHANNEL);
const openv = new ClientOpEnv<
  FileSystemCoreComponent &
    FileSystemReadOnlyComponent &
    FileSystemReadWriteComponent &
    FileSystemPipeComponent &
    FileSystemIoctlComponent &
    CoreFSExt &
    ProcessComponent &
    CoreProcessExt &
    RegistryReadComponent &
    RegistryWriteComponent
>(transport);

await openv.enumerateRemote();
(globalThis as any).openv = openv;

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

  const exports: Record<string, Function> = {};
  for (const scoped of [scopedFs, scopedProcess, scopedRegistry]) {
    let proto = Object.getPrototypeOf(scoped);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || name === "supports" || exports[name]) continue;
        const value = (scoped as any)[name];
        if (typeof value === "function") exports[name] = value.bind(scoped);
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
  return exports;
});

const REGISTRY_KEY = "/userspace/party/openv/webos/shell";
const TEST_SHELL_PATH = "/test.js";
const DEFAULT_SHELL = TEST_SHELL_PATH;
const DEFAULT_CONFIG = {};
const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing #app container");
}

app.innerHTML = `<div id="terminal" style="width:100vw;height:100vh;background:#000;"></div>`;
document.documentElement.style.width = "100%";
document.documentElement.style.height = "100%";
document.body.style.margin = "0";
document.body.style.width = "100%";
document.body.style.height = "100%";
app.style.width = "100vw";
app.style.height = "100vh";
app.style.overflow = "hidden";
app.style.background = "#000";

type HtermModule = {
  hterm?: { Terminal: new () => any };
  Terminal?: new () => any;
  default?: { Terminal: new () => any };
};

const htermModulePath = "/@/lib/hterm/dist/js/hterm.js";
const htermModule = (await import(htermModulePath)) as HtermModule;
const TerminalCtor =
  htermModule.hterm?.Terminal ??
  htermModule.default?.Terminal ??
  htermModule.Terminal;
if (!TerminalCtor) {
  throw new Error("Failed to load hterm Terminal constructor");
}

function splitCommandLine(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((arg) => (arg.startsWith("\"") && arg.endsWith("\"") ? arg.slice(1, -1) : arg));
}

function parseCliArgs(serialized: string | null): string[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fallback below
  }
  return splitCommandLine(serialized);
}

function parseTerminalLaunchArgs(): { cmd?: string } {
  const url = new URL(window.location.href);
  if (url.searchParams.has("cmd")) {
    const cmd = url.searchParams.get("cmd")?.trim();
    return cmd ? { cmd } : {};
  }

  const argv = parseCliArgs(url.searchParams.get("args"));
  let scan = "";
  const argmap: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg || arg === "--") continue;
    if (arg.startsWith("--")) {
      scan = arg.slice(2);
      continue;
    }
    if (!scan) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    argmap[scan] = arg;
    scan = "";
  }
  if (scan) {
    throw new Error(`Expected argument after --${scan}`);
  }
  for (const key of Object.keys(argmap)) {
    if (key !== "cmd") {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return { cmd: argmap.cmd };
}

function lfToCrlf(input: Uint8Array): Uint8Array {
  let lfCount = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0a) lfCount++;
  }
  const output = new Uint8Array(input.length + lfCount);
  let outputIndex = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0a) output[outputIndex++] = 0x0d;
    output[outputIndex++] = input[i];
  }
  return output;
}

function buildTestShellSource(): string {
  return `import { getOpEnv } from "/@/etc/openv.js";

const openv = await getOpEnv();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeOut = async (text) => {
  await openv.system["party.openv.filesystem.write.write"](1, encoder.encode(text));
};

const runCommand = async (line) => {
  if (line === "") return;
  if (line === "exit") {
    await openv.system["party.openv.process.local.exit"](0);
    return;
  }
  if (line === "help") {
    await writeOut("commands: help, echo <text>, pwd, exit\\r\\n");
    return;
  }
  if (line === "pwd") {
    const cwd = await openv.system["party.openv.process.local.getcwd"]();
    await writeOut(cwd + "\\r\\n");
    return;
  }
  if (line.startsWith("echo ")) {
    await writeOut(line.slice(5) + "\\r\\n");
    return;
  }
  await writeOut("unknown command: " + line + "\\r\\n");
};

let buffer = "";
await writeOut("openv test shell\\r\\n$ ");

while (true) {
  const chunk = await openv.system["party.openv.filesystem.read.read"](0, 1);
  if (chunk.length === 0) break;
  const ch = decoder.decode(chunk);
  if (ch === "\\r" || ch === "\\n") {
    await writeOut("\\r\\n");
    const line = buffer.trim();
    buffer = "";
    await runCommand(line);
    if (line === "exit") break;
    await writeOut("$ ");
    continue;
  }
  if (ch === "\\u007f") {
    if (buffer.length > 0) {
      buffer = buffer.slice(0, -1);
      await writeOut("\\b \\b");
    }
    continue;
  }
  buffer += ch;
  await writeOut(ch);
}
`;
}

async function writeTestShellProgram(): Promise<void> {
  const shellSource = buildTestShellSource();
  const shellFd = await openv.system["party.openv.filesystem.open"](TEST_SHELL_PATH, "w", 0o755);
  try {
    await openv.system["party.openv.filesystem.write.write"](
      shellFd,
      new TextEncoder().encode(shellSource),
      0,
      undefined,
      0
    );
  } finally {
    await openv.system["party.openv.filesystem.close"](shellFd);
  }
}

async function ensureShellSettings(): Promise<{ shell: string; config: Record<string, unknown> }> {
  await openv.system["party.openv.registry.write.createKey"](REGISTRY_KEY).catch(() => {});
  const shellRaw = await openv.system["party.openv.registry.read.readEntry"](REGISTRY_KEY, "shell");
  const shell = typeof shellRaw === "string" && shellRaw.length > 0 ? shellRaw : DEFAULT_SHELL;
  if (shellRaw !== shell) {
    await openv.system["party.openv.registry.write.writeEntry"](REGISTRY_KEY, "shell", shell);
  }

  const configRaw = await openv.system["party.openv.registry.read.readEntry"](REGISTRY_KEY, "config");
  let config = DEFAULT_CONFIG as Record<string, unknown>;
  if (typeof configRaw === "string" && configRaw.length > 0) {
    try {
      const parsed = JSON.parse(configRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = DEFAULT_CONFIG;
    }
  }
  if (configRaw === null) {
    await openv.system["party.openv.registry.write.writeEntry"](REGISTRY_KEY, "config", JSON.stringify(config));
  }
  return { shell, config };
}

await writeTestShellProgram();

const launchArgs = parseTerminalLaunchArgs();
const { shell } = await ensureShellSettings();
const selectedCommand = launchArgs.cmd ?? shell;
const cmdline = splitCommandLine(selectedCommand);
if (cmdline.length === 0) {
  throw new Error("No command specified for terminal process");
}

const term = new TerminalCtor();
const terminalElement = document.getElementById("terminal");
if (!terminalElement) {
  throw new Error("Missing terminal host element");
}

term.decorate(terminalElement);

term.onTerminalReady = async () => {
  const io = term.io.push();
  term.setBackgroundColor("#000000");
  term.setCursorColor("#c9d1d9");
  term.setForegroundColor("#c9d1d9");
  term.installKeyboard();

  const encoder = new TextEncoder();
  const processEnv = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
  };
  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const writeStatus = (message: string) => {
    io.writeUTF8(encoder.encode(`\r\n${message}\r\n`));
  };

  let alive = true;
  let pid: number | null = null;
  let stdio: { stdin: number; stdout: number; stderr: number } | null = null;
  let finalizePromise: Promise<void> | null = null;

  const disableTerminalInput = () => {
    io.onVTKeystroke = () => {};
    io.sendString = () => {};
    io.onTerminalResize = () => {};
  };

  const closeStdio = async (): Promise<void> => {
    if (!stdio) return;
    await openv.system["party.openv.filesystem.close"](stdio.stdin).catch(() => {});
    await openv.system["party.openv.filesystem.close"](stdio.stdout).catch(() => {});
    await openv.system["party.openv.filesystem.close"](stdio.stderr).catch(() => {});
    stdio = null;
  };

  const onBeforeUnload = () => {
    void finalize("unload");
  };

  const finalize = (
    reason: "startup-failed" | "spawn-failed" | "process-exited" | "unload",
    detail?: string,
    exitCode?: number | null
  ): Promise<void> => {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
      if (!alive) return;
      alive = false;
      disableTerminalInput();
      removeEventListener("beforeunload", onBeforeUnload);

      if (reason === "unload" && pid !== null) {
        await openv.system["party.openv.process.kill"](pid).catch(() => {});
      }
      await closeStdio();

      if (reason === "startup-failed" || reason === "spawn-failed") {
        writeStatus(`[process failed to start] ${detail ?? "unknown error"}`);
      } else if (reason === "process-exited") {
        const base = `[process exited: ${exitCode ?? "killed"}]`;
        writeStatus(detail ? `${base} ${detail}` : base);
      }
    })();
    return finalizePromise;
  };

  try {
    pid = await openv.system["party.openv.process.spawn"](
      cmdline[0],
      cmdline,
      {
        cwd: "/",
        env: processEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch (error) {
    await finalize("spawn-failed", describeError(error));
    return;
  }

  try {
    const stdioResult = await openv.system["party.openv.process.getstdio"](pid);
    if (
      stdioResult.stdin === undefined ||
      stdioResult.stdout === undefined ||
      stdioResult.stderr === undefined
    ) {
      throw new Error("Process stdio pipes were not created");
    }
    stdio = {
      stdin: stdioResult.stdin,
      stdout: stdioResult.stdout,
      stderr: stdioResult.stderr,
    };
  } catch (error) {
    await finalize("startup-failed", describeError(error));
    return;
  }

  addEventListener("beforeunload", onBeforeUnload);

  const writeStdin = async (input: string): Promise<void> => {
    if (!alive || !stdio) return;
    const bytes = encoder.encode(input);
    await openv.system["party.openv.filesystem.write.write"](stdio.stdin, bytes);
  };

  io.onVTKeystroke = (key: string) => {
    void writeStdin(key);
  };
  io.sendString = (value: string) => {
    void writeStdin(value);
  };
  let windowResizeIoctlSupported = true;
  io.onTerminalResize = (cols: number, rows: number) => {
    if (!alive || !stdio) return;
    if (!windowResizeIoctlSupported) return;
    void openv.system["party.openv.filesystem.ioctl.ioctl"](
      stdio.stdin,
      "tty.setWindowSize",
      { cols, rows }
    ).catch(() => {
      windowResizeIoctlSupported = false;
    });
  };
  io.onTerminalResize(term.screenSize.width, term.screenSize.height);

  const readLoop = async (fd: number): Promise<void> => {
    while (alive) {
      const chunk = await openv.system["party.openv.filesystem.read.read"](fd, 8192);
      if (chunk.length === 0) break;
      io.writeUTF8(lfToCrlf(chunk));
    }
  };

  const stdoutLoop = readLoop(stdio.stdout).catch(() => {});
  const stderrLoop = readLoop(stdio.stderr).catch(() => {});

  try {
    const exitCode = await openv.system["party.openv.process.wait"](pid);
    await finalize("process-exited", undefined, exitCode);
  } catch (error) {
    await finalize("process-exited", `(wait failed: ${describeError(error)})`, null);
  } finally {
    await Promise.all([stdoutLoop, stderrLoop]);
  }
};
