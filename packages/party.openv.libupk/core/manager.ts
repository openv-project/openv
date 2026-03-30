import type { ContainerAdapter, FileSystemAdapter, LoggingAdapter } from "../types/adapters.js";
import type { InstallOptions, UninstallOptions, VerifyOptions } from "../types/options.js";
import type { InstallResult, UninstallResult, VerifyResult, QueryResult, PackageInfo, BatchInstallResult, BatchInstallPhaseResult } from "../types/package.js";
import type { Manifest } from "../types/manifest.js";
import { parseRelation } from "../types/manifest.js";
import { Database } from "./database.js";
import { Installer } from "./installer.js";
import { Uninstaller } from "./uninstaller.js";
import { Verifier } from "./verifier.js";
import { isAnonymousPackage } from "../types/manifest.js";
import { NoOpLogger } from "../adapters/logging/base.js";

export class PackageManager {
  private containerAdapters: ContainerAdapter[] = [];
  private db: Database;
  private installer: Installer;
  private uninstaller: Uninstaller;
  private verifier: Verifier;

  constructor(
    dbPath: string | null,
    private fs: FileSystemAdapter,
    private rootPath: string = "",
    inMemoryDb: boolean = false
  ) {
    this.db = new Database(dbPath, inMemoryDb ? null : fs, inMemoryDb);
    this.installer = new Installer(this.db, fs, rootPath);
    this.uninstaller = new Uninstaller(this.db, fs, rootPath);
    this.verifier = new Verifier(this.db, fs, rootPath);
  }

  registerContainerAdapter(adapter: ContainerAdapter): void {
    this.containerAdapters.push(adapter);
  }

  async initialize(): Promise<void> {
    await this.db.load();
  }

  async install(source: string | Uint8Array, options: InstallOptions = {}): Promise<InstallResult> {
    const logger = options.logger || new NoOpLogger();

    try {
      const adapter = await this.selectAdapter(source);
      if (!adapter) {
        throw new Error("No suitable container adapter found for package source");
      }

      logger.debug(`Using container adapter: ${adapter.name}`);

      const handle = await adapter.open(source);
      try {
        const manifest = await handle.getManifest();
        
        let packageName: string;
        let isAnonymous = false;

        if (isAnonymousPackage(manifest)) {
          logger.info("Package is anonymous, generating hash-based name");
          const hash = await adapter.generateHash(source);
          packageName = `anon-${hash.substring(0, 16)}`;
          isAnonymous = true;
        } else {
          packageName = manifest!.name!;
        }

        const effectiveManifest: Manifest = manifest || {
          name: packageName,
          version: "unknown",
        };

        const isUpgrade = this.db.isInstalled(packageName);

        const packageInfo = await this.installer.install(
          handle,
          effectiveManifest,
          packageName,
          options
        );

        return {
          packageName,
          isAnonymous,
          filesInstalled: packageInfo.files.length,
          status: isUpgrade ? "upgraded" : "installed",
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      logger.error(`Installation failed: ${error}`);
      return {
        packageName: "unknown",
        isAnonymous: false,
        filesInstalled: 0,
        status: "failed",
        message: String(error),
      };
    }
  }

  async installBatch(
    sources: Array<string | Uint8Array>,
    options: InstallOptions = {}
  ): Promise<BatchInstallResult> {
    const logger = options.logger || new NoOpLogger();
    if (sources.length === 0) {
      return { phases: [], results: [] };
    }
    logger.info(`Preparing batch install for ${sources.length} package(s).`);

    const prepared = await Promise.all(sources.map(async (source, index) => {
      const adapter = await this.selectAdapter(source);
      if (!adapter) {
        throw new Error(`No suitable container adapter found for package source at index ${index}`);
      }
      const handle = await adapter.open(source);
      try {
        const manifest = await handle.getManifest();
        if (!manifest?.name || manifest.name.trim().length === 0) {
          throw new Error(`Batch install requires named manifests; package at index ${index} is anonymous.`);
        }
        const packageName = manifest.name.trim();
        const depends = (manifest.depend ?? []).map((relation) => parseRelation(relation).target.trim()).filter(Boolean);
        const provides = new Set<string>([
          packageName,
          ...(manifest.provides ?? []).map((relation) => parseRelation(relation).target.trim()).filter(Boolean),
        ]);
        logger.debug(`Prepared package ${packageName} (depends: ${depends.length}, provides: ${provides.size})`);
        return { index, source, packageName, depends, provides };
      } finally {
        await handle.close();
      }
    }));
    logger.info("Resolved package manifests for batch install.");

    const byName = new Map<string, typeof prepared[number]>();
    for (const entry of prepared) {
      if (byName.has(entry.packageName)) {
        throw new Error(`Duplicate package in batch selection: ${entry.packageName}`);
      }
      byName.set(entry.packageName, entry);
    }

    const installedProvides = new Set<string>();
    for (const installed of this.db.listPackages()) {
      if (installed.name) installedProvides.add(installed.name);
      for (const relation of installed.manifest.provides ?? []) {
        installedProvides.add(parseRelation(relation).target.trim());
      }
    }

    const selectedProviders = new Map<string, Set<string>>();
    for (const entry of prepared) {
      for (const provided of entry.provides) {
        if (!selectedProviders.has(provided)) selectedProviders.set(provided, new Set<string>());
        selectedProviders.get(provided)!.add(entry.packageName);
      }
    }

    const pendingDeps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const entry of prepared) {
      const localDeps = new Set<string>();
      for (const dep of entry.depends) {
        const providers = selectedProviders.get(dep);
        if (providers && providers.size > 0) {
          if (providers.size > 1) {
            throw new Error(`Ambiguous dependency for ${entry.packageName}: ${dep} is provided by multiple selected packages (${Array.from(providers).sort((a, b) => a.localeCompare(b)).join(", ")}).`);
          }
          const provider = Array.from(providers)[0]!;
          if (provider !== entry.packageName) {
            localDeps.add(provider);
          }
          continue;
        }
        if (installedProvides.has(dep)) {
          continue;
        }
        throw new Error(`Unresolved dependency for ${entry.packageName}: ${dep} is not installed and not in selected package set.`);
      }
      pendingDeps.set(entry.packageName, localDeps);
      logger.debug(`Dependency edges for ${entry.packageName}: ${Array.from(localDeps).sort((a, b) => a.localeCompare(b)).join(", ") || "(none)"}`);
      for (const dep of localDeps) {
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep)!.add(entry.packageName);
      }
    }

    const dependsOnBase = new Set<string>();
    if (byName.has("base")) {
      const queue = ["base"];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (dependsOnBase.has(current)) continue;
        dependsOnBase.add(current);
        const deps = pendingDeps.get(current);
        if (!deps) continue;
        for (const dep of deps) {
          queue.push(dep);
        }
      }

      for (const entry of prepared) {
        if (entry.packageName === "base") continue;
        if (dependsOnBase.has(entry.packageName)) continue;
        const localDeps = pendingDeps.get(entry.packageName)!;
        localDeps.add("base");
        if (!dependents.has("base")) dependents.set("base", new Set());
        dependents.get("base")!.add(entry.packageName);
      }
    }

    const phaseNames: string[][] = [];
    const done = new Set<string>();
    while (done.size < prepared.length) {
      let ready = prepared
        .map((e) => e.packageName)
        .filter((name) => !done.has(name) && (pendingDeps.get(name)?.size ?? 0) === 0)
        .sort((a, b) => a.localeCompare(b));

      if (ready.length === 0) {
        const blocked = prepared
          .map((e) => e.packageName)
          .filter((name) => !done.has(name))
          .sort((a, b) => a.localeCompare(b));
        throw new Error(`Dependency cycle or unresolved graph in batch install: ${blocked.join(", ")}`);
      }

      // Hardcoded bootstrap policy: when selected, "base" must install first.
      if (!done.has("base") && ready.includes("base")) {
        ready = ["base"];
      }

      phaseNames.push(ready);
      logger.info(`Planned phase ${phaseNames.length}: ${ready.join(", ")}`);
      for (const name of ready) {
        done.add(name);
        const ds = dependents.get(name);
        if (!ds) continue;
        for (const dependent of ds) {
          pendingDeps.get(dependent)?.delete(name);
        }
      }
    }

    const phases: BatchInstallPhaseResult[] = [];
    const results: InstallResult[] = [];
    const wait = async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    };
    const waitForPath = async (path: string, attempts: number, delayMs: number): Promise<void> => {
      let lastError: unknown = null;
      for (let i = 0; i < attempts; i++) {
        try {
          await this.fs.stat(path);
          return;
        } catch (error) {
          lastError = error;
          if (i < attempts - 1) {
            await wait(delayMs);
          }
        }
      }
      throw new Error(`Filesystem path did not become ready: ${path} (${String(lastError)})`);
    };

    for (let i = 0; i < phaseNames.length; i++) {
      const phase = phaseNames[i];
      logger.info(`Batch install phase ${i + 1}/${phaseNames.length}: ${phase.join(", ")}`);
      const phaseResults = await Promise.all(
        phase.map(async (packageName) => {
          const entry = byName.get(packageName)!;
          logger.info(`Installing package ${packageName} (parallel mode)`);
          return this.install(entry.source, options);
        })
      );
      const failed = phaseResults.find((result) => result.status === "failed");
      if (failed) {
        throw new Error(failed.message ?? `Batch install failed during phase ${i + 1}`);
      }
      if (phase.includes("filesystem")) {
        logger.info("Waiting for filesystem symlink readiness (/usr/lib, /lib).");
        await waitForPath("/usr/lib", 20, 25);
        await waitForPath("/lib", 20, 25);
      }
      phases.push({ packages: phase, results: phaseResults });
      results.push(...phaseResults);
    }

    return { phases, results };
  }

  async uninstall(packageName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    return await this.uninstaller.uninstall(packageName, options);
  }

  async verify(packageName: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    return await this.verifier.verify(packageName, options);
  }

  async query(packageName: string): Promise<QueryResult> {
    const pkg = this.db.getPackage(packageName);
    return {
      found: pkg !== null,
      package: pkg || undefined,
    };
  }

  async list(options: { includeAnonymous?: boolean } = {}): Promise<PackageInfo[]> {
    return this.db.listPackages(
      options.includeAnonymous === false ? false : undefined
    );
  }

  private async selectAdapter(source: string | Uint8Array): Promise<ContainerAdapter | null> {
    for (const adapter of this.containerAdapters) {
      if (await adapter.supports(source)) {
        return adapter;
      }
    }
    return null;
  }

  getDatabase(): Database {
    return this.db;
  }
}
