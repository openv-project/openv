import { API, OpEnv, RingView, SyncCallBlockingOptArg, SyncComponent, SystemComponent } from "@openv-project/openv-api";

type Callable = (...args: any[]) => any;
type FunctionFilter<T> = {
  [K in keyof T]: T[K] extends Callable ? K : never;
}[keyof T];
type ComponentMethod<C extends SystemComponent<any, any>, M extends FunctionFilter<C>> = Extract<C[M], Callable>;

const META_INTS = 4;
const RESPONSE_RING_VIEW_INTS = 2;
const HEADER_INTS = META_INTS + RESPONSE_RING_VIEW_INTS;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

const STATE_IDLE = 0;
const STATE_REQUEST_READY = 1;
const STATE_RESPONSE_READY = 2;

const RESPONSE_KIND_JSON_OK = 1;
const RESPONSE_KIND_JSON_ERROR = 2;
const RESPONSE_KIND_BUFFER_OK = 3;
const BUFFER_RETURN_POINTER_BYTES = 8;

type BinaryLike = Uint8Array | ArrayBuffer | ArrayBufferView;

export type SyncBlockingClientOptions = {
  bufferSize?: number;
  timeoutMs?: number | null;
  reuseBuffer?: boolean;
};

type NormalizedOptions = {
  bufferSize: number;
  timeoutMs: number | null;
  reuseBuffer: boolean;
};

const DEFAULT_OPTIONS: NormalizedOptions = {
  bufferSize: 64 * 1024,
  timeoutMs: 30_000,
  reuseBuffer: true,
};

function normalizeOptions(options?: SyncBlockingClientOptions): NormalizedOptions {
  const merged: NormalizedOptions = {
    bufferSize: options?.bufferSize ?? DEFAULT_OPTIONS.bufferSize,
    timeoutMs: options && Object.prototype.hasOwnProperty.call(options, "timeoutMs")
      ? (options.timeoutMs ?? null)
      : DEFAULT_OPTIONS.timeoutMs,
    reuseBuffer: options?.reuseBuffer ?? DEFAULT_OPTIONS.reuseBuffer,
  };
  if (!Number.isInteger(merged.bufferSize) || merged.bufferSize <= HEADER_BYTES) {
    throw new Error(`bufferSize must be an integer greater than ${HEADER_BYTES}`);
  }
  if (merged.timeoutMs !== null && (!Number.isInteger(merged.timeoutMs) || merged.timeoutMs < 0)) {
    throw new Error("timeoutMs must be null or a non-negative integer");
  }
  return merged;
}

function asUint8Array(data: BinaryLike): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isBinaryLike(value: unknown): value is BinaryLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

type EncodedArg = {
  arg: SyncCallBlockingOptArg;
  nextOffset: number;
};

function writeRingBytes(ring: Uint8Array, at: number, bytes: Uint8Array): RingView {
  const head = at;
  const tail = head + bytes.byteLength;
  if (tail > ring.byteLength) {
    throw new Error(`SAB argument ring overflow: need ${tail} bytes, have ${ring.byteLength}`);
  }
  ring.set(bytes, head);
  return { head, tail };
}

function encodeArg(arg: unknown, ring: Uint8Array, at: number): EncodedArg {
  if (typeof arg === "object" && arg !== null && "format" in (arg as Record<string, unknown>)) {
    const wrapped = arg as SyncCallBlockingOptArg;
    if (wrapped.format === "pointer" || wrapped.format === "plain") {
      return { arg: wrapped, nextOffset: at };
    }
  }

  if (isBinaryLike(arg)) {
    const bytes = asUint8Array(arg);
    const ptr = writeRingBytes(ring, at, bytes);
    return {
      arg: { format: "pointer", kind: RESPONSE_KIND_BUFFER_OK, ptr },
      nextOffset: ptr.tail,
    };
  }

  return {
    arg: { format: "plain", value: arg },
    nextOffset: at,
  };
}

function parseResponse(meta: Int32Array, responseView: Int32Array, ring: Uint8Array): unknown {
  const head = responseView[0] | 0;
  const tail = responseView[1] | 0;
  if (head < 0 || tail < head || tail > ring.byteLength) {
    throw new Error(`Invalid response ring view [${head}, ${tail})`);
  }

  const payload = ring.slice(head, tail);
  const kind = meta[2] | 0;
  if (kind === RESPONSE_KIND_BUFFER_OK) {
    if (payload.byteLength < BUFFER_RETURN_POINTER_BYTES) {
      return new Uint8Array(0);
    }

    const pointer = new Int32Array(payload.buffer, payload.byteOffset, 2);
    const bufferHead = pointer[0] | 0;
    const bufferTail = pointer[1] | 0;
    if (bufferHead < 0 || bufferTail < bufferHead || bufferTail > ring.byteLength) {
      throw new Error(`Invalid buffer return pointer [${bufferHead}, ${bufferTail})`);
    }
    return ring.slice(bufferHead, bufferTail);
  }

  const text = new TextDecoder().decode(payload);
  const parsed = text.length === 0 ? null : JSON.parse(text);
  if (kind === RESPONSE_KIND_JSON_ERROR) {
    if (parsed && typeof parsed === "object" && "message" in (parsed as Record<string, unknown>)) {
      throw new Error(String((parsed as Record<string, unknown>).message));
    }
    throw new Error("blocking sync call returned an error");
  }
  return parsed;
}

export class SyncBlockingClient {
  #sync: SyncComponent;
  #options: NormalizedOptions;
  #bufferId: number | null;
  #sab: SharedArrayBuffer;
  #meta: Int32Array;
  #responseView: Int32Array;
  #ring: Uint8Array;
  #closed = false;

  private constructor(sync: SyncComponent, options: NormalizedOptions, bufferId: number | null, sab: SharedArrayBuffer) {
    this.#sync = sync;
    this.#options = options;
    this.#bufferId = bufferId;
    this.#sab = sab;
    this.#meta = new Int32Array(sab, 0, META_INTS);
    this.#responseView = new Int32Array(sab, META_INTS * Int32Array.BYTES_PER_ELEMENT, RESPONSE_RING_VIEW_INTS);
    this.#ring = new Uint8Array(sab, HEADER_BYTES);
  }

  static async create(sync: SyncComponent, options?: SyncBlockingClientOptions): Promise<SyncBlockingClient> {
    const normalized = normalizeOptions(options);
    let bufferId: number | null = null;
    let sab: SharedArrayBuffer | null = null;

    try {
      bufferId = await sync["party.openv.sync.createBuffer"](normalized.bufferSize);
      const candidate = await sync["party.openv.sync.getBuffer"](bufferId);
      if (candidate instanceof SharedArrayBuffer && candidate.byteLength >= HEADER_BYTES) {
        sab = candidate;
      } else {
        await sync["party.openv.sync.destroyBuffer"](bufferId);
        bufferId = null;
      }
    } catch {
      bufferId = null;
    }

    if (!sab) {
      sab = new SharedArrayBuffer(normalized.bufferSize);
    }

    return new SyncBlockingClient(sync, normalized, bufferId, sab);
  }

  get bufferId(): number | null {
    return this.#bufferId;
  }

  get buffer(): SharedArrayBuffer {
    return this.#sab;
  }

  call<C extends SystemComponent<any, any>, M extends FunctionFilter<C> = FunctionFilter<C>>(
    method: M,
    ...args: Parameters<ComponentMethod<C, M>>
  ): Awaited<ReturnType<ComponentMethod<C, M>>> {
    if (this.#closed) throw new Error("SyncBlockingClient is closed");
    this.#assertLayout();

    this.#ring.fill(0);
    let next = 0;
    const encodedArgs: SyncCallBlockingOptArg[] = [];
    for (const arg of args as unknown[]) {
      const encoded = encodeArg(arg, this.#ring, next);
      encodedArgs.push(encoded.arg);
      next = encoded.nextOffset;
    }

    this.#responseView[0] = 0;
    this.#responseView[1] = 0;
    Atomics.store(this.#meta, 0, STATE_REQUEST_READY);

    const callBlocking = this.#sync["party.openv.filesystem.sync.callBlocking"] as (...callArgs: any[]) => Promise<void>;
    const request = callBlocking(
      method,
      this.#sab,
      !this.#options.reuseBuffer,
      ...encodedArgs,
    );

    const waitResult = this.#options.timeoutMs === null
      ? Atomics.wait(this.#meta, 0, STATE_REQUEST_READY)
      : Atomics.wait(this.#meta, 0, STATE_REQUEST_READY, this.#options.timeoutMs);
    if (waitResult === "timed-out") {
      throw new Error(`blocking sync call timed out after ${this.#options.timeoutMs}ms`);
    }
    if (Atomics.load(this.#meta, 0) !== STATE_RESPONSE_READY) {
      throw new Error(`unexpected sync state transition: ${Atomics.load(this.#meta, 0)}`);
    }

    const value = parseResponse(this.#meta, this.#responseView, this.#ring) as Awaited<ReturnType<ComponentMethod<C, M>>>;
    Atomics.store(this.#meta, 0, STATE_IDLE);

    void request.catch(() => {
      // The synchronous path already consumed the response envelope.
    });

    return value;
  }

  wrap<C extends SystemComponent<any, any>, M extends FunctionFilter<C>>(
    method: M,
  ): (...args: Parameters<ComponentMethod<C, M>>) => Awaited<ReturnType<ComponentMethod<C, M>>> {
    return (...args) => this.call<C, M>(method, ...args);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#bufferId !== null) {
      await this.#sync["party.openv.sync.destroyBuffer"](this.#bufferId);
    }
  }

  #assertLayout(): void {
    if (this.#meta.length < 1) {
      throw new Error("invalid sync SAB layout: meta view is too small");
    }
    if (this.#responseView.length < 2) {
      throw new Error("invalid sync SAB layout: response view is too small");
    }
  }
}

type CapableOpEnv = OpEnv<
  SyncComponent
>;

export default class SyncAPI implements API<"party.openv.api.sync"> {
  name = "party.openv.api.sync" as const;

  openv!: CapableOpEnv;

  async initialize(openv: CapableOpEnv): Promise<void> {
    this.openv = openv;
    if (!await this.openv.system.supports("party.openv.sync")) {
      throw new Error("ENOTSUP: sync component is not supported");
    }
  }

  async createBlockingClient(options?: SyncBlockingClientOptions): Promise<SyncBlockingClient> {
    return SyncBlockingClient.create(this.openv.system, options);
  }
}
