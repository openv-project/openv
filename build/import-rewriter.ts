import type { Plugin } from "esbuild";

interface PackageConfig {
    path: string;
    defaultExport?: string; // defaults to "mod.js" if not specified
}

const PKG_MAP: Record<string, PackageConfig> = {
    "@openv-project/openv-api": { path: "/lib/openv/openv-api" },
    "@openv-project/openv-core": { path: "/lib/openv/openv-core" },
    "@openv-project/api-fs": { path: "/lib/openv/api/fs" },
    "@openv-project/api-registry": { path: "/lib/openv/api/registry" },
    "@remote-dom/core": { path: "/lib/remote-dom/core", defaultExport: "index.js" },
    "@remote-dom/polyfill": { path: "/lib/remote-dom/polyfill", defaultExport: "index.js" },
};

export const importRewriter: Plugin = {
    name: "import-rewriter",
    setup(build) {
        const pkgNames = Object.keys(PKG_MAP).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const filter = new RegExp(`^(${pkgNames})|^party\\.openv\\.api\\.`);
        
        build.onResolve({ filter }, (args) => {
            const config = PKG_MAP[args.path];
            if (config) {
                const defaultExport = config.defaultExport || "mod.js";
                return { path: `/@${config.path}/${defaultExport}`, external: true };
            }
            for (const [pkg, config] of Object.entries(PKG_MAP)) {
                if (args.path.startsWith(pkg + "/")) {
                    const sub = args.path.slice(pkg.length).replace(/\.ts$/, ".js");
                    const resolved = sub.endsWith(".js") ? sub : sub + ".js";
                    return { path: `/@${config.path}${resolved}`, external: true };
                }
            }
            throw new Error(`[import-rewriter] Unknown package: ${args.path}`);
        });

        build.onResolve({ filter: /\.ts$/ }, (args) => {
            if (args.kind === "entry-point") return null;
            return { path: args.path.replace(/\.ts$/, ".js"), external: true };
        });
    }
};