import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat, watch } from "node:fs/promises";
import { join, extname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = new URL("../", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const PORT = 3300;

const MIME: Record<string, string> = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".html": "text/html",
    ".css": "text/css",
    ".json": "application/json",
    ".ts": "application/typescript",
    ".map": "application/json",
    ".tar": "application/x-tar",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

console.log("building...");
await new Promise<void>((resolve, reject) => {
    const proc = spawn("tsx", ["build/build.ts"], { cwd: ROOT, stdio: "inherit" });
    proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`build failed: ${code}`)));
});
console.log("initial build complete");

let rebuilding = false;
let rebuildQueued = false;
let buildProc: ChildProcess | null = null;

async function rebuild() {
    if (rebuilding) {
        rebuildQueued = true;
        return;
    }
    rebuilding = true;
    console.log("\n[dev] rebuilding...");

    await new Promise<void>((resolve) => {
        buildProc = spawn("tsx", ["build/build.ts"], { cwd: ROOT, stdio: "inherit" });
        buildProc.on("exit", () => {
            buildProc = null;
            resolve();
        });
    });

    rebuilding = false;
    console.log("[dev] rebuild complete");

    if (rebuildQueued) {
        rebuildQueued = false;
        rebuild();
    }
}

const watcher = watch(join(ROOT, "packages"), { recursive: true });
(async () => {
    for await (const event of watcher) {
        if (event.filename?.endsWith(".ts") || event.filename?.endsWith(".html")) {
            rebuild();
        }
    }
})();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let pathname = url.pathname;

    if (pathname === "/sw.js" || pathname === "/sw.js.map") {
        res.setHeader("Service-Worker-Allowed", "/");
    }

    if (pathname === "/") pathname = "/index.html";

    const filePath = join(DIST, pathname);

    try {
        await stat(filePath);
        const data = await readFile(filePath);
        const mime = MIME[extname(filePath)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
    } catch {
        try {
            const data = await readFile(join(DIST, "index.html"));
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(data);
        } catch {
            res.writeHead(404);
            res.end("not found");
        }
    }
});

server.listen(PORT, () => {
    console.log(`\ndev server: http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
    buildProc?.kill();
    server.close();
    process.exit(0);
});