import type { SystemLinkPeer, PlainParameter, SystemLinkMessage, SystemLinkTransport, SystemLinkParameter } from "@openv-project/openv-api";

export type StoredPromise<T> = [Promise<T>, (value: T) => void, (reason?: any) => void];

export class CoreSystemLinkPeer implements SystemLinkPeer {
    #functions: Record<string, (...args: PlainParameter[]) => Promise<PlainParameter | void>> = {};
    #transport: SystemLinkTransport | null = null;
    #promises: Record<number, StoredPromise<SystemLinkParameter>> = {};
    #usedIds = new Set<number>();

    async start(): Promise<void> {
        if (!this.#transport) throw new Error("Transport not set");
        this.#transport.onMessage(this.#handleMessage);
        await this.#transport.start();
    }

    async stop(): Promise<void> {
        if (!this.#transport) throw new Error("Transport not set");
        this.#transport.offMessage(this.#handleMessage);
        await this.#transport.close();
    }

    #handleOutgoingArg(arg: PlainParameter): SystemLinkParameter {
        if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean" || arg === null) {
            return { literal: arg };
        }
        if (Array.isArray(arg)) {
            return { literal: arg.map(item => this.#handleOutgoingArg(item)) };
        }
        if (typeof arg === "object") {
            const result: Record<string, SystemLinkParameter> = {};
            for (const [key, value] of Object.entries(arg)) {
                result[key] = this.#handleOutgoingArg(value as PlainParameter);
            }
            return { literal: result };
        }
        if (typeof arg === "function") {
            const methodId = `__method_${Math.random().toString(36).slice(2)}`;
            // store a function that uses PlainParameter interface (the user-facing interface)
            this.storeFunction(methodId, async (...plainArgs: PlainParameter[]) => {
                // when remote invokes this function, it'll be called with PlainParameters
                // return whatever the original function would return (PlainParameter | void)
                // Note: the caller (message handler) will serialize the returned PlainParameter for transport.
                const res = await (arg as (...args: PlainParameter[]) => Promise<PlainParameter | void>)(...plainArgs);
                return res;
            });
            return { method: methodId };
        }
        throw new Error(`Unsupported argument type: ${typeof arg}`);
    }

    #systemLinkToPlain(param: SystemLinkParameter): PlainParameter {
        if (param === undefined) return undefined as any;
        if ("literal" in param) {
            const lit = param.literal;
            if (typeof lit === "string" || typeof lit === "number" || typeof lit === "boolean" || lit === null) {
                return lit;
            }
            if (Array.isArray(lit)) {
                return lit.map(item => this.#systemLinkToPlain(item));
            }
            if (typeof lit === "object") {
                const obj: Record<string, PlainParameter> = {};
                for (const [k, v] of Object.entries(lit)) {
                    obj[k] = this.#systemLinkToPlain(v as SystemLinkParameter);
                }
                return obj;
            }
        } else if ("method" in param) {
            // return a function that calls the remote method and converts the result to PlainParameter
            return (...params: PlainParameter[]) => {
                return this.callRemote(param.method, params) as unknown as Promise<any>;
            };
        }
        throw new Error("Unsupported SystemLinkParameter structure");
    }

    #handleIncomingArgs(args: SystemLinkParameter[]): PlainParameter[] {
        const result: PlainParameter[] = [];
        for (const arg of args) {
            if (arg === undefined) {
                result.push(undefined as any);
                continue;
            }
            result.push(this.#systemLinkToPlain(arg));
        }
        return result;
    }

    #handleMessage = async (message: SystemLinkMessage): Promise<void> => {
        if (message.type === "call") {
            const func = this.#functions[message.method];
            if (func) {
                try {
                    const plainArgs = this.#handleIncomingArgs(message.params);
                    const result = await func(...plainArgs);
                    const response: SystemLinkMessage = {
                        id: message.id,
                        type: "response",
                        success: true,
                        ...(result !== undefined ? { ok: this.#handleOutgoingArg(result) } : {})
                    };
                    this.#transport?.send(response);
                } catch (error) {
                    const response: SystemLinkMessage = {
                        id: message.id,
                        type: "response",
                        success: false,
                        err: error instanceof Error ? error.message : String(error)
                    };
                    this.#transport?.send(response);
                } finally {
                    this.#usedIds.delete(message.id);
                }
            }
        } else if (message.type === "response") {
            // response.ok is a SystemLinkParameter when success, otherwise err is present
            const value = message.success ? (message.ok as SystemLinkParameter) : { literal: message.err };
            this.#resolvePromise(message.id, value);
        }
    }

    #createPromise(id: number) {
        let resolve: (value: SystemLinkParameter) => void;
        let reject: (reason?: any) => void;
        const promise = new Promise<SystemLinkParameter>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        this.#promises[id] = [promise, resolve!, reject!];
    }

    #resolvePromise(id: number, value: SystemLinkParameter): void {
        if (!this.#promises[id]) this.#createPromise(id);
        const promise = this.#promises[id];
        promise[1](value);
    }

    #deletePromise(id: number): void {
        delete this.#promises[id];
    }

    #genId(): number {
        let id: number;
        do {
            id = Math.floor(Math.random() * 1e9);
        } while (this.#usedIds.has(id));
        this.#usedIds.add(id);
        return id;
    }

    setTransport(transport: SystemLinkTransport): void {
        this.#transport = transport;
    }

    storeFunction<T extends (...args: PlainParameter[]) => Promise<PlainParameter | void>>(name: string, func: T): void {
        this.#functions[name] = func;
    }
    destroyFunction(name: string): void {
        delete this.#functions[name];
    }
    getFunction<T extends (...args: PlainParameter[]) => Promise<PlainParameter | void>>(name: string): T | null {
        const func = this.#functions[name];
        return func ? (func as T) : null;
    }
    hasFunction(name: string): boolean {
        return name in this.#functions;
    }
    async callRemote(method: string, params: PlainParameter[]): Promise<PlainParameter> {
        if (!this.#transport) throw new Error("Transport not set");
        const id = this.#genId();
        this.#transport.send({id, type: "call", method, params: params.map(p => this.#handleOutgoingArg(p))});
        this.#createPromise(id);
        try {
            const result = await this.#promises[id][0]; // SystemLinkParameter
            return this.#systemLinkToPlain(result);
        } finally {
            this.#deletePromise(id);
        }
    }
    
}