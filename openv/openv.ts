import type { API } from "./api/api.ts";
import type { SystemComponent } from "./syscall/index.ts";

/**
 * All unified web operating systems should provide this interface as a global variable named `openv`. If many additional
 * properties are added to the OpEnv object itself, there should be a secondary global variable named after your operating
 * system (e.g. `myawesomeos`) that is a reference to the same object. This allows applications depending on platform-specifics
 * to clearly indicate that they are doing so.
 * 
 * For maximum compatibility, the `openv` global should be used for all interactions, and APIs or system calls should be accessed
 * and extended through their respective properties on the `openv` object.
 * 
 * Note that APIs are the primary way for applications to interact with the operating system. A new process would typically
 * have a OpEnv object passed with a standard set of syscalls, and empty set of APIs. The process can choose to install APIs
 * as needed. Many APIs will simply be wrappers around syscalls, but can provide extra functionality such as service/bus utility,
 * graphics, or anything that shouldn't be running at system level.
 * 
 * While syscalls can and will be implemented completely differently across operating systems (but will have the same public interface),
 * APIs should support any OpEnv-compliant operating system.
 */
export interface OpEnv<T extends SystemComponent<any, any>> {
    /**
     * The `system` property is how applications and APIs interact with the operating system at the lowest level.
     * This should provide a view of all the syscalls supported by the operating system and the current environment.
     * (Some syscalls may be hidden from processes but used internally)
     */
    get system(): T;
    get api(): {
        readonly [key: string]: API;
    }
    installAPI(api: API): Promise<void>;
    
    getAPI<T extends API>(name: T["name"]): T | null;
    getAPI(name: string): API | null;
}

/**
 * These methods can be implemented by the operating system as an example of how to organize an implementation of
 * OpEnv. The `installSystemComponent` and `getSystemComponent` methods mirror the `installAPI` and `getAPI` methods on the standard OpEnv
 * interface respectively, but are used for syscalls instead of APIs. Instead of trying to design a huge class
 * with all the supported system components, we can design each component's implementation as a separate class,
 * and install them into the system as components. The system getter can simply return a proxy that traps gets to
 * return the appropriate system component implementation based on the namespace string.
 */
export interface OpEnvSystem {
    installSystemComponent<T extends SystemComponent<any, any>>(sys: T): void;
    getSystemComponent<T extends SystemComponent<any, any>>(namespace: string): T | null;
}