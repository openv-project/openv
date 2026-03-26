import * as esbuild from "esbuild";
import { readdir, readFile, writeFile, mkdir, cp, rm, chmod, chown, lstat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createTar, type TarFileAttrs, type TarFileInput } from "nanotar";
import { importRewriter } from "./import-rewriter.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const STAGE0_STAGING = join(ROOT, "stage0", ".staging");
const STAGE0_SKEL = join(ROOT, "stage0", "skel");

const ROOT_UID = 0;
const ROOT_GID = 0;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

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
    { src: "node_modules/@remote-dom/core/source", stage0Path: "/lib/remote-dom/core", distName: "remote-dom-core" },
    { src: "node_modules/@remote-dom/polyfill/source", stage0Path: "/lib/remote-dom/polyfill", distName: "remote-dom-polyfill" },
];

const WEBSERVER = join(ROOT, "packages/openv-webserver");

type Stage0Meta = {
    uid?: number;
    gid?: number;
    mode?: number | string;
    // Reserved: currently treated as a copy alias to another staged file path.
    symlink?: string;
};

type StagedFile = {
    name: string;
    fullPath: string;
    fromSkel: boolean;
    meta?: Stage0Meta;
};

async function ensureDir(dir: string) {
    await mkdir(dir, { recursive: true });
}

function toPosix(p: string): string {
    return p.replaceAll("\\", "/");
}

function modeToOctalString(mode: number | string | undefined, fallback: number): string {
    if (typeof mode === "number" && Number.isFinite(mode)) {
        return mode.toString(8);
    }
    if (typeof mode === "string" && mode.trim().length > 0) {
        const parsed = Number.parseInt(mode, 8);
        if (!Number.isNaN(parsed)) {
            return parsed.toString(8);
        }
    }
    return fallback.toString(8);
}

async function readMeta(metaFile: string): Promise<Stage0Meta | undefined> {
    if (!existsSync(metaFile)) return undefined;
    const raw = await readFile(metaFile, "utf8");
    return JSON.parse(raw) as Stage0Meta;
}

async function applyFsAttrs(path: string, meta: Stage0Meta | undefined, defaultMode: number) {
    const mode = Number.parseInt(modeToOctalString(meta?.mode, defaultMode), 8);
    try {
        await chmod(path, mode);
    } catch {
        // Ignore environments where chmod is restricted.
    }
    try {
        await chown(path, meta?.uid ?? ROOT_UID, meta?.gid ?? ROOT_GID);
    } catch {
        // Ignore environments where chown is restricted.
    }
}

async function walkStagedFiles(
    dir: string,
    skelFileSet: Set<string>,
    skelMetaMap: Map<string, Stage0Meta>,
): Promise<StagedFile[]> {
    const out: StagedFile[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...await walkStagedFiles(full, skelFileSet, skelMetaMap));
            continue;
        }
        if (!entry.isFile()) continue;

        const rel = toPosix(relative(STAGE0_STAGING, full));
        out.push({
            name: rel,
            fullPath: full,
            fromSkel: skelFileSet.has(rel),
            meta: skelMetaMap.get(rel),
        });
    }

    return out;
}

async function materializeStage0Skel(stagingDir: string): Promise<{
    skelFileSet: Set<string>;
    skelMetaMap: Map<string, Stage0Meta>;
}> {
    const skelFileSet = new Set<string>();
    const skelMetaMap = new Map<string, Stage0Meta>();

    if (!existsSync(STAGE0_SKEL)) {
        return { skelFileSet, skelMetaMap };
    }

    type PendingAlias = {
        stagePath: string;
        aliasTarget: string;
        meta?: Stage0Meta;
    };
    const pendingAliases: PendingAlias[] = [];

    const copyDir = async (srcDir: string) => {
        const entries = await readdir(srcDir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (entry.name.endsWith(".meta")) continue;

            const srcPath = join(srcDir, entry.name);
            const relPath = toPosix(relative(STAGE0_SKEL, srcPath));
            const stagePath = join(stagingDir, relPath);
            const meta = await readMeta(`${srcPath}.meta`);

            if (entry.isDirectory()) {
                await ensureDir(stagePath);
                await applyFsAttrs(stagePath, meta, DEFAULT_DIR_MODE);
                await copyDir(srcPath);
                continue;
            }

            if (!entry.isFile()) continue;

            await ensureDir(dirname(stagePath));

            if (typeof meta?.symlink === "string" && meta.symlink.length > 0) {
                pendingAliases.push({ stagePath, aliasTarget: meta.symlink, meta });
                skelFileSet.add(relPath);
                skelMetaMap.set(relPath, meta);
                continue;
            }

            await cp(srcPath, stagePath);
            await applyFsAttrs(stagePath, meta, DEFAULT_FILE_MODE);

            skelFileSet.add(relPath);
            if (meta) skelMetaMap.set(relPath, meta);
        }
    };

    await copyDir(STAGE0_SKEL);

    for (const alias of pendingAliases) {
        const aliasRel = alias.aliasTarget.startsWith("/")
            ? alias.aliasTarget.slice(1)
            : alias.aliasTarget;
        const targetPath = join(stagingDir, aliasRel);
        await cp(targetPath, alias.stagePath);
        await applyFsAttrs(alias.stagePath, alias.meta, DEFAULT_FILE_MODE);
    }

    return { skelFileSet, skelMetaMap };
}

function tarAttrs(meta: Stage0Meta | undefined, fallbackMode: number): TarFileAttrs {
    return {
        uid: meta?.uid ?? ROOT_UID,
        gid: meta?.gid ?? ROOT_GID,
        mode: modeToOctalString(meta?.mode, fallbackMode),
    };
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
await rm(STAGE0_STAGING, { recursive: true, force: true });
await ensureDir(STAGE0_STAGING);

const { skelFileSet, skelMetaMap } = await materializeStage0Skel(STAGE0_STAGING);

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

    let tsFiles = (await collectFiles(srcDir, [".ts"]))
        .filter(f => !f.endsWith(".d.ts"));

    // For remote-dom packages, only include non-test files
    if (pkg.distName.startsWith("remote-dom-")) {
        tsFiles = tsFiles.filter(f => !f.includes("/tests/") && !f.endsWith(".test.ts"));
    }

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
const tarEntries: TarFileInput[] = [];

const stagedFiles = await walkStagedFiles(STAGE0_STAGING, skelFileSet, skelMetaMap);
const stagedFilesOrdered = [
    ...stagedFiles.filter((item) => item.fromSkel),
    ...stagedFiles.filter((item) => !item.fromSkel),
];

for (const file of stagedFilesOrdered) {
    const stat = await lstat(file.fullPath);
    if (!stat.isFile()) continue;

    tarEntries.push({
        name: file.name,
        data: await readFile(file.fullPath),
        attrs: tarAttrs(file.meta, DEFAULT_FILE_MODE),
    });
}

const tar = createTar(tarEntries, {
    attrs: {
        uid: ROOT_UID,
        gid: ROOT_GID,
    },
});
await writeFile(join(DIST, "stage0.tar"), tar);
console.log(` stage0.tar (${tarEntries.length} files)`);


console.log(`\nbuild complete! Output in ${DIST}`);