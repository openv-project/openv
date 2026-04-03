import type {
    MetaView,
    RingView,
    SYNC_NS,
    SYNC_NS_VERSIONED,
    SyncCallBlockingOptArg,
    SyncComponent,
    SystemComponent,
} from "@openv-project/openv-api";

type Dispatch = (method: string) => ((...args: any[]) => unknown | Promise<unknown>) | null;
type Callable = (...args: any[]) => any;
type FunctionFilter<T> = {
    [K in keyof T]: T[K] extends Callable ? K : never;
}[keyof T];
type ComponentMethod<C extends SystemComponent<any, any>, M extends FunctionFilter<C>> = Extract<C[M], Callable>;
type SyncCallBlockingOptArgs<T extends readonly unknown[]> = {
    [I in keyof T]: SyncCallBlockingOptArg<T[I]>;
};

const META_INTS = 4;
const RESPONSE_RING_VIEW_INTS = 2;
const HEADER_INTS = META_INTS + RESPONSE_RING_VIEW_INTS;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const BUFFER_RETURN_POINTER_INTS = 2;
const BUFFER_RETURN_POINTER_BYTES = BUFFER_RETURN_POINTER_INTS * Int32Array.BYTES_PER_ELEMENT;

const STATE_REQUEST_READY = 1;
const STATE_RESPONSE_READY = 2;

const RESPONSE_KIND_JSON_OK = 1;
const RESPONSE_KIND_JSON_ERROR = 2;
const RESPONSE_KIND_BUFFER_OK = 3;

export class CoreSyncComponent implements SyncComponent {
    // future: back buffers by /dev/shm files for better debugging and portability
    #buffers: Map<number, SharedArrayBuffer> = new Map();
    #bufferIds: WeakMap<SharedArrayBuffer, number> = new WeakMap();
    #nextBufferId = 1;
    #dispatch: Dispatch;

    constructor(dispatch?: Dispatch) {
        this.#dispatch = dispatch ?? (() => null);
    }

    async supports(ns: SYNC_NS | SYNC_NS_VERSIONED): Promise<SYNC_NS_VERSIONED>;
    async supports(ns: string): Promise<string | null> {
        if (ns === "party.openv.sync" || ns === "party.openv.sync/0.1.0") {
            return "party.openv.sync/0.1.0";
        }
        return null;
    }

    async ["party.openv.sync.createBuffer"](size: number): Promise<number> {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error("size must be a positive integer");
        }
        const id = this.#nextBufferId++;
        const sab = new SharedArrayBuffer(size);
        this.#buffers.set(id, sab);
        this.#bufferIds.set(sab, id);
        return id;
    }

    async ["party.openv.sync.destroyBuffer"](id: number): Promise<void> {
        const sab = this.#buffers.get(id);
        if (sab) {
            this.#bufferIds.delete(sab);
        }
        this.#buffers.delete(id);
    }

    async ["party.openv.sync.getBuffer"](id: number): Promise<SharedArrayBuffer> {
        const sab = this.#buffers.get(id);
        if (!sab) throw new Error(`Buffer with id ${id} not found`);
        return sab;
    }

    async ["party.openv.filesystem.sync.callBlocking"]<C extends SystemComponent<any, any>, M extends FunctionFilter<C>>(
        method: M,
        sabOrId: SharedArrayBuffer | number,
        destroy: boolean,
        ...args: SyncCallBlockingOptArgs<Parameters<ComponentMethod<C, M>>>
    ): Promise<void> {
        const sab = typeof sabOrId === "number" ? await this["party.openv.sync.getBuffer"](sabOrId) : sabOrId;
        if (sab.byteLength < HEADER_BYTES) {
            throw new Error(`SharedArrayBuffer too small, expected at least ${HEADER_BYTES} bytes`);
        }

        const meta = new Int32Array(sab, 0, META_INTS);
        const responseView = new Int32Array(sab, META_INTS * Int32Array.BYTES_PER_ELEMENT, RESPONSE_RING_VIEW_INTS);
        const ringBytes = new Uint8Array(sab, HEADER_BYTES);

        let responseKind = RESPONSE_KIND_JSON_OK;
        let responsePayload: Uint8Array = new Uint8Array(0);

        let destroyId: number | undefined;
        let shouldDestroy = false;
        try {
            const resolvedArgs = args.map((arg) => this.#resolveArg(arg, ringBytes));
            const methodName = String(method);
            const fn = this.#dispatch(methodName);
            if (!fn) {
                throw new Error(`No handler registered for method ${methodName}`);
            }

            const result = await fn(...resolvedArgs);
            if (result instanceof Uint8Array) {
                responseKind = RESPONSE_KIND_BUFFER_OK;
                responsePayload = Uint8Array.from(result);
            } else if (ArrayBuffer.isView(result)) {
                responseKind = RESPONSE_KIND_BUFFER_OK;
                responsePayload = Uint8Array.from(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
            } else if (result instanceof ArrayBuffer) {
                responseKind = RESPONSE_KIND_BUFFER_OK;
                responsePayload = new Uint8Array(result);
            } else {
                responseKind = RESPONSE_KIND_JSON_OK;
                responsePayload = new TextEncoder().encode(JSON.stringify(result ?? null));
            }
        } catch (error) {
            responseKind = RESPONSE_KIND_JSON_ERROR;
            const err = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
            responsePayload = new TextEncoder().encode(JSON.stringify(err));
        }

        if (responsePayload.byteLength > ringBytes.byteLength) {
            responseKind = RESPONSE_KIND_JSON_ERROR;
            responsePayload = new TextEncoder().encode(JSON.stringify({ message: "response too large for SAB ring" }));
            if (responsePayload.byteLength > ringBytes.byteLength) {
                throw new Error("response too large for SAB ring");
            }
        }

        ringBytes.fill(0);
        if (responseKind === RESPONSE_KIND_BUFFER_OK) {
            if (responsePayload.byteLength + BUFFER_RETURN_POINTER_BYTES > ringBytes.byteLength) {
                throw new Error("buffer response too large for SAB ring");
            }

            const returnPointer = new Int32Array(sab, HEADER_BYTES, BUFFER_RETURN_POINTER_INTS);
            returnPointer[0] = BUFFER_RETURN_POINTER_BYTES;
            returnPointer[1] = BUFFER_RETURN_POINTER_BYTES + responsePayload.byteLength;
            ringBytes.set(responsePayload, BUFFER_RETURN_POINTER_BYTES);
            responseView[0] = 0;
            responseView[1] = BUFFER_RETURN_POINTER_BYTES + responsePayload.byteLength;
        } else {
            ringBytes.set(responsePayload, 0);
            responseView[0] = 0;
            responseView[1] = responsePayload.byteLength;
        }

        const existingId = this.#bufferIds.get(sab);
        if (existingId !== undefined) {
            meta[1] = existingId;
        }
        meta[2] = responseKind;
        Atomics.store(meta, 0, STATE_RESPONSE_READY);
        Atomics.notify(meta, 0, 1);

        if (destroy) {
            destroyId = typeof sabOrId === "number" ? sabOrId : this.#bufferIds.get(sab);
            shouldDestroy = true;
        }

        if (shouldDestroy && destroyId !== undefined) {
            await this["party.openv.sync.destroyBuffer"](destroyId);
        }
    }

    #resolveArg(arg: SyncCallBlockingOptArg, ringBytes: Uint8Array): unknown {
        if (arg.format === "plain") {
            return arg.value;
        }

        const bytes = this.#readRingSlice(arg.ptr, ringBytes);
        if (arg.kind === 3) {
            // Return a copy so target handlers can mutate without touching SAB directly.
            return new Uint8Array(bytes);
        }
        if (arg.kind === 1) {
            const text = new TextDecoder().decode(bytes);
            return JSON.parse(text);
        }
        throw new Error(`Unsupported pointer kind ${arg.kind}`);
    }

    #readRingSlice(ptr: RingView, ringBytes: Uint8Array): Uint8Array {
        const head = ptr.head | 0;
        const tail = ptr.tail | 0;
        if (head < 0 || tail < head || tail > ringBytes.byteLength) {
            throw new Error(`Invalid RingView range [${head}, ${tail}) for ring length ${ringBytes.byteLength}`);
        }
        return ringBytes.slice(head, tail);
    }


}
