import type { SystemLinkPeer, PlainParameter, SystemLinkMessage, SystemLinkTransport, SystemLinkParameter } from "@openv-project/openv-api";

export type StoredPromise<T> = [Promise<T>, (value: T) => void, (reason?: any) => void];

export type StreamSink = {
    push: (value: SystemLinkParameter) => void;
    close: () => void;
    error: (err: string) => void;
};

export class CoreSystemLinkPeer implements SystemLinkPeer {
    #functions: Record<string, (...args: PlainParameter[]) => Promise<PlainParameter | void>> = {};
    #transport: SystemLinkTransport | null = null;
    #promises: Record<number, StoredPromise<SystemLinkParameter>> = {};
    #streams: Record<number, StreamSink> = {};
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
        if (
            arg instanceof Uint8Array ||
            arg instanceof Uint8ClampedArray ||
            arg instanceof Uint16Array ||
            arg instanceof Uint32Array ||
            arg instanceof Int8Array ||
            arg instanceof Int16Array ||
            arg instanceof Int32Array ||
            arg instanceof Float32Array ||
            arg instanceof Float64Array ||
            arg instanceof BigInt64Array ||
            arg instanceof BigUint64Array ||
            arg instanceof ArrayBuffer ||
            arg instanceof DataView ||
            arg instanceof Blob
        ) {
            return { literal: arg };
        }
        if (Array.isArray(arg)) {
            return { literal: arg.map(item => this.#handleOutgoingArg(item)) };
        }
        if (arg !== null && typeof arg === "object" && Symbol.asyncIterator in arg) {
            const streamId = this.#genId();
            // Pump the iterable in the background
            (async () => {
                try {
                    for await (const value of arg as AsyncIterable<PlainParameter>) {
                        await this.#transport?.send({
                            id: streamId,
                            type: "stream",
                            value: this.#handleOutgoingArg(value)
                        });
                    }
                    await this.#transport?.send({
                        id: streamId,
                        type: "stream",
                        done: true
                    });
                } catch (e) {
                    await this.#transport?.send({
                        id: streamId,
                        type: "stream",
                        err: e instanceof Error ? e.message : String(e)
                    });
                } finally {
                    this.#usedIds.delete(streamId);
                }
            })();
            return { stream: streamId };
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
            this.storeFunction(methodId, async (...plainArgs: PlainParameter[]) => {
                const res = await (arg as (...args: PlainParameter[]) => Promise<PlainParameter | void>)(...plainArgs);
                return res;
            });
            return { method: methodId };
        }
        if (arg === undefined) {
            return undefined;
        }
        throw new Error(`Unsupported argument type: ${typeof arg}`);
    }

    #systemLinkToPlain(param: SystemLinkParameter): PlainParameter {
        if (param === undefined) return undefined as any;
        if ("stream" in param) {
            const streamId = param.stream;
            // Build an AsyncIterable backed by a queue fed by incoming stream messages
            const queue: Array<{ value?: SystemLinkParameter; done?: boolean; err?: string }> = [];
            let notify: (() => void) | null = null;

            this.#streams[streamId] = {
                push: (value: SystemLinkParameter) => {
                    queue.push({ value });
                    notify?.();
                },
                close: () => {
                    queue.push({ done: true });
                    notify?.();
                },
                error: (err: string) => {
                    queue.push({ err });
                    notify?.();
                }
            };

            const iterable: AsyncIterable<PlainParameter> = {
                [Symbol.asyncIterator]() {
                    return {
                        next(): Promise<IteratorResult<PlainParameter>> {
                            const consume = (): Promise<IteratorResult<PlainParameter>> => {
                                if (queue.length > 0) {
                                    const item = queue.shift()!;
                                    if (item.done) {
                                        return Promise.resolve({ value: undefined, done: true });
                                    }
                                    if (item.err) {
                                        return Promise.reject(new Error(item.err));
                                    }
                                    return Promise.resolve({ value: item.value, done: false });
                                }
                                return new Promise<IteratorResult<PlainParameter>>((res, rej) => {
                                    notify = () => {
                                        notify = null;
                                        consume().then(res, rej);
                                    };
                                });
                            };
                            return consume();
                        },
                        return(): Promise<IteratorResult<PlainParameter>> {
                            delete (this as any).#streams?.[streamId];
                            return Promise.resolve({ value: undefined, done: true });
                        }
                    };
                }
            };

            const peer = this;
            return {
                [Symbol.asyncIterator]() {
                    const inner = iterable[Symbol.asyncIterator]();
                    return {
                        async next(): Promise<IteratorResult<PlainParameter>> {
                            const result = await inner.next();
                            if (result.done) return { value: undefined, done: true };
                            // result.value is still a raw SystemLinkParameter here
                            return {
                                value: peer.#systemLinkToPlain(result.value as SystemLinkParameter),
                                done: false
                            };
                        },
                        return(): Promise<IteratorResult<PlainParameter>> {
                            delete peer.#streams[streamId];
                            return Promise.resolve({ value: undefined, done: true });
                        }
                    };
                }
            };
        }
        if ("literal" in param) {
            const lit = param.literal;
            if (typeof lit === "string" || typeof lit === "number" || typeof lit === "boolean" || lit === null) {
                return lit;
            }
            if (
                lit instanceof Uint8Array ||
                lit instanceof Uint8ClampedArray ||
                lit instanceof Uint16Array ||
                lit instanceof Uint32Array ||
                lit instanceof Int8Array ||
                lit instanceof Int16Array ||
                lit instanceof Int32Array ||
                lit instanceof Float32Array ||
                lit instanceof Float64Array ||
                lit instanceof BigInt64Array ||
                lit instanceof BigUint64Array ||
                lit instanceof ArrayBuffer ||
                lit instanceof DataView ||
                lit instanceof Blob
            ) {
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
        }
        if ("method" in param) {
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
        if (message.type === "enumerate") {
            await this.#transport?.send({
                id: message.id,
                type: "enumerate_response",
                methods: Object.keys(this.#functions),
            });
            return;
        }

        if (message.type === "enumerate_response") {
            this.#resolvePromise(message.id, { literal: message.methods as any });
            return;
        }

        if (message.type === "stream") {
            const sink = this.#streams[message.id];
            if (!sink) return; // stream was abandoned
            if (message.err) {
                sink.error(message.err);
                delete this.#streams[message.id];
            } else if (message.done) {
                sink.close();
                delete this.#streams[message.id];
            } else {
                sink.push(message.value);
            }
            return;
        }

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
            } else {
                const response: SystemLinkMessage = {
                    id: message.id,
                    type: "response",
                    success: false,
                    err: `Method not found: ${message.method}`
                };
                this.#transport?.send(response);
            }
        } else if (message.type === "response") {
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
        this.#transport.send({ id, type: "call", method, params: params.map(p => this.#handleOutgoingArg(p)) });
        this.#createPromise(id);
        try {
            const result = await this.#promises[id][0];
            return this.#systemLinkToPlain(result);
        } finally {
            this.#deletePromise(id);
        }
    }

    async enumerateRemote(): Promise<string[]> {
        if (!this.#transport) throw new Error("Transport not set");
        const id = this.#genId();
        this.#createPromise(id);
        await this.#transport.send({ id, type: "enumerate" });
        try {
            const result = await this.#promises[id][0];
            return (result as any).literal as string[];
        } finally {
            this.#deletePromise(id);
        }
    }
}