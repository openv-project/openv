import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { defineConfig } from 'vite';

function resolveSourceFile(sourcePath: string): string | null {
  if (existsSync(sourcePath)) return sourcePath;
  if (sourcePath.endsWith('.js') || sourcePath.endsWith('.mjs')) {
    const ts = sourcePath.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
    return existsSync(ts) ? ts : null;
  }
  return null;
}

const workerChunkPattern = /(.+)\?importChunkUrl$/;
const workerMap = new Map<string, string>();
let command: 'build' | 'serve' = 'serve';

const importChunkUrl = {
  name: 'importChunkUrl',
  configResolved(config: { command: 'build' | 'serve' }) {
    command = config.command;
  },
  resolveId: {
    order: 'pre' as const,
    async handler(this: any, id: string, importer: string | undefined, options: any) {
      const match = id.match(workerChunkPattern)?.[1];
      if (!importer || !match) return;

      const resolvedPath = resolveSourceFile(resolve(dirname(importer), match));
      if (!resolvedPath) throw new Error(`importChunkUrl: could not resolve "${match}"`);

      if (command === 'build') {
        const refId = this.emitFile({ type: 'chunk', id: resolvedPath, preserveSignature: 'strict' });
        workerMap.set(id, refId);
        return id;
      }
      return this.resolve(`${match}?worker&url`, importer, { skipSelf: true, ...options });
    },
  },
  load(id: string) {
    const refId = workerMap.get(id);
    if (refId) return { code: `export default import.meta.ROLLUP_FILE_URL_${refId};`, moduleType: 'js' };
  },
};

export default defineConfig({
    build: {
        outDir: "../../dist/openv-webos",
        emptyOutDir: true,
    
    },
    plugins: [importChunkUrl],
});