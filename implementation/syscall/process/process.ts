import type { FileSystemCoreComponent, FileSystemReadOnlyComponent, SystemComponent } from "../../../openv/syscall";
import { PROCESS_LOCAL_NAMESPACE, PROCESS_LOCAL_NAMESPACE_VERSIONED, PROCESS_NAMESPACE, PROCESS_NAMESPACE_VERSIONED, PROCESS_SIGNAL_NOTIFYEXIT, type ProcessComponent, type ProcessLocalComponent } from "../../../openv/syscall/process";

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
    waiters: Array<(code: number | null) => void>;
    running: boolean;
    exitCode: number | null;
    signalHandlers: Map<string, SignalHandler>;
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
}

export interface ProcessExecutor {
    run(ctx: ProcessSpawnContext): Promise<void>;
    destroy(pid: number): Promise<void>;
}

const CORE_PROCESS_EXT_NAMESPACE = "party.openv.impl.process" as const;
const CORE_PROCESS_EXT_NAMESPACE_VERSIONED = "party.openv.impl.process/0.1.0" as const;

export interface CoreProcessExt extends SystemComponent<typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED, typeof CORE_PROCESS_EXT_NAMESPACE> {
    ["party.openv.impl.process.setExecutor"](executor: ProcessExecutor): Promise<void>;

    ["party.openv.impl.process.exitProcess"](pid: number, code: number | null): Promise<void>;

    ["party.openv.impl.process.deliverSignal"](senderPid: number, targetPid: number, signal: string): Promise<void>;

    ["party.openv.impl.process.getEntry"](pid: number): Promise<ProcessEntry>;
}


export class CoreProcess implements ProcessComponent, CoreProcessExt {
    #pidCounter = 0;
    #processTable: Map<number, ProcessEntry> = new Map();
    #executor: ProcessExecutor | null = null;

    async ["party.openv.impl.process.setExecutor"](executor: ProcessExecutor): Promise<void> {
        this.#executor = executor;
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
            // PID 0 is the target for signals that affect the system's process management
            if (signal === PROCESS_SIGNAL_NOTIFYEXIT) {
                // Fully destroy the sender process and free the pid
                const entry = this.#processTable.get(senderPid);
                if (entry) {
                    entry.running = false;
                    for (const resolve of entry.waiters) {
                        resolve(entry.exitCode);
                    }
                    entry.waiters = [];
                    this.#processTable.delete(senderPid);
                    // Allow the executor to perform cleanup
                    if (this.#executor) {
                        await this.#executor.destroy(senderPid).catch(() => {
                            // ignore executor cleanup errors
                        });
                    }
                }
            }
            return;
        }

        const entry = this.#getEntry(targetPid);
        if (!entry.running) {
            throw new Error(`Process ${targetPid} is not running.`);
        }

        if (signal === PROCESS_SIGNAL_NOTIFYEXIT) {
            for (const resolve of entry.waiters) {
                resolve(entry.exitCode);
            }
            entry.waiters = [];
            return;
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

    #getEntry(pid: number): ProcessEntry {
        const entry = this.#processTable.get(pid);
        if (!entry) {
            throw new Error(`No process with pid ${pid}.`);
        }
        return entry;
    }

    #allocatePid(entry: Omit<ProcessEntry, "pid" | "waiters" | "running" | "exitCode" | "signalHandlers">): number {
        const pid = ++this.#pidCounter;
        this.#processTable.set(pid, {
            ...entry,
            pid,
            waiters: [],
            running: true,
            exitCode: null,
            signalHandlers: new Map(),
        });
        return pid;
    }

    async ["party.openv.process.spawn"](
        command: string,
        args?: string[],
        options?: { env?: Record<string, string>; cwd?: string; uid?: number; gid?: number; ppid?: number }
    ): Promise<number> {
        // In the system environment all options are mandatory per spec.
        if (options?.cwd === undefined || options?.env === undefined) {
            throw new Error("cwd and env are mandatory when spawning from the system environment.");
        }
        if (!this.#executor) {
            throw new Error("No process executor has been set. Call party.openv.impl.process.setExecutor first.");
        }

        const pid = this.#allocatePid({
            ppid: options.ppid ?? 0,
            uid: options.uid ?? 0,
            gid: options.gid ?? 0,
            cwd: options.cwd,
            exe: command,
            args: args ?? [command],
            env: options.env,
        });

        const entry = this.#getEntry(pid);
        const ctx: ProcessSpawnContext = { ...entry, env: { ...entry.env } };

        this.#executor.run(ctx).catch(() => {
            this["party.openv.impl.process.exitProcess"](pid, null);
        });

        return pid;
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

    supports(ns: typeof PROCESS_NAMESPACE_VERSIONED | typeof PROCESS_NAMESPACE): Promise<typeof PROCESS_NAMESPACE_VERSIONED>;
    supports(ns: typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED | typeof CORE_PROCESS_EXT_NAMESPACE): Promise<typeof CORE_PROCESS_EXT_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (ns === PROCESS_NAMESPACE || ns === PROCESS_NAMESPACE_VERSIONED) {
            return PROCESS_NAMESPACE_VERSIONED;
        }
        if (ns === CORE_PROCESS_EXT_NAMESPACE || ns === CORE_PROCESS_EXT_NAMESPACE_VERSIONED) {
            return CORE_PROCESS_EXT_NAMESPACE_VERSIONED;
        }
        return null;
    }
}

export class ProcessScopedProcess implements ProcessComponent, ProcessLocalComponent {

    #pid: number;
    #process: ProcessComponent & CoreProcessExt;

    constructor(pid: number, process: ProcessComponent & CoreProcessExt) {
        this.#pid = pid;
        this.#process = process;
    }

    async ["party.openv.process.spawn"](
        command: string,
        args?: string[],
        options?: { env?: Record<string, string>; cwd?: string; uid?: number; gid?: number; ppid?: number }
    ): Promise<number> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);

        if ((options?.uid !== undefined || options?.gid !== undefined) && self.uid !== 0) {
            throw new Error("Only a process with uid 0 may change uid/gid on spawn.");
        }

        return this.#process["party.openv.process.spawn"](command, args, {
            ...options,
            ppid: this.#pid,
            uid: options?.uid ?? self.uid,
            gid: options?.gid ?? self.gid,
            cwd: options?.cwd ?? self.cwd,
            env: options?.env ?? { ...self.env },
        });
    }

    async ["party.openv.process.kill"](pid: number): Promise<void> {
        return this.#process["party.openv.process.kill"](pid);
    }

    async ["party.openv.process.signal"](pid: number, signal: string): Promise<void> {
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

    async ["party.openv.process.local.exit"](code: number): Promise<void> {
        const self = await this.#process["party.openv.impl.process.getEntry"](this.#pid);
        await this.#process["party.openv.impl.process.exitProcess"](this.#pid, code);

        if (self.ppid !== 0) {
            await this.#process["party.openv.impl.process.deliverSignal"](this.#pid, self.ppid, PROCESS_SIGNAL_NOTIFYEXIT).catch(() => {
                // RIP parent :(
            });
        }

        await this.#process["party.openv.impl.process.deliverSignal"](this.#pid, 0, PROCESS_SIGNAL_NOTIFYEXIT).catch(() => {
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

    supports(ns: typeof PROCESS_NAMESPACE_VERSIONED | typeof PROCESS_NAMESPACE): Promise<typeof PROCESS_NAMESPACE_VERSIONED>;
    supports(ns: typeof PROCESS_LOCAL_NAMESPACE_VERSIONED | typeof PROCESS_LOCAL_NAMESPACE): Promise<typeof PROCESS_LOCAL_NAMESPACE_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (ns === PROCESS_NAMESPACE || ns === PROCESS_NAMESPACE_VERSIONED) {
            return PROCESS_NAMESPACE_VERSIONED;
        }
        if (ns === PROCESS_LOCAL_NAMESPACE || ns === PROCESS_LOCAL_NAMESPACE_VERSIONED) {
            return PROCESS_LOCAL_NAMESPACE_VERSIONED;
        }
        return null;
    }
}