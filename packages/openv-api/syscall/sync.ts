import { SystemComponent } from "./component";

export type SYNC_NS = "party.openv.sync";
export type SYNC_NS_VERSIONED = `${SYNC_NS}/0.1.0`;

type Callable = (...args: any[]) => any;

type FunctionFilter<T> = {
  [K in keyof T]: T[K] extends Callable ? K : never;
}[keyof T];

type ComponentMethod<C extends SystemComponent<any, any>, M extends FunctionFilter<C>> = Extract<C[M], Callable>;

// Reference to a memory section in the ring buffer. All offsets and lengths
// are relative to the start of the ring buffer, not absolute memory addresses.
export type RingView = {
    // Start index of buffer
    head: number;
    // End index of buffer (1 past the last byte)
    tail: number;
};

// Shared signal SAB layout (Int32Array view):
// [0] state flag (0 idle, 1 request ready, 2 response ready) and used for waiting/notifying
// [1] sabId The ID of the buuffer assigned by the handler before the response is ready.
//     This buffer id can be reused in future calls to avoid the overhead of creating new SABs.
// [2] response kind code (1 JSON OK, 2 JSON error, 3 buffer OK)
export type MetaView = {
    stateIndex: 0;
    sabId: 1
    responseKindIndex: 2;
    _padding: 3; // keep a 4-byte alignment for potential future extensions
};

// full sab layout:
// [MetaView (Int32Array view)]
// [RingView for response]
// [... remaining space is the ring buffer for arguments and response data]


export type SyncCallBlockingReturnKindCode = 1 | 2;

export type SyncCallBlockingArgPlain<T = unknown> = {
  format: "plain";
  value: T;
};

export type SyncCallBlockingArgPointer = {
  format: "pointer";
  kind: number; // 1 for JSON, 2 reserved, 3 for buffer
  ptr: RingView;
};

export type SyncCallBlockingOptArg<T = unknown> = SyncCallBlockingArgPlain<T> | SyncCallBlockingArgPointer;

type SyncCallBlockingOptArgs<T extends readonly unknown[]> = {
  [I in keyof T]: SyncCallBlockingOptArg<T[I]>;
};

export interface SyncComponent extends SystemComponent<SYNC_NS_VERSIONED, SYNC_NS> {
    ["party.openv.sync.createBuffer"](size: number): Promise<number>;
    ["party.openv.sync.destroyBuffer"](id: number): Promise<void>;
    ["party.openv.sync.getBuffer"](id: number): Promise<SharedArrayBuffer>;

    ["party.openv.filesystem.sync.callBlocking"]<C extends SystemComponent<any, any>, M extends FunctionFilter<C>>(
        method: M,
        sab: SharedArrayBuffer | number,
        destroy: boolean,
        ...args: SyncCallBlockingOptArgs<Parameters<ComponentMethod<C, M>>>
    ): Promise<void>;
}