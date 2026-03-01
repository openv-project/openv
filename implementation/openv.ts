import type { API } from "../openv/api/api.ts";
import type { FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, RegistryReadComponent, RegistryWriteComponent, SystemComponent } from "../openv/syscall/index.ts";
import type { OpEnv, OpEnvSystem } from "../openv/openv.ts";
import { CoreRegistry } from "./syscall/registry.ts";
import { CoreFS } from "./syscall/fs.ts";

export class CoreOpEnv implements OpEnv<RegistryReadComponent & RegistryWriteComponent>, OpEnvSystem {
    #api: { [key: string]: API } = {};

    get api(): { readonly [key: string]: API; } {
        return this.#api;
    }

    async installAPI(api: API): Promise<void> {
        this.#api[api.name] = api;
        await api.initialize(this);
    }

    getAPI<T extends API>(name: T["name"]): T | null;
    getAPI(name: string): API | null {
        return this.#api[name];
    }

    #components: SystemComponent<any, any>[] = [];

    #syscallProxy: any = new Proxy({}, {
        get: (_t, prop, _r) => {
            if (prop === "supports") {
                return async (ns: string) => {
                    for (const component of this.#components) {
                        if (typeof (component as any).supports === "function") {
                            const result = await (component as any).supports(ns);
                            if (result) return result;
                        }
                    }
                    return null;
                };
            }

            for (const component of this.#components) {
                if (prop in component) {
                    if (typeof (component as any)[prop] === "function") {
                        return (component as any)[prop].bind(component);
                    } else {
                        return (component as any)[prop];
                    }
                }
            }
            return undefined;
        }
    });

    get system(): RegistryReadComponent & RegistryWriteComponent & FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemVirtualComponent {
        return this.#syscallProxy;
    }

    installSystemComponent<T extends SystemComponent<any, any>>(sys: T): void {
        this.#components.push(sys);
    }

    getSystemComponent<T extends SystemComponent<any, any>>(namespace: string): T | null {
        for (const component of this.#components) {
            if ((component as any).namespace === namespace) {
                return component as T;
            }
        }
        return null;
    }

    constructor() {
        this.installSystemComponent(new CoreRegistry());
        this.installSystemComponent(new CoreFS());
    }
}