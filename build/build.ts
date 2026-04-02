import * as esbuild from "esbuild";
import { readdir, readFile, writeFile, mkdir, cp, rm, chmod, chown, symlink as createSymlink, readlink, lstat } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { importRewriter } from "./import-rewriter.ts";
import filesystemLayout from "../packages/filesystem/layout.json" with { type: "json" };

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

type FilesystemLayoutFile = {
    path: string;
    content: string;
    mode?: number;
};

type FilesystemLayoutSymlink = {
    path: string;
    target: string;
    mode?: number;
};

type FilesystemLayout = {
    name: string;
    version: string;
    directories: string[];
    files: FilesystemLayoutFile[];
    symlinks: FilesystemLayoutSymlink[];
};

type PackageEntrypoint = {
    source: string;
    output: string;
    executable?: boolean;
    sourcemap?: boolean;
    external?: string[];
};

type PackageConfig = {
    src: string;
    installPath: string;
    distName: string;
    typesOnly?: boolean;
    entrypoints?: PackageEntrypoint[];
    copyTypes?: boolean;
    buildUpk?: boolean;
    manifestPath?: string;
    bootstrapSelectable?: boolean;
    bootstrapDefaultSelected?: boolean;
    bootstrapLabel?: string;
};

const DEV_PACKAGE_SUFFIX = "-dev";
const DEV_ARTIFACT_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts", ".d.ts.map", ".map"];

const PACKAGES: PackageConfig[] = [
    {
        src: "packages/base",
        installPath: "/",
        distName: "base",
        buildUpk: true,
        manifestPath: "packages/base/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Base Meta"
    },
    {
        src: "packages/filesystem",
        installPath: "/",
        distName: "filesystem",
        buildUpk: true,
        manifestPath: "packages/filesystem/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Filesystem Layout"
    },
    { 
        src: "packages/openv-core", 
        installPath: "/lib/openv/openv-core", 
        distName: "openv-core",
        buildUpk: true,
        manifestPath: "packages/openv-core/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Base system"
    },
    { 
        src: "packages/openv-api", 
        installPath: "/lib/openv/openv-api", 
        distName: "openv-api", 
        typesOnly: true 
    },
    {
        src: "packages/wasm-runtime",
        installPath: "/",
        distName: "wasm-runtime",
        entrypoints: [
            {
                source: "main.ts",
                output: "/usr/bin/wasm-runtime",
                executable: true,
                sourcemap: false,
                external: ["/@/*"],
            },
        ],
        copyTypes: false,
        buildUpk: true,
        manifestPath: "packages/wasm-runtime/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
    },
    {
        src: "packages/party.openv.api.sync",
        installPath: "/lib/openv/api/sync",
        distName: "party.openv.api.sync",
        buildUpk: true,
        manifestPath: "packages/party.openv.api.sync/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Sync API"
    },
    {
        src: "packages/party.openv.libupk",
        installPath: "/lib/openv/libupk",
        distName: "party.openv.libupk",
        buildUpk: true,
        manifestPath: "packages/party.openv.libupk/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "UPK API"
    },
    { 
        src: "packages/party.openv.api.filesystem", 
        installPath: "/lib/openv/api/fs", 
        distName: "party.openv.api.filesystem",
        buildUpk: true,
        manifestPath: "packages/party.openv.api.filesystem/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Filesystem API"
    },
    { 
        src: "packages/party.openv.api.registry", 
        installPath: "/lib/openv/api/registry", 
        distName: "party.openv.api.registry",
        buildUpk: true,
        manifestPath: "packages/party.openv.api.registry/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Registry API"
    },
    {
        src: "packages/party.openv.api.devfs",
        installPath: "/lib/openv/api/devfs",
        distName: "party.openv.api.devfs",
        buildUpk: true,
        manifestPath: "packages/party.openv.api.devfs/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "DevFS API"
    },
    {
        src: "third_party/libapps/hterm",
        installPath: "/lib/hterm",
        distName: "hterm",
        buildUpk: true,
        manifestPath: "third_party/hterm.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "hterm"
    },
    { 
        src: "packages/openv-webos", 
        installPath: "/srv/openv-webos", 
        distName: "openv-webos",
        buildUpk: true,
        manifestPath: "packages/openv-webos/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "Frontend"
    },
    {
        src: "node_modules/fflate/esm",
        installPath: "/lib/fflate",
        distName: "fflate",
        buildUpk: true,
        manifestPath: "packages/fflate/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "fflate"
    },
    {
        src: "node_modules/nanotar/dist",
        installPath: "/lib/nanotar",
        distName: "nanotar",
        buildUpk: true,
        manifestPath: "packages/nanotar/.manifest",
        bootstrapSelectable: true,
        bootstrapDefaultSelected: true,
        bootstrapLabel: "nanotar"
    },
];

const WEBSERVER = join(ROOT, "packages/openv-webserver");
const LIBAPPS_SUBMODULE_PATH = "third_party/libapps";

async function ensureDir(dir: string) {
    await mkdir(dir, { recursive: true });
}

async function ensureLibappsSubmoduleReady(): Promise<void> {
    const submoduleDir = join(ROOT, LIBAPPS_SUBMODULE_PATH);

    if (!existsSync(submoduleDir) || !existsSync(join(submoduleDir, ".git"))) {
        console.log("ensuring libapps submodule...");
        execSync(`git -C "${ROOT}" submodule update --init --recursive ${LIBAPPS_SUBMODULE_PATH}`, { stdio: "inherit" });
    }

    execSync(`git -C "${ROOT}" submodule update --init --recursive ${LIBAPPS_SUBMODULE_PATH}`, { stdio: "inherit" });

    if (!existsSync(join(submoduleDir, "hterm", "index.js"))) {
        throw new Error("libapps submodule is present but hterm sources are missing");
    }
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

function normalizeLayoutPath(path: string): string {
    const normalized = toPosix(path).replace(/\/+/g, "/");
    const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return withLeadingSlash === "/" ? "/" : withLeadingSlash.replace(/\/+$/, "");
}

function toMtreePath(path: string): string {
    const normalized = normalizeLayoutPath(path);
    return normalized === "/" ? "." : normalized.slice(1);
}

async function buildFilesystemLayoutPackage(packageBuildDir: string): Promise<void> {
    const layout = filesystemLayout as FilesystemLayout;
    const textEncoder = new TextEncoder();

    const dirEntries = new Set<string>();
    const fileEntries = new Map<string, { content: string; mode: number }>();
    const symlinkEntries = new Map<string, { target: string; mode: number }>();

    const addDirectoryChain = (path: string): void => {
        let current = normalizeLayoutPath(path);
        while (current !== "/") {
            dirEntries.add(current);
            const parent = dirname(current);
            if (parent === current) break;
            current = parent === "." ? "/" : normalizeLayoutPath(parent);
        }
    };

    for (const directory of layout.directories) {
        addDirectoryChain(directory);
    }

    for (const file of layout.files) {
        const filePath = normalizeLayoutPath(file.path);
        addDirectoryChain(dirname(filePath));
        fileEntries.set(filePath, {
            content: file.content,
            mode: file.mode ?? DEFAULT_FILE_MODE,
        });
    }

    for (const symlink of layout.symlinks) {
        const linkPath = normalizeLayoutPath(symlink.path);
        addDirectoryChain(dirname(linkPath));
        symlinkEntries.set(linkPath, {
            target: symlink.target,
            mode: symlink.mode ?? 0o777,
        });
    }

    for (const [filePath, file] of fileEntries.entries()) {
        const relPath = filePath.slice(1);
        const outputPath = join(packageBuildDir, relPath);
        await ensureDir(dirname(outputPath));
        await writeFile(outputPath, file.content, "utf8");
        await applyFsAttrs(outputPath, { mode: file.mode, uid: ROOT_UID, gid: ROOT_GID }, DEFAULT_FILE_MODE);
    }

    const mtreeLines = [
        "#mtree",
        "/set uid=0 gid=0",
    ];

    const sortedDirectories = Array.from(dirEntries).sort((a, b) => a.localeCompare(b));
    for (const directory of sortedDirectories) {
        mtreeLines.push(`./${toMtreePath(directory)} type=dir mode=0755`);
    }

    const sortedFiles = Array.from(fileEntries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [filePath, file] of sortedFiles) {
        const size = textEncoder.encode(file.content).byteLength;
        mtreeLines.push(`./${toMtreePath(filePath)} type=file mode=${modeToOctalString(file.mode, DEFAULT_FILE_MODE)} size=${size}`);
    }

    const sortedSymlinks = Array.from(symlinkEntries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [linkPath, symlink] of sortedSymlinks) {
        mtreeLines.push(`./${toMtreePath(linkPath)} type=link mode=${modeToOctalString(symlink.mode, 0o777)} link=${symlink.target}`);
    }

    await writeFile(join(packageBuildDir, ".MTREE"), `${mtreeLines.join("\n")}\n`, "utf8");
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

        const metaEntries = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".meta"))
            .map((entry) => entry.name.slice(0, -5));

        const normalEntries = entries.filter((entry) => !entry.name.endsWith(".meta"));

        for (const basename of metaEntries) {
            const hasTarget = normalEntries.some((entry) => entry.name === basename);
            if (hasTarget) continue;

            const srcPath = join(srcDir, basename);
            const currentRelPath = relPath ? `${relPath}/${basename}` : basename;
            const destPath = join(destDir, currentRelPath);
            const meta = await readMeta(`${srcPath}.meta`);
            if (!meta?.symlink || meta.symlink.length === 0) continue;

            await ensureDir(dirname(destPath));
            await rm(destPath, { force: true });
            await createSymlink(meta.symlink, destPath);
            skelMetaMap.set(currentRelPath, meta);
        }

        for (const entry of normalEntries) {
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
            if (meta?.symlink && meta.symlink.length > 0) {
                await rm(destPath, { force: true });
                await createSymlink(meta.symlink, destPath);
            } else {
                await cp(srcPath, destPath);
                await applyFsAttrs(destPath, meta, DEFAULT_FILE_MODE);
            }

            if (meta) skelMetaMap.set(currentRelPath, meta);
        }
    };

    await copyDir(skelDir);
    return skelMetaMap;
}

async function buildConfiguredEntrypoints(
    pkg: PackageConfig,
    srcDir: string,
    packageBuildDir: string,
): Promise<number> {
    const entrypoints = pkg.entrypoints ?? [];
    for (const entrypoint of entrypoints) {
        const inputPath = join(srcDir, entrypoint.source);
        const outputPath = join(packageBuildDir, entrypoint.output.replace(/^\/+/, ""));
        await ensureDir(dirname(outputPath));

        await esbuild.build({
            entryPoints: [inputPath],
            outfile: outputPath,
            format: "esm",
            bundle: true,
            platform: "browser",
            minify: true,
            sourcemap: entrypoint.sourcemap ?? false,
            target: "es2022",
            external: entrypoint.external ?? [],
        });

        if (entrypoint.executable) {
            await chmod(outputPath, 0o755);
        }
    }
    return entrypoints.length;
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

    await ensureDir(packageBuildDir);
    await ensureDir(packageInstallDir);

    const configuredEntrypointCount = await buildConfiguredEntrypoints(pkg, srcDir, packageBuildDir);

    if (configuredEntrypointCount > 0) {
        console.log(`  js: ${pkg.distName} (${configuredEntrypointCount} configured entr${configuredEntrypointCount === 1 ? "y" : "ies"})`);
    }

    if (!pkg.typesOnly && configuredEntrypointCount === 0) {
        if (pkg.distName === "filesystem") {
            await buildFilesystemLayoutPackage(packageBuildDir);
            console.log(`  layout: ${pkg.distName} (mtree + files)`);
        } else if (pkg.distName === "fflate") {
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
        } else if (pkg.distName === "hterm") {
            const htermRoot = srcDir;
            const libdotRoot = join(ROOT, LIBAPPS_SUBMODULE_PATH, "libdot");
            const libdotBuildRoot = join(packageInstallDir, "libdot");
            const htermPackageJson = JSON.parse(await readFile(join(htermRoot, "package.json"), "utf8")) as { version?: string };
            const htermVersion = htermPackageJson.version ?? "0.0.0";
            const gitCommitHash = execSync(`git -C "${join(ROOT, LIBAPPS_SUBMODULE_PATH)}" rev-parse --short HEAD`, { encoding: "utf8" }).trim();
            const gitDate = execSync(`git -C "${join(ROOT, LIBAPPS_SUBMODULE_PATH)}" show -s --format=%cI HEAD`, { encoding: "utf8" }).trim();
            const punycodeModulePathCandidates = [
                join(ROOT, "node_modules/punycode/punycode.js"),
                join(ROOT, LIBAPPS_SUBMODULE_PATH, "node_modules/punycode/punycode.js"),
            ];
            const punycodeModulePath = punycodeModulePathCandidates.find((candidate) => existsSync(candidate));
            if (!punycodeModulePath) {
                throw new Error("hterm build requires punycode. Install it in root or third_party/libapps node_modules.");
            }

            const packageJsonShimPlugin: esbuild.Plugin = {
                name: "hterm-package-json-shim",
                setup(build) {
                    build.onResolve({ filter: /\.\.\/package\.json$/ }, (args) => ({
                        path: join(args.resolveDir, "../package.json"),
                        namespace: "hterm-pkg-json",
                    }));
                    build.onLoad({ filter: /.*/, namespace: "hterm-pkg-json" }, () => ({
                        contents: [
                            `export const version = ${JSON.stringify(htermVersion)};`,
                            `export const gitCommitHash = ${JSON.stringify(gitCommitHash)};`,
                            `export const gitDate = ${JSON.stringify(gitDate)};`,
                        ].join("\n"),
                        loader: "js",
                    }));
                },
            };
            const punycodeShimPlugin: esbuild.Plugin = {
                name: "hterm-punycode-shim",
                setup(build) {
                    build.onResolve({ filter: /^punycode$/ }, () => ({ path: punycodeModulePath }));
                },
            };
            const htermBuildArtifactAliasPlugin: esbuild.Plugin = {
                name: "hterm-build-artifact-alias",
                setup(build) {
                    build.onResolve({ filter: /^\.\/dist\/js\/libdot_resources\.js$/ }, () => ({
                        path: join(libdotBuildRoot, "dist/js/libdot_resources.js"),
                    }));
                    build.onResolve({ filter: /^\.\/dist\/js\/hterm_resources\.js$/ }, () => ({
                        path: join(packageInstallDir, "dist/js/hterm_resources.js"),
                    }));
                    build.onResolve({ filter: /^\.\/deps_punycode\.rollup\.js$/ }, () => ({
                        path: join(packageInstallDir, "js/deps_punycode.rollup.js"),
                    }));
                },
            };

            await esbuild.build({
                entryPoints: [join(libdotRoot, "js/deps_resources.shim.js")],
                outfile: join(libdotBuildRoot, "dist/js/libdot_resources.js"),
                format: "esm",
                bundle: true,
                platform: "browser",
                target: "es2022",
                minify: true,
                sourcemap: true,
                plugins: [packageJsonShimPlugin],
            });

            await esbuild.build({
                entryPoints: [join(libdotRoot, "index.js")],
                outfile: join(libdotBuildRoot, "dist/js/libdot.js"),
                format: "esm",
                bundle: true,
                platform: "browser",
                target: "es2022",
                minify: true,
                sourcemap: true,
                plugins: [htermBuildArtifactAliasPlugin],
            });

            await esbuild.build({
                entryPoints: [join(htermRoot, "js/deps_resources.shim.js")],
                outfile: join(packageInstallDir, "dist/js/hterm_resources.js"),
                format: "esm",
                bundle: true,
                platform: "browser",
                target: "es2022",
                minify: true,
                sourcemap: true,
                loader: {
                    ".html": "text",
                    ".svg": "text",
                    ".ogg": "dataurl",
                    ".png": "dataurl",
                },
                plugins: [packageJsonShimPlugin],
            });

            await esbuild.build({
                entryPoints: [join(htermRoot, "js/deps_punycode.shim.js")],
                outfile: join(packageInstallDir, "js/deps_punycode.rollup.js"),
                format: "esm",
                bundle: true,
                platform: "browser",
                target: "es2022",
                minify: true,
                sourcemap: true,
                plugins: [punycodeShimPlugin],
            });

            await esbuild.build({
                entryPoints: [join(htermRoot, "index.js")],
                outfile: join(packageInstallDir, "dist/js/hterm.js"),
                format: "esm",
                bundle: true,
                platform: "browser",
                target: "es2022",
                minify: true,
                sourcemap: true,
                plugins: [htermBuildArtifactAliasPlugin],
            });

            const extraFiles: Array<[string, string]> = [
                ["html/hterm.html", "html/hterm.html"],
                ["README.md", "README.md"],
                ["LICENSE", "LICENSE"],
            ];
            for (const [srcRel, destRel] of extraFiles) {
                const srcPath = join(htermRoot, srcRel);
                if (!existsSync(srcPath)) continue;
                const destPath = join(packageInstallDir, destRel);
                await ensureDir(dirname(destPath));
                await cp(srcPath, destPath);
            }
            console.log(`  js: ${pkg.distName} (esbuild standalone bundle)`);
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
    } else if (pkg.typesOnly) {
        console.log(`  js: ${pkg.distName} (types-only, skipped)`);
    }

    const tscOut = join(ROOT, "dist-types", pkg.distName);
    if ((pkg.copyTypes ?? true) && existsSync(tscOut)) {
        const dtsFiles = await collectFiles(tscOut, [".d.ts", ".d.ts.map"]);
        for (const dts of dtsFiles) {
            const rel = relative(tscOut, dts);
            const dest = join(packageInstallDir, rel);
            await ensureDir(dirname(dest));
            await cp(dts, dest);
        }
        console.log(`  d.ts: ${pkg.distName} (${dtsFiles.length} files)`);
    }

    const skelDir = join(ROOT, pkg.src, "skel");
    if (existsSync(skelDir)) {
        await copySkelFiles(skelDir, packageBuildDir);
        console.log(`  skel: ${pkg.distName}`);
        await buildPackageMtree(packageBuildDir);
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

function createDevPackageConfig(pkg: PackageConfig): PackageConfig {
    return {
        src: pkg.src,
        installPath: pkg.installPath,
        distName: `${pkg.distName}${DEV_PACKAGE_SUFFIX}`,
        buildUpk: true,
        bootstrapSelectable: true,
        bootstrapDefaultSelected: false,
        bootstrapLabel: `${pkg.bootstrapLabel ?? pkg.distName} (dev)`,
    };
}

async function splitDevArtifactsIntoCompanionPackage(
    pkg: PackageConfig,
    buildDir: string,
): Promise<PackageConfig | null> {
    if (!pkg.buildUpk || pkg.distName.endsWith(DEV_PACKAGE_SUFFIX)) {
        return null;
    }

    const packageBuildDir = join(buildDir, pkg.distName);
    const installBasePath = pkg.installPath.replace(/^\/+/, "");
    const packageInstallDir = join(packageBuildDir, installBasePath);
    if (!existsSync(packageInstallDir)) {
        return null;
    }

    const devArtifacts = await collectFiles(packageInstallDir, DEV_ARTIFACT_EXTENSIONS);
    if (devArtifacts.length === 0) {
        return null;
    }

    const devPkg = createDevPackageConfig(pkg);
    const devBuildDir = join(buildDir, devPkg.distName);
    const devInstallDir = join(devBuildDir, installBasePath);
    await ensureDir(devBuildDir);
    await ensureDir(devInstallDir);

    for (const artifactPath of devArtifacts) {
        const rel = relative(packageInstallDir, artifactPath);
        const devPath = join(devInstallDir, rel);
        await ensureDir(dirname(devPath));
        await cp(artifactPath, devPath);
        await rm(artifactPath, { force: true });
    }

    const mainManifestPath = join(packageBuildDir, ".manifest");
    if (existsSync(mainManifestPath)) {
        const raw = await readFile(mainManifestPath, "utf8");
        const mainManifest = JSON.parse(raw) as Record<string, unknown>;
        const mainManifestName = typeof mainManifest.name === "string" ? mainManifest.name : pkg.distName;
        const mainDepend = Array.isArray(mainManifest.depend) ? mainManifest.depend : [];
        mainManifest.name = `${mainManifestName}${DEV_PACKAGE_SUFFIX}`;
        if (typeof mainManifest.description === "string") {
            mainManifest.description = `${mainManifest.description} (development artifacts)`;
        }
        mainManifest.depend = [mainManifestName, ...mainDepend].filter((dep, index, deps) => {
            return typeof dep === "string" && deps.indexOf(dep) === index;
        });
        mainManifest.builddate = Math.floor(Date.now() / 1000);
        await writeFile(join(devBuildDir, ".manifest"), `${JSON.stringify(mainManifest, null, 2)}\n`, "utf8");
    }

    await buildPackageMtree(packageBuildDir);
    await buildPackageMtree(devBuildDir);

    console.log(`  dev: ${pkg.distName} -> ${devPkg.distName} (${devArtifacts.length} files)`);
    return devPkg;
}

async function buildPackageMtree(packageBuildDir: string): Promise<void> {
    const textEncoder = new TextEncoder();
    const dirEntries = new Set<string>();
    const fileEntries = new Map<string, number>();
    const symlinkEntries = new Map<string, string>();

    const walkDir = async (dir: string, relPath: string = ""): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === ".manifest" || entry.name === ".MTREE") continue;

            const fullPath = join(dir, entry.name);
            const currentRel = relPath ? `${relPath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                dirEntries.add(currentRel);
                await walkDir(fullPath, currentRel);
            } else if (entry.isSymbolicLink()) {
                const target = await readlink(fullPath, "utf8");
                if (target) symlinkEntries.set(currentRel, target);
            } else if (entry.isFile()) {
                const stat = await readFile(fullPath);
                fileEntries.set(currentRel, stat.length);
            }
        }
    };

    await walkDir(packageBuildDir);

    if (dirEntries.size === 0 && fileEntries.size === 0 && symlinkEntries.size === 0) {
        return;
    }

    const mtreeLines = [
        "#mtree",
        "/set uid=0 gid=0",
    ];

    const sortedDirectories = Array.from(dirEntries).sort((a, b) => a.localeCompare(b));
    for (const directory of sortedDirectories) {
        mtreeLines.push(`./${toMtreePath(directory)} type=dir mode=0755`);
    }

    const sortedFiles = Array.from(fileEntries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [filePath, size] of sortedFiles) {
        mtreeLines.push(`./${toMtreePath(filePath)} type=file mode=${modeToOctalString(DEFAULT_FILE_MODE, DEFAULT_FILE_MODE)} size=${size}`);
    }

    const sortedSymlinks = Array.from(symlinkEntries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [linkPath, target] of sortedSymlinks) {
        mtreeLines.push(`./${toMtreePath(linkPath)} type=link mode=0777 link=${target}`);
    }

    await writeFile(join(packageBuildDir, ".MTREE"), `${mtreeLines.join("\n")}\n`, "utf8");
}

async function createUpkPackage(
    pkg: PackageConfig,
    buildDir: string
): Promise<void> {
    const packageBuildDir = join(buildDir, pkg.distName);
    await ensureDir(PACKAGES_DIR);
    const outputPath = join(PACKAGES_DIR, `${pkg.distName}.tar.gz`);
    execSync(
        [
            `find . -mindepth 1 -maxdepth 1 -printf '%P\\0'`,
            `tar --null --files-from=- --create --gzip --file "${outputPath}" --owner=0 --group=0 --numeric-owner`,
        ].join(" | "),
        { cwd: packageBuildDir, stdio: "inherit" }
    );

    const archiveSize = (await readFile(outputPath)).length;
    console.log(`  ${pkg.distName}.tar.gz (${(archiveSize / 1024).toFixed(1)} KB)`);
}

await ensureDir(DIST);
await rm(PACKAGES_DIR, { recursive: true, force: true });
await ensureDir(PACKAGES_DIR);
await ensureLibappsSubmoduleReady();

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
const builtPackages: PackageConfig[] = [];
const generatedDevPackages: PackageConfig[] = [];

for (const pkg of PACKAGES) {
    await buildPackage(pkg, tempBuild, skelMetaMap);
    builtPackages.push(pkg);
    const devPkg = await splitDevArtifactsIntoCompanionPackage(pkg, tempBuild);
    if (devPkg) {
        generatedDevPackages.push(devPkg);
    }
}

const outputPackages = [...builtPackages, ...generatedDevPackages];

console.log("\ncreating UPK packages...");
for (const pkg of outputPackages) {
    if (pkg.buildUpk) {
        await createUpkPackage(pkg, tempBuild);
    }
}

const bootstrapPackages = outputPackages
    .filter((pkg) => pkg.buildUpk && pkg.bootstrapSelectable !== false)
    .map((pkg) => ({
        path: `/packages/${pkg.distName}.tar.gz`,
        label: pkg.bootstrapLabel ?? pkg.distName,
        defaultSelected: pkg.bootstrapDefaultSelected ?? false,
    }));
await writeFile(join(PACKAGES_DIR, "bootstrap-packages.json"), `${JSON.stringify(bootstrapPackages, null, 2)}\n`, "utf8");
console.log(`  bootstrap-packages.json (${bootstrapPackages.length} entries)`);

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
