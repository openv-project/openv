import type { FileSystemCoreComponent, FileSystemReadOnlyComponent, PROCESS_BINFMT_NAMESPACE, PROCESS_BINFMT_NAMESPACE_VERSIONED, PROCESS_LOCAL_NAMESPACE, PROCESS_LOCAL_NAMESPACE_VERSIONED, PROCESS_NAMESPACE, PROCESS_NAMESPACE_VERSIONED, PROCESS_SIGNAL_NOTIFYEXIT, SystemComponent, ProcessBinfmtComponent, ProcessBinfmtMatchResult, ProcessBinfmtRule, ProcessComponent, ProcessExecutorInfo, ProcessLocalComponent, ProcessSpawnOptions, SpawnStdioResult, StdioOption } from "@openv-project/openv-api";
import type { CoreFSExt } from "../fs.ts";

type SignalHandler = (cx: { signal: string; uid: number; gid: number; pid: number }) => Promise<void>;

interface ProcessEntry {
    pid: number;
    ppid: number;
    uid: number;
    gid: number;
    cwd: string;
    exe: string;
    args: string[];
    env: Record<string, string>;
    stdioOfds?: [stdinOfd?: number, stdoutOfd?: number, stderrOfd?: number];
    waiters: Array<(code: number | null) => void>;
    running: boolean;
    exitCode: number | null;
    signalHandlers: Map<string, SignalHandler>;
    executorId: string | null;
    executorClass: string | null;
}

export interface ProcessSpawnContext {
    pid: number;
    ppid: number;
    uid: number;
    gid: number;
    cwd: string;
    exe: string;
    args: string[];
    env: Record<string, string>;
    /**
     * The global OFDs that should be injected into this process's fd table as
     * fds 0 (stdin), 1 (stdout), 2 (stderr). Each entry is present only when
     * the corresponding stdio slot was wired (pipe, inherit, or explicit fd).
     */
    stdioOfds?: [stdinOfd?: number, stdoutOfd?: number, stderrOfd?: number];
}

export interface ProcessExecutor {
    run(ctx: ProcessSpawnContext): Promise<void>;
    destroy(pid: number): Promise<void>;
}

export interface ProcessExecutorDescriptor {
    id: string;
    class: string;
}

type RegisteredExecutor = {
    descriptor: ProcessExecutorDescriptor;
    handler: (ctx: ProcessSpawnContext) => Promise<void>;
    ping?: () => Promise<boolean>;
    ready: boolean;
    lastPingAt: number | null;
    failureCount: number;
};

type PendingSpawn = {
    ctx: ProcessSpawnContext;
    selector: { id?: string; class?: string };
};

const CORE_PROCESS_EXT_NAMESPACE = "party.openv.impl.process" as const;
const CORE_PROCESS_EXT_NAMESPACE_VERSIONED = "party.openv.impl.process/0.1.0" as const;

export interface CoreProcessExt extends SystemComponent<typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED, typeof CORE_PROCESS_EXT_NAMESPACE> {
    ["party.openv.impl.process.onSpawn"](handler: (ctx: ProcessSpawnContext) => Promise<void>): Promise<void>;
    ["party.openv.impl.process.registerExecutor"](descriptor: ProcessExecutorDescriptor, handler: (ctx: ProcessSpawnContext) => Promise<void>, ping?: () => Promise<boolean>): Promise<void>;
    ["party.openv.impl.process.unregisterExecutor"](id: string): Promise<void>;
    ["party.openv.impl.process.pingExecutor"](id: string): Promise<boolean>;
    ["party.openv.impl.process.pingExecutors"](): Promise<ProcessExecutorInfo[]>;
    ["party.openv.impl.process.cleanupExecutors"](): Promise<number>;
    ["party.openv.impl.process.exitProcess"](pid: number, code: number | null): Promise<void>;
    ["party.openv.impl.process.deliverSignal"](senderPid: number, targetPid: number, signal: string): Promise<void>;
    ["party.openv.impl.process.getEntry"](pid: number): Promise<ProcessEntry>;
}


export class CoreProcess implements ProcessComponent, ProcessBinfmtComponent, CoreProcessExt {
    #pidCounter = 0;
    #processTable: Map<number, ProcessEntry> = new Map();
    #fsExt: (CoreFSExt & FileSystemCoreComponent & FileSystemReadOnlyComponent) | null = null;
    #stdioResults: Map<number, SpawnStdioResult> = new Map();
    #executors: Map<string, RegisteredExecutor> = new Map();
    #spawnQueue: PendingSpawn[] = [];
    #binfmtRules: Map<string, ProcessBinfmtRule> = new Map();

    setFsExt(fsExt: CoreFSExt & FileSystemCoreComponent & FileSystemReadOnlyComponent): void {
        this.#fsExt = fsExt;
    }

    #validateBinfmtRule(rule: ProcessBinfmtRule): ProcessBinfmtRule {
        if (!rule.name || rule.name.includes("/")) {
            throw new Error(`EINVAL: invalid binfmt rule name '${rule.name}'`);
        }
        if (!rule.interpreter || !rule.interpreter.startsWith("/")) {
            throw new Error(`EINVAL: interpreter must be an absolute path`);
        }
        if (rule.type !== "magic" && rule.type !== "extension") {
            throw new Error(`EINVAL: unsupported binfmt type '${(rule as any).type}'`);
        }
        const normalized: ProcessBinfmtRule = {
            ...rule,
            enabled: rule.enabled ?? true,
            priority: rule.priority ?? 0,
            flags: {
                preserveArgv0: !!rule.flags?.preserveArgv0,
                openBinary: !!rule.flags?.openBinary,
            },
        };

        if (normalized.type === "extension") {
            if (!normalized.extension || normalized.extension.includes("/") || normalized.extension.includes(".")) {
                throw new Error(`EINVAL: extension rule requires extension without '.' or '/'`);
            }
        } else {
            if (!normalized.magic || normalized.magic.length === 0) {
                throw new Error(`EINVAL: magic rule requires non-empty magic bytes`);
            }
            const offset = normalized.offset ?? 0;
            if (offset < 0) {
                throw new Error(`EINVAL: magic rule offset must be >= 0`);
            }
            normalized.offset = offset;
            if (normalized.mask && normalized.mask.length !== normalized.magic.length) {
                throw new Error(`EINVAL: mask length must equal magic length`);
            }
        }
        return normalized;
    }

    async ["party.openv.process.binfmt.register"](rule: ProcessBinfmtRule): Promise<void> {
        const normalized = this.#validateBinfmtRule(rule);
        this.#binfmtRules.set(normalized.name, normalized);
    }

    async ["party.openv.process.binfmt.unregister"](name: string): Promise<void> {
        this.#binfmtRules.delete(name);
    }

    async ["party.openv.process.binfmt.list"](): Promise<ProcessBinfmtRule[]> {
        return Array.from(this.#binfmtRules.values())
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
            .map((rule) => ({
                ...rule,
                magic: rule.magic ? new Uint8Array(rule.magic) : undefined,
                mask: rule.mask ? new Uint8Array(rule.mask) : undefined,
            }));
    }

    #extensionOf(path: string): string {
        const base = path.split("/").pop() ?? path;
        const dot = base.lastIndexOf(".");
        if (dot <= 0 || dot === base.length - 1) return "";
        return base.slice(dot + 1);
    }

    #applyMagicMask(source: Uint8Array, mask?: Uint8Array): Uint8Array {
        if (!mask) return source;
        const out = new Uint8Array(source.length);
        for (let i = 0; i < source.length; i++) {
            out[i] = source[i] & mask[i];
        }
        return out;
    }

    async ["party.openv.process.binfmt.resolve"](command: string, args: string[] = [command]): Promise<ProcessBinfmtMatchResult | null> {
        const sortedRules = Array.from(this.#binfmtRules.values())
            .filter((r) => r.enabled !== false)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

        let filePrefix: Uint8Array | null = null;
        const maxReadLength = sortedRules
            .filter((r) => r.type === "magic" && r.magic)
            .reduce((max, r) => Math.max(max, (r.offset ?? 0) + (r.magic?.length ?? 0)), 0);

        for (const rule of sortedRules) {
            if (rule.type === "extension") {
                if (this.#extensionOf(command) !== rule.extension) continue;
            } else {
                const magic = rule.magic!;
                const offset = rule.offset ?? 0;
                if (maxReadLength <= 0) continue;
                if (filePrefix === null) {
                    if (!this.#fsExt) continue;
                    let ofd: number | null = null;
                    try {
                        ofd = await this.#fsExt["party.openv.filesystem.open"](command, "r", 0o444);
                        filePrefix = await this.#fsExt["party.openv.filesystem.read.read"](ofd, maxReadLength, 0);
                    } catch {
                        filePrefix = new Uint8Array(0);
                    } finally {
                        if (ofd !== null) {
                            await this.#fsExt["party.openv.filesystem.close"](ofd).catch(() => { });
                        }
                    }
                }
                if ((offset + magic.length) > filePrefix.length) continue;
                const chunk = filePrefix.subarray(offset, offset + magic.length);
                const lhs = this.#applyMagicMask(chunk, rule.mask);
                const rhs = this.#applyMagicMask(magic, rule.mask);
                let matches = true;
                for (let i = 0; i < rhs.length; i++) {
                    if (lhs[i] !== rhs[i]) {
                        matches = false;
                        break;
                    }
                }
                if (!matches) continue;
            }

            const originalArgv0 = args[0] ?? command;
            const rewrittenArgs = [rule.interpreter];
            if (rule.flags?.preserveArgv0) {
                rewrittenArgs.push(command, originalArgv0, ...args.slice(1));
            } else {
                rewrittenArgs.push(command, ...args.slice(1));
            }
            return {
                ruleName: rule.name,
                interpreter: rule.interpreter,
                argv: rewrittenArgs,
                originalExe: command,
            };
        }
        return null;
    }

    async ["party.openv.impl.process.onSpawn"](handler: (ctx: ProcessSpawnContext) => Promise<void>): Promise<void> {
        await this["party.openv.impl.process.registerExecutor"](
            { id: "legacy.onSpawn", class: "party.openv.executor.legacy" },
            handler
        );
    }

    async ["party.openv.impl.process.registerExecutor"](
        descriptor: ProcessExecutorDescriptor,
        handler: (ctx: ProcessSpawnContext) => Promise<void>,
        ping?: () => Promise<boolean>
    ): Promise<void> {
        if (!descriptor.id || !descriptor.class) {
            throw new Error("Executor descriptor requires non-empty id and class.");
        }

        this.#executors.set(descriptor.id, {
            descriptor,
            handler,
            ping,
            ready: true,
            lastPingAt: null,
            failureCount: 0,
        });

        await this.#drainSpawnQueue();
    }

    async ["party.openv.impl.process.unregisterExecutor"](id: string): Promise<void> {
        this.#executors.delete(id);
    }

    async ["party.openv.impl.process.pingExecutor"](id: string): Promise<boolean> {
        const executor = this.#executors.get(id);
        if (!executor) return false;

        if (!executor.ping) {
            executor.ready = true;
            executor.lastPingAt = Date.now();
            return true;
        }

        try {
            const ok = await executor.ping();
            executor.ready = !!ok;
            executor.lastPingAt = Date.now();
            if (ok) executor.failureCount = 0;
            else executor.failureCount++;
            return !!ok;
        } catch {
            executor.ready = false;
            executor.failureCount++;
            executor.lastPingAt = Date.now();
            return false;
        }
    }

    async ["party.openv.impl.process.pingExecutors"](): Promise<ProcessExecutorInfo[]> {
        await Promise.all(Array.from(this.#executors.keys()).map((id) => this["party.openv.impl.process.pingExecutor"](id)));
        await this.#drainSpawnQueue();
        return this["party.openv.process.listExecutors"]();
    }

    async ["party.openv.impl.process.cleanupExecutors"](): Promise<number> {
        const toRemove = Array.from(this.#executors.values())
            .filter((executor) => !executor.ready)
            .map((executor) => executor.descriptor.id);

        for (const id of toRemove) {
            this.#executors.delete(id);
            for (const entry of this.#processTable.values()) {
                if (!entry.running) continue;
                if (entry.executorId !== id) continue;
                entry.executorId = null;
                entry.executorClass = null;
                await this["party.openv.impl.process.exitProcess"](entry.pid, null);
            }
        }

        return toRemove.length;
    }

    async ["party.openv.process.spawn"](
        command: string,
        args?: string[],
        options?: ProcessSpawnOptions
    ): Promise<number> {
        if (options?.cwd === undefined || options?.env === undefined) {
            throw new Error("cwd and env are mandatory when spawning from the system environment.");
        }

        const requestedArgs = args ?? [command];
        const binfmt = await this["party.openv.process.binfmt.resolve"](command, requestedArgs);
        const resolvedCommand = binfmt?.interpreter ?? command;
        let resolvedArgs = binfmt?.argv ?? requestedArgs;
        let openBinaryOfd: number | null = null;

        if (binfmt) {
            const matchedRule = this.#binfmtRules.get(binfmt.ruleName);
            if (matchedRule?.flags?.openBinary) {
                if (!this.#fsExt) {
                    throw new Error("ENOTSUP: binfmt openBinary requires filesystem support.");
                }
                const childUid = options.uid ?? 0;
                openBinaryOfd = await this.#fsExt["party.openv.filesystem.open"](command, "r", 0o444);
                await this.#fsExt["party.openv.impl.filesystem.setOfdOwner"](openBinaryOfd, childUid);
                resolvedArgs = [...resolvedArgs];
                if (resolvedArgs.length > 1) {
                    resolvedArgs[1] = String(openBinaryOfd);
                } else {
                    resolvedArgs.push(String(openBinaryOfd));
                }
            }
        }

        const stdioSpec = options.stdio;
        const stdioOfds: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
        const stdioResult: SpawnStdioResult = {};
        const parentEntry = options.ppid ? this.#processTable.get(options.ppid) : undefined;
        const parentStdioOfds = parentEntry?.stdioOfds;

        if (this.#fsExt) {
            for (let i = 0; i < 3; i++) {
                const opt = stdioSpec?.[i];
                if (opt === "pipe") {
                    const [readOfd, writeOfd] = await this.#fsExt["party.openv.impl.filesystem.createPipeOfd"]();
                    if (i === 0) {
                        stdioOfds[i] = readOfd;
                        stdioResult.stdin = writeOfd;
                    } else {
                        stdioOfds[i] = writeOfd;
                        if (i === 1) stdioResult.stdout = readOfd;
                        else stdioResult.stderr = readOfd;
                    }
                } else if (typeof opt === "number") {
                    stdioOfds[i] = opt;
                } else {
                    // Process-local default semantics: undefined/null means "inherit".
                    const shouldInherit = opt === "inherit" || (opt == null && options.ppid !== undefined && options.ppid !== 0);
                    if (shouldInherit && parentStdioOfds) {
                        stdioOfds[i] = parentStdioOfds[i];
                    }
                }
            }
        }

        const pid = this.#allocatePid({
            ppid: options.ppid ?? 0,
            uid: options.uid ?? 0,
            gid: options.gid ?? 0,
            cwd: options.cwd,
            exe: resolvedCommand,
            args: resolvedArgs,
            env: options.env,
            stdioOfds,
        });

        if (
            stdioResult.stdin !== undefined ||
            stdioResult.stdout !== undefined ||
            stdioResult.stderr !== undefined
        ) {
            this.#stdioResults.set(pid, stdioResult);
        }

        const entry = this.#getEntry(pid);
        const ctx: ProcessSpawnContext = { ...entry, env: { ...entry.env }, stdioOfds };
        const selector = { id: options?.id, class: options?.class };

        if (selector.id && !this.#executors.has(selector.id)) {
            this.#processTable.delete(pid);
            this.#stdioResults.delete(pid);
            if (openBinaryOfd !== null && this.#fsExt) {
                await this.#fsExt["party.openv.filesystem.close"](openBinaryOfd).catch(() => { });
            }
            throw new Error(`No executor registered with id ${selector.id}.`);
        }

        const dispatched = await this.#dispatchSpawn(ctx, selector);
        if (!dispatched) {
            this.#spawnQueue.push({ ctx, selector });
        }

        return pid;
    }

    async ["party.openv.process.getstdio"](pid: number): Promise<SpawnStdioResult> {
        return this.#stdioResults.get(pid) ?? {};
    }

    async ["party.openv.process.pingExecutor"](id: string): Promise<boolean> {
        return this["party.openv.impl.process.pingExecutor"](id);
    }

    async ["party.openv.process.listExecutors"](): Promise<ProcessExecutorInfo[]> {
        return Array.from(this.#executors.values()).map((executor) => this.#toExecutorInfo(executor));
    }

    async ["party.openv.process.getExecutorById"](id: string): Promise<ProcessExecutorInfo | null> {
        const executor = this.#executors.get(id);
        if (!executor) return null;
        return this.#toExecutorInfo(executor);
    }

    async ["party.openv.process.getExecutorByPid"](pid: number): Promise<ProcessExecutorInfo | null> {
        const entry = this.#getEntry(pid);
        if (!entry.executorId) return null;
        return this["party.openv.process.getExecutorById"](entry.executorId);
    }

    async ["party.openv.process.kill"](pid: number): Promise<void> {
        const entry = this.#getEntry(pid);
        if (!entry.running) return;
        await this["party.openv.impl.process.exitProcess"](pid, null);
    }

    async ["party.openv.process.signal"](pid: number, signal: string): Promise<void> {
        if (pid === 0) return;
        await this["party.openv.impl.process.deliverSignal"](0, pid, signal);
    }

    async ["party.openv.process.wait"](pid: number): Promise<number | null> {
        const entry = this.#getEntry(pid);
        if (!entry.running) return entry.exitCode;
        return new Promise<number | null>((resolve) => {
            entry.waiters.push(resolve);
        });
    }

    async ["party.openv.process.list"](): Promise<Array<{ pid: number; ppid: number }>> {
        return Array.from(this.#processTable.values())
            .filter((e) => e.running)
            .map(({ pid, ppid }) => ({ pid, ppid }));
    }

    async ["party.openv.process.getppid"](pid: number): Promise<number> {
        return this.#getEntry(pid).ppid;
    }

    async ["party.openv.process.getuid"](pid: number): Promise<number> {
        return this.#getEntry(pid).uid;
    }

    async ["party.openv.process.getgid"](pid: number): Promise<number> {
        return this.#getEntry(pid).gid;
    }

    async ["party.openv.process.getcwd"](pid: number): Promise<string> {
        return this.#getEntry(pid).cwd;
    }

    async ["party.openv.process.getargs"](pid: number): Promise<string[]> {
        return this.#getEntry(pid).args;
    }

    async ["party.openv.process.getexe"](pid: number): Promise<string> {
        return this.#getEntry(pid).exe;
    }

    async ["party.openv.process.getenv"](pid: number, name: string): Promise<string | null> {
        return this.#getEntry(pid).env[name] ?? null;
    }

    async ["party.openv.process.listenv"](pid: number): Promise<string[]> {
        return Object.keys(this.#getEntry(pid).env);
    }

    async ["party.openv.process.getstats"](pid: number): Promise<{
        ppid: number; uid: number; gid: number; cwd: string; args: string[]; exe: string; env: Record<string, string>;
    }> {
        const { ppid, uid, gid, cwd, args, exe, env } = this.#getEntry(pid);
        return { ppid, uid, gid, cwd, args, exe, env: { ...env } };
    }

    async ["party.openv.impl.process.exitProcess"](pid: number, code: number | null): Promise<void> {
        const entry = this.#processTable.get(pid);
        if (!entry) return;
        entry.running = false;
        entry.exitCode = code;
        for (const resolve of entry.waiters) {
            resolve(code);
        }
        entry.waiters = [];
    }

    async ["party.openv.impl.process.deliverSignal"](senderPid: number, targetPid: number, signal: string): Promise<void> {
        if (targetPid === 0) {
            if (signal === "party.openv.process.signals.notifyexit") {
                const entry = this.#processTable.get(senderPid);
                if (entry) {
                    entry.running = false;
                    for (const resolve of entry.waiters) {
                        resolve(entry.exitCode);
                    }
                    entry.waiters = [];
                    this.#processTable.delete(senderPid);
                    this.#stdioResults.delete(senderPid);
                }
            }
            return;
        }

        const entry = this.#getEntry(targetPid);
        if (!entry.running) {
            throw new Error(`Process ${targetPid} is not running.`);
        }

        const handler = entry.signalHandlers.get(signal);
        if (handler) {
            const sender = this.#processTable.get(senderPid);
            await handler({
                signal,
                uid: sender?.uid ?? 0,
                gid: sender?.gid ?? 0,
                pid: senderPid,
            });
        }
    }

    async ["party.openv.impl.process.getEntry"](pid: number): Promise<ProcessEntry> {
        return this.#getEntry(pid);
    }

    async #drainSpawnQueue(): Promise<void> {
        if (this.#spawnQueue.length === 0) return;
        const pending = this.#spawnQueue.splice(0);
        for (const item of pending) {
            const dispatched = await this.#dispatchSpawn(item.ctx, item.selector);
            if (!dispatched) {
                this.#spawnQueue.push(item);
            }
        }
    }

    async #dispatchSpawn(ctx: ProcessSpawnContext, selector: { id?: string; class?: string }): Promise<boolean> {
        const executor = await this.#selectExecutor(selector);
        if (!executor) return false;

        const entry = this.#getEntry(ctx.pid);
        entry.executorId = executor.descriptor.id;
        entry.executorClass = executor.descriptor.class;

        executor.handler(ctx).catch((e) => {
            this["party.openv.impl.process.exitProcess"](ctx.pid, null);
            const current = this.#executors.get(executor.descriptor.id);
            if (current) {
                current.ready = false;
                current.failureCount++;
            }
            console.warn(`Spawn handler for pid=${ctx.pid} threw an error:`, e);
        });

        return true;
    }

    async #selectExecutor(selector: { id?: string; class?: string }): Promise<RegisteredExecutor | null> {
        if (selector.id) {
            return this.#executors.get(selector.id) ?? null;
        }

        const candidates = Array.from(this.#executors.values()).filter((executor) => {
            if (selector.class) return executor.descriptor.class === selector.class;
            return true;
        });

        if (candidates.length === 0) return null;

        const probes = candidates.map(async (executor) => {
            const ok = await this["party.openv.impl.process.pingExecutor"](executor.descriptor.id);
            if (!ok) throw new Error(`Executor ${executor.descriptor.id} is not ready.`);
            return executor;
        });

        try {
            return await Promise.any(probes);
        } catch {
            return null;
        }
    }

    #toExecutorInfo(executor: RegisteredExecutor): ProcessExecutorInfo {
        return {
            id: executor.descriptor.id,
            class: executor.descriptor.class,
            ready: executor.ready,
            lastPingAt: executor.lastPingAt,
            failureCount: executor.failureCount,
        };
    }

    #getEntry(pid: number): ProcessEntry {
        const entry = this.#processTable.get(pid);
        if (!entry) throw new Error(`No process with pid ${pid}.`);
        return entry;
    }

    #allocatePid(entry: Omit<ProcessEntry, "pid" | "waiters" | "running" | "exitCode" | "signalHandlers" | "executorId" | "executorClass">): number {
        const pid = ++this.#pidCounter;
        this.#processTable.set(pid, {
            ...entry,
            pid,
            waiters: [],
            running: true,
            exitCode: null,
            signalHandlers: new Map(),
            executorId: null,
            executorClass: null,
        });
        return pid;
    }

    supports(ns: PROCESS_NAMESPACE_VERSIONED | PROCESS_NAMESPACE): Promise<PROCESS_NAMESPACE_VERSIONED>;
    supports(ns: PROCESS_BINFMT_NAMESPACE | PROCESS_BINFMT_NAMESPACE_VERSIONED): Promise<PROCESS_BINFMT_NAMESPACE_VERSIONED>;
    supports(ns: typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED | typeof CORE_PROCESS_EXT_NAMESPACE): Promise<typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (ns === "party.openv.process" || ns === "party.openv.process/0.1.0") return "party.openv.process/0.1.0";
        if (ns === "party.openv.process.binfmt" || ns === "party.openv.process.binfmt/0.1.0") return "party.openv.process.binfmt/0.1.0";
        if (ns === CORE_PROCESS_EXT_NAMESPACE || ns === CORE_PROCESS_EXT_NAMESPACE_VERSIONED) return CORE_PROCESS_EXT_NAMESPACE_VERSIONED;
        return null;
    }
}


export class ProcessScopedProcess implements ProcessComponent, ProcessBinfmtComponent, ProcessLocalComponent {

    #pid: number;
    #process: ProcessComponent & ProcessBinfmtComponent & CoreProcessExt;

    constructor(pid: number, process: ProcessComponent & ProcessBinfmtComponent & CoreProcessExt) {
        this.#pid = pid;
        this.#process = process;
    }

    async #requireRoot(op: string): Promise<void> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        if (self.uid !== 0) {
            throw new Error(`EPERM: operation not permitted, ${op} requires uid 0`);
        }
    }

    async #requireCanControlProcess(targetPid: number, op: string): Promise<void> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        const target = await this.#process["party.openv.impl.process.getEntry"](targetPid);
        if (self.uid === 0 || self.uid === target.uid || self.pid === targetPid) {
            return;
        }
        throw new Error(`EPERM: operation not permitted, ${op} '${targetPid}'`);
    }

    async ["party.openv.process.spawn"](
        command: string,
        args?: string[],
        options?: ProcessSpawnOptions
    ): Promise<number> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);

        if ((options?.uid !== undefined || options?.gid !== undefined) && self.uid !== 0) {
            throw new Error("Only a process with uid 0 may change uid/gid on spawn.");
        }

        const inheritedStdio = self.stdioOfds;
        const mergedStdio: [StdioOption?, StdioOption?, StdioOption?] = [
            options?.stdio?.[0] ?? (inheritedStdio?.[0] !== undefined ? "inherit" : undefined),
            options?.stdio?.[1] ?? (inheritedStdio?.[1] !== undefined ? "inherit" : undefined),
            options?.stdio?.[2] ?? (inheritedStdio?.[2] !== undefined ? "inherit" : undefined),
        ];

        return this.#process["party.openv.process.spawn"](command, args, {
            ...options,
            ppid: this.#pid,
            uid: options?.uid ?? self.uid,
            gid: options?.gid ?? self.gid,
            cwd: options?.cwd ?? self.cwd,
            env: options?.env ?? { ...self.env },
            stdio: mergedStdio,
        });
    }

    async ["party.openv.process.getstdio"](pid: number): Promise<SpawnStdioResult> {
        return this.#process["party.openv.process.getstdio"](pid);
    }

    async ["party.openv.process.pingExecutor"](id: string): Promise<boolean> {
        return this.#process["party.openv.process.pingExecutor"](id);
    }

    async ["party.openv.process.listExecutors"](): Promise<ProcessExecutorInfo[]> {
        return this.#process["party.openv.process.listExecutors"]();
    }

    async ["party.openv.process.getExecutorById"](id: string): Promise<ProcessExecutorInfo | null> {
        return this.#process["party.openv.process.getExecutorById"](id);
    }

    async ["party.openv.process.getExecutorByPid"](pid: number): Promise<ProcessExecutorInfo | null> {
        return this.#process["party.openv.process.getExecutorByPid"](pid);
    }

    async ["party.openv.process.kill"](pid: number): Promise<void> {
        await this.#requireCanControlProcess(pid, "kill");
        return this.#process["party.openv.process.kill"](pid);
    }

    async ["party.openv.process.signal"](pid: number, signal: string): Promise<void> {
        await this.#requireCanControlProcess(pid, `signal ${signal}`);
        return this.#process["party.openv.impl.process.deliverSignal"](this.#pid, pid, signal);
    }

    async ["party.openv.process.wait"](pid: number): Promise<number | null> {
        return this.#process["party.openv.process.wait"](pid);
    }

    async ["party.openv.process.list"](): Promise<Array<{ pid: number; ppid: number }>> {
        return this.#process["party.openv.process.list"]();
    }

    async ["party.openv.process.getppid"](pid: number): Promise<number> {
        return this.#process["party.openv.process.getppid"](pid);
    }

    async ["party.openv.process.getuid"](pid: number): Promise<number> {
        return this.#process["party.openv.process.getuid"](pid);
    }

    async ["party.openv.process.getgid"](pid: number): Promise<number> {
        return this.#process["party.openv.process.getgid"](pid);
    }

    async ["party.openv.process.getcwd"](pid: number): Promise<string> {
        return this.#process["party.openv.process.getcwd"](pid);
    }

    async ["party.openv.process.getargs"](pid: number): Promise<string[]> {
        return this.#process["party.openv.process.getargs"](pid);
    }

    async ["party.openv.process.getexe"](pid: number): Promise<string> {
        return this.#process["party.openv.process.getexe"](pid);
    }

    async ["party.openv.process.getenv"](pid: number, name: string): Promise<string | null> {
        return this.#process["party.openv.process.getenv"](pid, name);
    }

    async ["party.openv.process.listenv"](pid: number): Promise<string[]> {
        return this.#process["party.openv.process.listenv"](pid);
    }

    async ["party.openv.process.getstats"](pid: number): Promise<{
        ppid: number; uid: number; gid: number; cwd: string; args: string[]; exe: string; env: Record<string, string>;
    }> {
        return this.#process["party.openv.process.getstats"](pid);
    }

    async ["party.openv.process.binfmt.register"](rule: ProcessBinfmtRule): Promise<void> {
        await this.#requireRoot("binfmt.register");
        return this.#process["party.openv.process.binfmt.register"](rule);
    }

    async ["party.openv.process.binfmt.unregister"](name: string): Promise<void> {
        await this.#requireRoot("binfmt.unregister");
        return this.#process["party.openv.process.binfmt.unregister"](name);
    }

    async ["party.openv.process.binfmt.list"](): Promise<ProcessBinfmtRule[]> {
        return this.#process["party.openv.process.binfmt.list"]();
    }

    async ["party.openv.process.binfmt.resolve"](command: string, args?: string[]): Promise<ProcessBinfmtMatchResult | null> {
        return this.#process["party.openv.process.binfmt.resolve"](command, args);
    }

    async ["party.openv.process.local.exit"](code: number): Promise<void> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        await this.#process["party.openv.impl.process.exitProcess"](this.#pid, code);

        if (self.ppid !== 0) {
            await this.#process["party.openv.impl.process.deliverSignal"](this.#pid, self.ppid, "party.openv.process.signals.notifyexit").catch(() => {
                // RIP parent :(
            });
        }

        await this.#process["party.openv.impl.process.deliverSignal"](this.#pid, 0, "party.openv.process.signals.notifyexit").catch(() => {
            // This is probably fine um
            console.warn('this is fine 🔥🔥');
        });
    }

    async ["party.openv.process.local.getpid"](): Promise<number> {
        return this.#pid;
    }

    async ["party.openv.process.local.getppid"](): Promise<number> {
        return this.#process["party.openv.process.getppid"](this.#pid);
    }

    async ["party.openv.process.local.getuid"](): Promise<number> {
        return this.#process["party.openv.process.getuid"](this.#pid);
    }

    async ["party.openv.process.local.getgid"](): Promise<number> {
        return this.#process["party.openv.process.getgid"](this.#pid);
    }

    async ["party.openv.process.local.setuid"](uid: number): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        if (entry.uid !== 0) {
            throw new Error("Only a process with uid 0 may call setuid.");
        }
        entry.uid = uid;
    }

    async ["party.openv.process.local.setgid"](gid: number): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        if (entry.uid !== 0) {
            throw new Error("Only a process with uid 0 may call setgid.");
        }
        entry.gid = gid;
    }

    async ["party.openv.process.local.getcwd"](): Promise<string> {
        return this.#process["party.openv.process.getcwd"](this.#pid);
    }

    async ["party.openv.process.local.getexe"](): Promise<string> {
        return this.#process["party.openv.process.getexe"](this.#pid);
    }

    async ["party.openv.process.local.getenv"](name: string): Promise<string | null> {
        return this.#process["party.openv.process.getenv"](this.#pid, name);
    }

    async ["party.openv.process.local.listenv"](): Promise<string[]> {
        return this.#process["party.openv.process.listenv"](this.#pid);
    }

    async ["party.openv.process.local.setenv"](name: string, value: string): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        entry.env[name] = value;
    }

    async ["party.openv.process.local.unsetenv"](name: string): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        delete entry.env[name];
    }

    async ["party.openv.process.local.chdir"](path: string): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        entry.cwd = path;
    }

    async ["party.openv.process.local.getargs"](): Promise<string[]> {
        return this.#process["party.openv.process.getargs"](this.#pid);
    }

    async ["party.openv.process.local.getExecutor"](): Promise<ProcessExecutorInfo | null> {
        return this.#process["party.openv.process.getExecutorByPid"](this.#pid);
    }

    async ["party.openv.process.local.onsignal"]<T extends string>(
        signal: T,
        handler: (cx: { signal: T; uid: number; gid: number; pid: number }) => Promise<void>
    ): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        entry.signalHandlers.set(signal, handler as SignalHandler);
    }

    async ["party.openv.process.local.offsignal"]<T extends string>(signal: T): Promise<void> {
        const entry = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        entry.signalHandlers.delete(signal);
    }

    supports(ns: PROCESS_NAMESPACE_VERSIONED | PROCESS_NAMESPACE): Promise<PROCESS_NAMESPACE_VERSIONED>;
    supports(ns: PROCESS_BINFMT_NAMESPACE_VERSIONED | PROCESS_BINFMT_NAMESPACE): Promise<PROCESS_BINFMT_NAMESPACE_VERSIONED>;
    supports(ns: PROCESS_LOCAL_NAMESPACE_VERSIONED | PROCESS_LOCAL_NAMESPACE): Promise<PROCESS_LOCAL_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (ns === "party.openv.process" || ns === "party.openv.process/0.1.0") {
            return "party.openv.process/0.1.0";
        }
        if (ns === "party.openv.process.binfmt" || ns === "party.openv.process.binfmt/0.1.0") {
            return "party.openv.process.binfmt/0.1.0";
        }
        if (ns === "party.openv.process.local" || ns === "party.openv.process.local/0.1.0") {
            return "party.openv.process.local/0.1.0";
        }
        return null;
    }
}
