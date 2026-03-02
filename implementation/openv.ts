import type { API } from "../openv/api/api.ts";
import type { FileSystemCoreComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, FileSystemVirtualComponent, RegistryReadComponent, RegistryWriteComponent, SystemComponent } from "../openv/syscall/index.ts";
import type { OpEnv, OpEnvSystem } from "../openv/openv.ts";
import { CoreRegistry } from "./syscall/registry.ts";
import { CoreFS } from "./syscall/fs.ts";
import { createPairTransport } from "./systemlink/transport/pair.ts";
import { CoreSystemLinkPeer } from "./systemlink/peer.ts";
import type { PlainParameter, SystemLinkTransport } from "../openv/systemlink/wire.ts";

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

    get system(): RegistryReadComponent & RegistryWriteComponent & FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent & FileSystemVirtualComponent {
        return this.#syscallProxy;
    }

    installSystemComponent<T extends SystemComponent<any, any>>(sys: T): void {
        this.#components.push(sys);
    }

    constructor() {
        this.installSystemComponent(new CoreRegistry());
        this.installSystemComponent(new CoreFS());
    }
}

export class ClientOpEnv<T extends SystemComponent<any, any>> implements OpEnv<T> {
    #api: { [key: string]: API } = {};
    #peer: CoreSystemLinkPeer;
    
    constructor(transport?: SystemLinkTransport) {
        this.#peer = new CoreSystemLinkPeer();
        if (transport) this.#peer.setTransport(transport);
        this.#peer.start();
    }

    #peerProxy: T = new Proxy({} as T, {
        get: (_t, prop, _r) => {
            return (...args: PlainParameter[]) => {
                return this.#peer.callRemote(prop.toString(), args);
            }
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

const systemOpenv = new CoreOpEnv();

const systemPeer = new CoreSystemLinkPeer();

for (const [name, method] of Object.entries(systemOpenv.system)) {
    if (typeof method === "function") {
        console.log(`System method: ${name}`);
        systemPeer.storeFunction(name, method.bind(systemOpenv.system));
    }

}

const [transportA, transportB] = createPairTransport();

systemPeer.setTransport(transportA);
systemPeer.start();

const clientEnv = new ClientOpEnv(transportB);
    
// console.log("Client system supports registry read:", await clientEnv.system.supports("party.openv.registry.read"));
clientEnv.system.supports("party.openv.registry.read").then(result => {
    console.log("Client system supports registry read:", result);
});