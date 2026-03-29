import * as esbuild from "esbuild";
import { readdir, readFile, writeFile, mkdir, cp, rm, chmod, chown, lstat } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createTar, type TarFileAttrs, type TarFileInput } from "nanotar";
import { gzipSync } from "fflate";
import { importRewriter } from "./import-rewriter.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const PACKAGES_DIR = join(DIST, "packages");

const ROOT_UID = 0;
const ROOT_GID = 0;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

type Stage0Meta = {
    uid?: number;
    gid?: number;
    mode?: number | string;
    symlink?: string;
};

type PackageConfig = {
    src: string;
    installPath: string;
    distName: string;
    typesOnly?: boolean;
    buildUpk?: boolean;
    manifestPath?: string;
};

const PACKAGES: PackageConfig[] = [
    { 
        src: "packages/openv-core", 
        installPath: "/lib/openv/openv-core", 
        distName: "openv-core",
        buildUpk: true,
        manifestPath: "packages/openv-core/.manifest"
    },
    { 
        src: "packages/openv-api", 
        installPath: "/lib/openv/openv-api", 
        distName: "openv-api", 
        typesOnly: true 
    },
    {
        src: "packages/party.openv.libupk",
        installPath: "/lib/openv/libupk",
        distName: "party.openv.libupk",
        buildUpk: true,
        manifestPath: "packages/party.openv.libupk/.manifest"
    },
    { 
        src: "packages/party.openv.api.fs", 
        installPath: "/lib/openv/api/fs", 
        distName: "party.openv.api.fs" 
    },
    { 
        src: "packages/party.openv.api.registry", 
        installPath: "/lib/openv/api/registry", 
        distName: "party.openv.api.registry" 
    },
    { 
        src: "packages/openv-webos", 
        installPath: "/srv/openv-webos", 
        distName: "openv-webos",
        buildUpk: true,
        manifestPath: "packages/openv-webos/.manifest"
    },
    {
        src: "node_modules/fflate/esm",
        installPath: "/lib/fflate",
        distName: "fflate",
        buildUpk: true,
        manifestPath: "packages/fflate/.manifest"
    },
    {
        src: "node_modules/nanotar/dist",
        installPath: "/lib/nanotar",
        distName: "nanotar",
        buildUpk: true,
        manifestPath: "packages/nanotar/.manifest"
    },
];

const WEBSERVER = join(ROOT, "packages/openv-webserver");

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

async function copySkelFiles(
    skelDir: string,
    destDir: string
): Promise<Map<string, Stage0Meta>> {
    const skelMetaMap = new Map<string, Stage0Meta>();

    if (!existsSync(skelDir)) {
        return skelMetaMap;
    }

    const copyDir = async (srcDir: string, relPath: string = "") => {
        const entries = await readdir(srcDir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (entry.name.endsWith(".meta")) continue;

            const srcPath = join(srcDir, entry.name);
            const currentRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
            const destPath = join(destDir, currentRelPath);
            const meta = await readMeta(`${srcPath}.meta`);

            if (entry.isDirectory()) {
                await ensureDir(destPath);
                await applyFsAttrs(destPath, meta, DEFAULT_DIR_MODE);
                await copyDir(srcPath, currentRelPath);
                continue;
            }

            if (!entry.isFile()) continue;

            await ensureDir(dirname(destPath));
            await cp(srcPath, destPath);
            await applyFsAttrs(destPath, meta, DEFAULT_FILE_MODE);

            if (meta) skelMetaMap.set(currentRelPath, meta);
        }
    };

    await copyDir(skelDir);
    return skelMetaMap;
}

async function buildPackage(
    pkg: PackageConfig,
    buildDir: string,
    skelMetaMap: Map<string, Stage0Meta>
): Promise<void> {
    const srcDir = join(ROOT, pkg.src);
    const packageBuildDir = join(buildDir, pkg.distName);
    const installBasePath = pkg.installPath.replace(/^\//, "");
    const packageInstallDir = join(packageBuildDir, installBasePath);

    await ensureDir(packageInstallDir);

    if (!pkg.typesOnly) {
        if (pkg.distName === "fflate") {
            await esbuild.build({
                entryPoints: [join(srcDir, "browser.js")],
                outfile: join(packageInstallDir, "index.mjs"),
                format: "esm",
                bundle: true,
                platform: "browser",
                minify: true,
                sourcemap: true,
                target: "es2022",
            });
            const typeFiles = [join(srcDir, "browser.d.ts"), join(srcDir, "index.d.mts")];
            for (const typeFile of typeFiles) {
                if (!existsSync(typeFile)) continue;
                const name = basename(typeFile) === "browser.d.ts" ? "index.d.ts" : basename(typeFile);
                await cp(typeFile, join(packageInstallDir, name));
            }
            console.log(`  js: ${pkg.distName} (bundled browser entry)`);
        } else if (pkg.distName === "nanotar") {
            await esbuild.build({
                entryPoints: [join(srcDir, "index.mjs")],
                outfile: join(packageInstallDir, "index.mjs"),
                format: "esm",
                bundle: true,
                platform: "browser",
                minify: true,
                sourcemap: true,
                target: "es2022",
            });
            const typeFiles = [join(srcDir, "index.d.ts"), join(srcDir, "index.d.mts"), join(srcDir, "index.d.cts")];
            for (const typeFile of typeFiles) {
                if (!existsSync(typeFile)) continue;
                await cp(typeFile, join(packageInstallDir, basename(typeFile)));
            }
            console.log(`  js: ${pkg.distName} (bundled esm entry)`);
        } else {
        let tsFiles = (await collectFiles(srcDir, [".ts"]))
            .filter(f => !f.endsWith(".d.ts"));


        if (tsFiles.length > 0) {
            await esbuild.build({
                entryPoints: tsFiles,
                outdir: packageInstallDir,
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
        } else {
            const jsAssets = await collectFiles(srcDir, [".js", ".mjs", ".cjs", ".d.ts", ".d.mts", ".d.cts"]);
            for (const file of jsAssets) {
                const rel = relative(srcDir, file);
                const dest = join(packageInstallDir, rel);
                await ensureDir(dirname(dest));
                await cp(file, dest);
            }
            if (jsAssets.length > 0) {
                console.log(`  js: ${pkg.distName} (${jsAssets.length} asset files)`);
            }
        }
        }
    } else {
        console.log(`  js: ${pkg.distName} (types-only, skipped)`);
    }

    const tscOut = join(ROOT, "dist-types", pkg.distName);
    if (existsSync(tscOut)) {
        const dtsFiles = await collectFiles(tscOut, [".d.ts", ".d.ts.map"]);
        for (const dts of dtsFiles) {
            const rel = relative(tscOut, dts);
            const dest = join(packageInstallDir, rel);
            await ensureDir(dirname(dest));
            await cp(dts, dest);
        }
        console.log(`  d.ts: ${pkg.distName} (${dtsFiles.length} files)`);
    }

    if (pkg.distName === "openv-core") {
        const skelDir = join(ROOT, pkg.src, "skel");
        if (existsSync(skelDir)) {
            await copySkelFiles(skelDir, packageBuildDir);
            console.log(`  skel: ${pkg.distName} (etc files)`);
        }
    }

    if (pkg.buildUpk && pkg.manifestPath) {
        const manifestSrc = join(ROOT, pkg.manifestPath);
        if (existsSync(manifestSrc)) {
            const manifestDest = join(packageBuildDir, ".manifest");
            const raw = await readFile(manifestSrc, "utf8");
            const manifest = JSON.parse(raw) as Record<string, unknown>;
            manifest.builddate = Math.floor(Date.now() / 1000);
            await writeFile(manifestDest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
            console.log(`  manifest: ${pkg.distName}`);
        }
    }

    if (pkg.distName === "openv-webos") {
        const htmlSrc = join(srcDir, "index.html");
        if (existsSync(htmlSrc)) {
            await cp(htmlSrc, join(packageInstallDir, "index.html"));
            console.log(`  html: ${pkg.distName} (index.html)`);
        }
    }
}

async function createUpkPackage(
    pkg: PackageConfig,
    buildDir: string,
    skelMetaMap: Map<string, Stage0Meta>
): Promise<void> {
    const packageBuildDir = join(buildDir, pkg.distName);
    const tarEntries: TarFileInput[] = [];

    async function walkDir(dir: string, baseDir: string = "") {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relPath = baseDir ? `${baseDir}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                await walkDir(fullPath, relPath);
                continue;
            }

            if (!entry.isFile()) continue;

            const meta = skelMetaMap.get(relPath);
            tarEntries.push({
                name: relPath,
                data: await readFile(fullPath),
                attrs: tarAttrs(meta, DEFAULT_FILE_MODE),
            });
        }
    }

    await walkDir(packageBuildDir);

    const tar = createTar(tarEntries, {
        attrs: {
            uid: ROOT_UID,
            gid: ROOT_GID,
        },
    });

    const gzipped = gzipSync(tar);

    await ensureDir(PACKAGES_DIR);
    const outputPath = join(PACKAGES_DIR, `${pkg.distName}.tar.gz`);
    await writeFile(outputPath, gzipped);

    console.log(`  ${pkg.distName}.tar.gz (${tarEntries.length} files, ${(gzipped.length / 1024).toFixed(1)} KB)`);
}

await ensureDir(DIST);
await rm(PACKAGES_DIR, { recursive: true, force: true });
await ensureDir(PACKAGES_DIR);

const tempBuild = join(ROOT, ".upk-build");
await rm(tempBuild, { recursive: true, force: true });
await ensureDir(tempBuild);

console.log("generating type declarations...");
for (const pkg of PACKAGES) {
    const tsconfig = join(ROOT, pkg.src, "tsconfig.json");
    if (!existsSync(tsconfig)) continue;
    try {
        execSync(`tsc -p .`, { cwd: join(ROOT, pkg.src), stdio: "inherit" });
        console.log(`  types completed for ${pkg.src}`);
    } catch {
        console.warn(`  types for ${pkg.src} errored`);
    }
}

console.log("\nbuilding packages...");
const skelMetaMap = new Map<string, Stage0Meta>();

for (const pkg of PACKAGES) {
    await buildPackage(pkg, tempBuild, skelMetaMap);
}

console.log("\ncreating UPK packages...");
for (const pkg of PACKAGES) {
    if (pkg.buildUpk) {
        await createUpkPackage(pkg, tempBuild, skelMetaMap);
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
    bundle: true,
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: "es2022",
});
console.log("  bootstrap.js");

await cp(join(WEBSERVER, "index.html"), join(DIST, "index.html"));
console.log("  index.html");

// Clean up temp build directory
await rm(tempBuild, { recursive: true, force: true });

console.log("\nBuild complete!");
