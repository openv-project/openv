import type {
  FileSystemReadOnlyComponent,
  FileSystemReadWriteComponent,
  FileSystemCoreComponent,
  RegistryReadComponent,
} from "@openv-project/openv-api";
import type { CoreOpEnv } from "@openv-project/openv-core";
import type { ScriptEvaluatorComponent } from "@openv-project/openv-core/syscall/script";
import { matchGlob } from "@openv-project/openv-core/util/glob";

const BOOT_REGISTRY_KEY = "/system/party/openv/boot";

async function discoverFilesRecursive(
  system: FileSystemReadOnlyComponent,
  dirPath: string,
  results: string[] = []
): Promise<string[]> {
  try {
    const entries = await system["party.openv.filesystem.read.readdir"](dirPath);
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`.replace(/\/+/g, "/");
      try {
        const stats = await system["party.openv.filesystem.read.stat"](fullPath);
        if (stats.type === "DIRECTORY") {
          await discoverFilesRecursive(system, fullPath, results);
        } else if (stats.type === "FILE") {
          results.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return results;
}

async function discoverBootScripts(
  system: FileSystemReadOnlyComponent,
  patterns: string[]
): Promise<string[]> {
  const allFiles = new Set<string>();

  for (const pattern of patterns) {
    const firstWildcard = pattern.search(/[*?]/);
    let basePath = "/";

    if (firstWildcard !== -1) {
      const lastSlash = pattern.substring(0, firstWildcard).lastIndexOf("/");
      if (lastSlash !== -1) {
        basePath = pattern.substring(0, lastSlash) || "/";
      }
    } else {
      basePath = pattern;
    }

    const files = await discoverFilesRecursive(system, basePath);
    for (const file of files) {
      if (matchGlob(file, pattern)) {
        allFiles.add(file);
      }
    }
  }

  return Array.from(allFiles).sort();
}

export async function runBootScripts(openv: CoreOpEnv): Promise<void> {
  const system = openv.system as FileSystemReadOnlyComponent &
    FileSystemCoreComponent &
    FileSystemReadWriteComponent &
    ScriptEvaluatorComponent &
    RegistryReadComponent;

  let enabled = true;
  let patterns: string[] = ["/boot/**"];
  let stopOnError = false;

  try {
    const enabledValue = await system["party.openv.registry.read.readEntry"](
      BOOT_REGISTRY_KEY,
      "enabled"
    );
    if (enabledValue !== null) enabled = enabledValue as boolean;
  } catch {
    // Use default
  }

  if (!enabled) {
    console.log("Boot: Disabled");
    return;
  }

  try {
    const scriptsValue = await system["party.openv.registry.read.readEntry"](
      BOOT_REGISTRY_KEY,
      "scripts"
    );
    if (scriptsValue !== null) {
      patterns = JSON.parse(scriptsValue as string);
    }
  } catch (err) {
    console.warn("Boot: Failed to read script patterns, using default:", err);
  }

  try {
    const stopValue = await system["party.openv.registry.read.readEntry"](
      BOOT_REGISTRY_KEY,
      "stopOnError"
    );
    if (stopValue !== null) stopOnError = stopValue as boolean;
  } catch {
    // Use default
  }

  console.log("Boot: Discovering scripts:", patterns);

  const scriptPaths = await discoverBootScripts(system, patterns);
  if (scriptPaths.length === 0) {
    console.log("Boot: No scripts found");
    return;
  }

  console.log(`Boot: Found ${scriptPaths.length} script(s)`);

  const errors: Array<{ path: string; error: Error }> = [];

  for (const scriptPath of scriptPaths) {
    try {
      console.log(`Boot: Loading ${scriptPath}`);
      
      const stat = await system["party.openv.filesystem.read.stat"](scriptPath);
      
      const fd = await system["party.openv.filesystem.open"](scriptPath, "r");
      const content = await system["party.openv.filesystem.read.read"](fd, stat.size);
      await system["party.openv.filesystem.close"](fd);
      
      const code = new TextDecoder().decode(content);
      await system["party.openv.script.eval.evaluate"](code);
      console.log(`Boot: ${scriptPath} evaluated successfully`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Boot: ${scriptPath}:`, error.message);
      errors.push({ path: scriptPath, error });

      if (stopOnError) {
        throw new Error(`Boot stopped on error in ${scriptPath}: ${error.message}`);
      }
    }
  }

  if (errors.length > 0) {
    console.warn(`Boot: Completed with ${errors.length}/${scriptPaths.length} error(s)`);
  } else {
    console.log(`Boot: Successfully loaded all ${scriptPaths.length} script(s)`);
  }
}
