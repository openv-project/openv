import type { Plugin } from "esbuild";

const PKG_MAP: Record<string, string> = {
    "@openv-project/openv-api": "/lib/openv/openv-api",
    "@openv-project/openv-core": "/lib/openv/openv-core",
    "@openv-project/api-fs": "/lib/openv/api/fs",
    "@openv-project/api-registry": "/lib/openv/api/registry",
};

export const importRewriter: Plugin = {
    name: "import-rewriter",
    setup(build) {
        build.onResolve({ filter: /^@openv-project\/|^party\.openv\.api\./ }, (args) => {
            const base = PKG_MAP[args.path];
            if (base) return { path: `/@${base}/mod.js`, external: true };
            for (const [pkg, stage0Base] of Object.entries(PKG_MAP)) {
                if (args.path.startsWith(pkg + "/")) {
                    const sub = args.path.slice(pkg.length).replace(/\.ts$/, ".js");
                    const resolved = sub.endsWith(".js") ? sub : sub + ".js";
                    return { path: `/@${stage0Base}${resolved}`, external: true };
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