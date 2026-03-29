import type { API, FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, OpEnv, OpEnvSystem, PlainParameter, RegistryReadComponent, RegistryWriteComponent, SystemComponent, SystemLinkTransport } from "@openv-project/openv-api";
import { CoreSystemLinkPeer } from "./mod";

export class CoreOpEnv<T extends SystemComponent<any, any> = SystemComponent<any, any>> implements OpEnv<T>, OpEnvSystem {
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
        },
        ownKeys: (_t) => {
            const names = new Set<string>();
            for (const c of this.#components) {
                const proto = c.constructor.prototype;
                if (proto && typeof proto === "object") {
                    const props = Object.getOwnPropertyNames(proto);
                    for (const p of props) names.add(p);
                }
            }
            return [...names].filter(name => name !== "constructor");
        },
        has: (_t, prop) => {
            for (const component of this.#components) {
                if (prop in component) {
                    return true;
                }
            }
            return false;
        },

        // Add this trap so reflection APIs see enumerable own properties
        getOwnPropertyDescriptor: (_t, prop) => {
            for (const component of this.#components) {
                if (prop in component) {
                    const val = (component as any)[prop];
                    const isFn = typeof val === "function";
                    return {
                        configurable: true,
                        enumerable: true,
                        writable: !isFn,
                        value: isFn ? val.bind(component) : val
                    } as PropertyDescriptor;
                }
            }
            return undefined;
        }
    });

    get system(): T {
        return this.#syscallProxy;
    }

    installSystemComponent<T extends SystemComponent<any, any>>(sys: T): void {
        this.#components.push(sys);
    }
}

export class ClientOpEnv<T extends SystemComponent<any, any>> implements OpEnv<T> {
    #api: { [key: string]: API } = {};
    #peer: CoreSystemLinkPeer;
    #methods: string[] = [];

    constructor(transport?: SystemLinkTransport) {
        this.#peer = new CoreSystemLinkPeer();
        if (transport) this.#peer.setTransport(transport);
        this.#peer.start();
    }

    async enumerateRemote(): Promise<void> {
        this.#methods = await this.#peer.enumerateRemote();
    }

    #peerProxy: T = new Proxy({} as T, {
        get: (_t, prop, _r) => {
            if (prop === Symbol.iterator || prop === Symbol.toPrimitive) return undefined;
            return (...args: PlainParameter[]) => {
                return this.#peer.callRemote(prop.toString(), args);
            };
        },
        ownKeys: (_t) => {
            return this.#methods;
        },
        getOwnPropertyDescriptor: (_t, prop) => {
            if (this.#methods.includes(prop as string)) {
                return { enumerable: true, configurable: true, writable: true };
            }
            return undefined;
        },
        has: (_t, prop) => {
            return this.#methods.includes(prop as string);
        }
    });

    get system(): T {
        return this.#peerProxy;
    }
    getAPI<T extends API>(name: T["name"]): T | null;
    getAPI(name: string): API | null {
        return this.#api[name] || null;
    }

    async setTransport(transport: SystemLinkTransport): Promise<void> {
        await this.#peer.stop();
        this.#peer.setTransport(transport);
        await this.#peer.start();
    }

    get api(): { readonly [key: string]: API; } {
        return this.#api;
    }

    async installAPI(api: API): Promise<void> {
        this.#api[api.name] = api;
        await api.initialize(this);
    }
}