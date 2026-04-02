import type { SystemLinkPeer, PlainParameter, SystemLinkMessage, SystemLinkTransport, SystemLinkParameter } from "@openv-project/openv-api";

export type StoredPromise<T> = [Promise<T>, (value: T) => void, (reason?: any) => void];

export type StreamSink = {
    push: (value: SystemLinkParameter) => void;
    close: () => void;
    error: (err: string) => void;
};

function maybeTypedArrayLikeObject(value: unknown): Uint8Array | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    const length = obj.length;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 50_000_000) {
        return null;
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        const n = obj[String(i)];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 255) {
            return null;
        }
        out[i] = n;
    }
    return out;
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
    switch (Object.prototype.toString.call(value)) {
        case "[object ArrayBuffer]":
        case "[object SharedArrayBuffer]":
            return true;
        default:
            return false;
    }
}

function isBlobLike(value: unknown): value is Blob {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

function isBinaryLike(value: unknown): boolean {
    return isArrayBufferLike(value) || ArrayBuffer.isView(value as any) || isBlobLike(value);
}

function isDirectoryHandle(handle: unknown): handle is FileSystemDirectoryHandle {
    return !!(
        handle &&
        typeof handle === 'object' &&
        (handle as any).kind === 'directory' &&
        typeof (handle as any).getDirectoryHandle === 'function' &&
        typeof (handle as any).getFileHandle === 'function'
    );
}

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
        if (arg === undefined) {
            return undefined;
        }
        if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean" || arg === null || isDirectoryHandle(arg)) {
            return { literal: arg };
        }
        if (isBinaryLike(arg)) {
            return { literal: arg as any };
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

            const peer = this;
            const iterable: AsyncIterable<SystemLinkParameter> = {
                [Symbol.asyncIterator]() {
                    return {
                        next(): Promise<IteratorResult<SystemLinkParameter>> {
                            const consume = (): Promise<IteratorResult<SystemLinkParameter>> => {
                                if (queue.length > 0) {
                                    const item = queue.shift()!;
                                    if (item.done) {
                                        return Promise.resolve({ value: undefined as any, done: true });
                                    }
                                    if (item.err) {
                                        return Promise.reject(new Error(item.err));
                                    }
                                    return Promise.resolve({ value: item.value as SystemLinkParameter, done: false });
                                }
                                return new Promise<IteratorResult<SystemLinkParameter>>((res, rej) => {
                                    notify = () => {
                                        notify = null;
                                        consume().then(res, rej);
                                    };
                                });
                            };
                            return consume();
                        },
                        return(): Promise<IteratorResult<SystemLinkParameter>> {
                            delete (this as any).#streams?.[streamId];
                            return Promise.resolve({ value: undefined as any, done: true });
                        }
                    };
                }
            };

            return {
                [Symbol.asyncIterator]() {
                    const inner = iterable[Symbol.asyncIterator]();
                    return {
                        async next(): Promise<IteratorResult<PlainParameter>> {
                            const result = await inner.next();
                            if (result.done) return { value: undefined as any, done: true };
                            return Promise.resolve({
                                value: peer.#systemLinkToPlain(result.value),
                                done: false
                            }) as Promise<IteratorResult<PlainParameter>>;
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
            if (typeof lit === "string" || typeof lit === "number" || typeof lit === "boolean" || lit === null || isDirectoryHandle(lit)) {
                return lit as PlainParameter;
            }
            if (isBinaryLike(lit)) {
                return lit as PlainParameter;
            }
            const recoveredBytes = maybeTypedArrayLikeObject(lit);
            if (recoveredBytes) {
                return recoveredBytes;
            }
            if (Array.isArray(lit)) {
                return lit.map(item => this.#systemLinkToPlain(item)) as PlainParameter;
            }
            if (typeof lit === "object") {
                const obj: Record<string, PlainParameter> = {};
                for (const [k, v] of Object.entries(lit)) {
                    obj[k] = this.#systemLinkToPlain(v as SystemLinkParameter);
                }
                return obj as PlainParameter;
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
            if (message.success) {
                const value = message.ok as SystemLinkParameter;
                this.#resolvePromise(message.id, value);
            } else {
                this.#rejectPromise(message.id, new Error(message.err));
            }
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

    #rejectPromise(id: number, reason: unknown): void {
        if (!this.#promises[id]) this.#createPromise(id);
        const promise = this.#promises[id];
        promise[2](reason);
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