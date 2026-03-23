import * as esbuild from "esbuild";
import { readdir, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createTar } from "nanotar";
import { importRewriter } from "./import-rewriter.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const STAGE0_STAGING = join(ROOT, ".stage0-staging");

const STAGE0_PACKAGES: Array<{
    src: string;
    stage0Path: string;
    distName: string;
}> = [
        { src: "packages/openv-api", stage0Path: "/lib/openv/openv-api", distName: "openv-api" },
        { src: "packages/openv-core", stage0Path: "/lib/openv/openv-core", distName: "openv-core" },
        { src: "packages/party.openv.api.fs", stage0Path: "/lib/openv/api/fs", distName: "party.openv.api.fs" },
        { src: "packages/party.openv.api.registry", stage0Path: "/lib/openv/api/registry", distName: "party.openv.api.registry" },
        { src: "packages/openv-webos", stage0Path: "/srv/openv-webos", distName: "openv-webos" },
    ];

const WEBSERVER = join(ROOT, "packages/openv-webserver");

async function ensureDir(dir: string) {
    await mkdir(dir, { recursive: true });
}

async function collectFiles(dir: string, exts: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        if (exts.some(ext => entry.name.endsWith(ext))) {
            results.push(join((entry as any).parentPath ?? (entry as any).path, entry.name));
        }
    }
    return results;
}

await ensureDir(DIST);
await ensureDir(STAGE0_STAGING);

console.log("generating type declarations...");
for (const pkg of STAGE0_PACKAGES) {
    const tsconfig = join(ROOT, pkg.src, "tsconfig.json");
    if (!existsSync(tsconfig)) continue;
    try {
        execSync(`tsc -p .`, { cwd: join(ROOT, pkg.src), stdio: "inherit" });
        console.log(`  types completed for ${pkg.src}`);
    } catch {
        console.warn(`  types for ${pkg.src} errored`);
    }
}

console.log("\ncompiling STAGE0 packages...");
for (const pkg of STAGE0_PACKAGES) {
    const srcDir = join(ROOT, pkg.src);
    const stageDir = join(STAGE0_STAGING, pkg.stage0Path);

    const tsFiles = (await collectFiles(srcDir, [".ts"]))
        .filter(f => !f.endsWith(".d.ts"));

    if (tsFiles.length === 0) continue;

    await esbuild.build({
        entryPoints: tsFiles,
        outdir: stageDir,
        outbase: srcDir,
        format: "esm",
        bundle: true,
        packages: "external",
        platform: "browser",
        minify: true,
        sourcemap: true,
        target: "es2022",
        plugins: [importRewriter],
    });
    console.log(`  js: ${pkg.distName} (${tsFiles.length} files)`);

    const tscOut = join(ROOT, "dist-types", pkg.distName);
    if (existsSync(tscOut)) {
        const dtsFiles = await collectFiles(tscOut, [".d.ts", ".d.ts.map"]);
        for (const dts of dtsFiles) {
            const rel = relative(tscOut, dts);
            const dest = join(stageDir, rel);
            await ensureDir(dirname(dest));
            await cp(dts, dest);
        }
        console.log(`  d.ts: ${pkg.distName} (${dtsFiles.length} files)`);
    }
}

console.log("\nbundling sw.ts...");
await esbuild.build({
    entryPoints: [join(WEBSERVER, "sw.ts")],
    outfile: join(DIST, "sw.js"),
    format: "esm",
    bundle: true,
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: "es2022",
});
console.log("  sw.js");

console.log("\ncompiling bootstrap.ts...");
await esbuild.build({
    entryPoints: [join(WEBSERVER, "bootstrap.ts")],
    outfile: join(DIST, "bootstrap.js"),
    format: "esm",
    bundle: false,
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: "es2022",
});
console.log("  bootstrap.js");

await cp(join(WEBSERVER, "index.html"), join(DIST, "index.html"));
console.log("  index.html");

await ensureDir(join(STAGE0_STAGING, "srv/openv-webos"));
await cp(
    join(ROOT, "packages/openv-webos/index.html"),
    join(STAGE0_STAGING, "srv/openv-webos/index.html")
);

console.log("\ncreating stage0.tar...");
const tarEntries: { name: string; data: Uint8Array }[] = [];

for (const entry of await readdir(STAGE0_STAGING, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join((entry as any).parentPath ?? (entry as any).path, entry.name);
    tarEntries.push({
        name: relative(STAGE0_STAGING, full),
        data: await readFile(full),
    });
}

const tar = createTar(tarEntries);
await writeFile(join(DIST, "stage0.tar"), tar);
console.log(` stage0.tar (${tarEntries.length} files)`);


console.log(`\nbuild complete! Output in ${DIST}`);