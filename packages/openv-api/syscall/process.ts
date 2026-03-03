import type { SystemComponent } from "./mod.ts";

export const PROCESS_NAMESPACE = "party.openv.process" as const;
export const PROCESS_NAMESPACE_VERSIONED = `${PROCESS_NAMESPACE}/0.1.0` as const;
export const PROCESS_LOCAL_NAMESPACE = `${PROCESS_NAMESPACE}.local` as const;
export const PROCESS_LOCAL_NAMESPACE_VERSIONED = `${PROCESS_LOCAL_NAMESPACE}/0.1.0` as const;

/**
 * This signal is emitted when a process is going to exit gracefully. The process manager will send this signal authored by a child process to its parent process when the `party.openv.process.local.exit` syscall is called.
 * When sent to pid 0, this will free any calls to `party.openv.process.wait` that are waiting on the exiting process, but will not tell the system to kill the process. 
 */
export const PROCESS_SIGNAL_NOTIFYEXIT = "party.openv.process.signals.notifyexit" as const;

/**
 * This signal is sent to a process to request that it terminates gracefully. The process can choose how to respond to this signal, but it is expected to exit if the sender has the correct privileges.
 */
export const PROCESS_SIGNAL_QUIT = "party.openv.process.signals.quit" as const;

/**
 * Universal process management component, that does not rely on actually being called in a process.
 */
export interface ProcessComponent extends SystemComponent<typeof PROCESS_NAMESPACE_VERSIONED, typeof PROCESS_NAMESPACE> {
    /**
     * Spawns a new process, with different tree behavior depending on the environment it is called in.
     * @param command The absolute path to the executable to run
     * @param args The arguments to pass to the executable. The first argument (args[0]) should be the name of the executable itself, as per convention.
     * @param options Additional options for spawning the process. `env` is an object containing environment variables to set for the process, and `cwd`
     * is the working directory to spawn the process in. Note that if this is called in the system environment instead of a process,
     * all options are mandatory. Attempting to set `ppid` in a process environment will be ignored, and `uid` and `gid` will throw errors unless in a system environment or a process environment with uid/gid 0.
     */
    [`party.openv.process.spawn`](command: string, args?: string[], options?: { env?: Record<string, string>, cwd?: string, uid?: number, gid?: number, ppid?: number }): Promise<number>;

    /**
     * Kill a process without signaling. This will guarantee that the process is killed, as long as the caller has permission to kill the process, which heavily depends on the environment.
     * When possible, use signaling instead. Any process or the system itself (pid 0 logically) can send a signal to any process, and the process itself chooses how to respond to that signal.
     */
    [`party.openv.process.kill`](pid: number): Promise<void>;

    /**
     * Send a signal to a process. The process can choose how to respond to the signal, and may ignore it entirely. If the process does not have permission to receive the signal, this will throw an error.
     * @param pid The process ID of the target process. Logically, pid 0 is the system itself, and should be able to receive signals from any process.
     * @param signal The name of the signal to send. The process component defines standard signals for compatibility, but users and developers are free to expand and include custom signals at will.
     */
    [`party.openv.process.signal`](pid: number, signal: typeof PROCESS_SIGNAL_QUIT | typeof PROCESS_SIGNAL_NOTIFYEXIT | string): Promise<void>;

    /**
     * Wait for a process to exit. This will return the exit code of the process, or null if the process was forcibly killed.
     */
    [`party.openv.process.wait`](pid: number): Promise<number | null>;

    /**
     * Get a list of all currently running processes. The returned array only contains pid and ppid for each process, and more detailed information is expected to be queried if needed using the process ID.
     * This gives enough information to construct a process tree.
     */
    [`party.openv.process.list`](): Promise<Array<{ pid: number, ppid: number }>>;

    /**
     * Get the parent process ID of a process. Logically, no parent means ppid = 0
     */
    [`party.openv.process.getppid`](pid: number): Promise<number>;

    /**
     * Get the user ID of a process.
     */
    [`party.openv.process.getuid`](pid: number): Promise<number>;

    /**
     * Get the group ID of a process.
     */
    [`party.openv.process.getgid`](pid: number): Promise<number>;

     /**
     * Get the current working directory of a process.
     */
    [`party.openv.process.getcwd`](pid: number): Promise<string>;

    /**
     * Get the command line arguments passed to a process. The first argument (args[0]) should be the name of the executable itself, as per convention.
     */
    [`party.openv.process.getargs`](pid: number): Promise<string[]>;

    /**
    * Gets the absolute path of the executable of a process.
    */
    [`party.openv.process.getexe`](pid: number): Promise<string>;

    /**
    * Gets the value of an environment variable for a process. Returns null if the variable is not set.
    */
    [`party.openv.process.getenv`](pid: number, name: string): Promise<string | null>;

    /**
    * List environment variables for a process. 
    */
    [`party.openv.process.listenv`](pid: number): Promise<string[]>;

    /**
     * Get all stats for a process, without having to make multiple calls.
     */
    [`party.openv.process.getstats`](pid: number): Promise<{
        ppid: number;
        uid: number;
        gid: number;
        cwd: string;
        args: string[];
        exe: string;
        env: Record<string, string>;
    }>;
}

/**
 * A system component for process-local operations. This component is only available to the process itself, and is not accessible by other processes.
 */
export interface ProcessLocalComponent extends SystemComponent<typeof PROCESS_LOCAL_NAMESPACE_VERSIONED, typeof PROCESS_LOCAL_NAMESPACE> {
    /**
     * Exits the current process with the given exit code.
     */
    [`party.openv.process.local.exit`](code: number): Promise<void>;

    /**
     * Gets the process ID of the current process.
     */
    [`party.openv.process.local.getpid`](): Promise<number>;

    /**
    * Gets the parent process ID of the current process. Logically, no parent means ppid = 0
    */
    [`party.openv.process.local.getppid`](): Promise<number>;
    
    /**
     * Gets the user ID of the current process.
     */
    [`party.openv.process.local.getuid`](): Promise<number>;

    /**
     * Gets the group ID of the current process.
     */
    [`party.openv.process.local.getgid`](): Promise<number>;

    /**
     * Sets the user ID of the current process. This is only allowed if the process and user has the appropriate privileges.
     */
    [`party.openv.process.local.setuid`](uid: number): Promise<void>;

    /**
     * Sets the group ID of the current process. This is only allowed if the process and user has the appropriate privileges.
     */
    [`party.openv.process.local.setgid`](gid: number): Promise<void>;

    /**
     * Gets the current working directory of the process.
     */
    [`party.openv.process.local.getcwd`](): Promise<string>;

    /**
     * Gets the absolute path of the executable of the current process.
     */
    [`party.openv.process.local.getexe`](): Promise<string>;

    /**
    * Gets the value of an environment variable for the process. Returns null if the variable is not set.
    */
    [`party.openv.process.local.getenv`](name: string): Promise<string | null>;

    /**
     * List environment variables for the process. 
     */
    [`party.openv.process.local.listenv`](): Promise<string[]>;

    /**
     * Sets the value of an environment variable for the process.
     */
    [`party.openv.process.local.setenv`](name: string, value: string): Promise<void>;
    
    /**
     * Unsets an environment variable for the process.
     */
    [`party.openv.process.local.unsetenv`](name: string): Promise<void>;

    /**
     * Changes the current working directory of the process.
     */
    [`party.openv.process.local.chdir`](path: string): Promise<void>;

    /**
     * Gets the command line arguments passed to the process. The first argument (args[0]) should be the name of the executable itself, as per convention.
     */
    [`party.openv.process.local.getargs`](): Promise<string[]>;

    /**
     * Handle a named signal sent to the process.
     */
    [`party.openv.process.local.onsignal`]<T extends string>(signal: T, handler: (cx: {signal: T, uid: number, gid: number, pid: number}) => Promise<void>): Promise<void>;

    /**
     * Remove a signal handler for a named signal.
     */
    [`party.openv.process.local.offsignal`]<T extends string>(signal: T): Promise<void>;
}