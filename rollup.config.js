import { readdir, readFile } from "fs/promises";
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';

export default (async () => {
    const configs = [];
    const defaultConfig = {
        input: "mod.ts",
        output: {
            format: "es",
        }
    }

    for await (const file of await readdir("./packages")) {
        console.log(`Loading package info for ${file}...`);
        try {
            const packageJson = await readFile(`./packages/${file}/package.json`, "utf-8");
            const packageConfig = JSON.parse(packageJson);
            const userRollupOptions = packageConfig.rollupOptions || {};
            
            // Use user-provided input, or fall back to default "mod.ts"
            const inputFile = userRollupOptions.input || defaultConfig.input;
            const outputDir = `dist/${file}`;
            
            const rollupOptions = Object.assign(
                {},
                defaultConfig,
                userRollupOptions,
                {
                    input: `./packages/${file}/${inputFile}`,
                    output: {
                        format: "es",
                        dir: outputDir,
                        entryFileNames: "[name].js"
                    },
                    external: (id) => {
                        // Keep other workspace packages as external, but bundle openv-api
                        if (id === '@openv-project/openv-api') return false;
                        if (id.startsWith('@openv-project/')) return true;
                        return false;
                    },
                    plugins: [
                        typescript({
                            tsconfig: `./packages/${file}/tsconfig.json`,
                            declaration: false,
                            declarationMap: false
                        }),
                        resolve({
                            preferBuiltins: false
                        })
                    ]
                }
            );
            configs.push(rollupOptions);
        } catch (e) {
            console.warn(`Failed to load package info for ${file}: ${e}`);
        }
    }

    return configs;
})();