import type { SystemComponent } from "../../openv/syscall";

export type DenyPolicy = {
    type: "deny";
}

export type AllowPolicy = {
    type: "allow";
}

export type Policy = {
    method: string;
} & (DenyPolicy | AllowPolicy);

export class ComponentFilter<T extends SystemComponent<any, any>, U extends SystemComponent<any, any>> {
    #base: T;
    #policies: Map<string, Policy> = new Map();

    #proxy: U = new Proxy({} as U, {
        get: (_t, prop, _r) => {
            if (prop === "supports") {
                // append "-restricted" if any method starts with the passed string to supports and the supports() base method returns string.
                return async (ns: string) => {
                    const supportsResult = await (this.#base as any).supports(ns);
                    if (typeof supportsResult === "string") {
                        for (const [method, policy] of this.#policies.entries()) {
                            if (method.endsWith("*") && ns.startsWith(method.slice(0, -1))) {
                                if (policy.type === "deny") {
                                    return `${ns}-restricted`;
                                }
                            } else if (method === ns) {
                                if (policy.type === "deny") {
                                    return `${ns}-restricted`;
                                }
                            }
                        }
                    }
                    return supportsResult;
                };
            }

            const policy = this.getPolicy(prop.toString());
            if (policy.type === "deny") {
                throw new Error(`Access denied to ${prop.toString()}`);
            }
            return this.#base[prop as keyof T];
        }
    });

    constructor(base: T) {
        this.#base = base;

        this.unsetPolicy("*");
    }

    setPolicy(policy: Policy): void {
        this.#policies.set(policy.method, policy);
    }
    unsetPolicy(method: string): void {
        this.#policies.delete(method);
        if (method === "*") {
            this.#policies.clear();
            this.#policies.set("*", {
                method: "*",
                type: "allow"
            });
        }
    }

    getPolicy(method: string): Policy {
        return this.#policies.get(method) ?? this.#policies.get("*")!;
    }

    get system(): U {
        return this.#proxy;
    }
}
