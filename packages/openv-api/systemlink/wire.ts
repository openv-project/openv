export type PlainParameter = string | number | boolean | { [key: string]: PlainParameter } | PlainParameter[] | ((...args: PlainParameter[]) => Promise<PlainParameter>) | AsyncIterable<PlainParameter> | BinaryData | void | FileSystemDirectoryEntry | null | undefined;

export type BinaryData =
    | Uint8Array
    | Uint8ClampedArray
    | Uint16Array
    | Uint32Array
    | Int8Array
    | Int16Array
    | Int32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array
    | ArrayBuffer
    | DataView
    | Blob;


export type SystemLinkParameter = {
    literal: string | number | boolean | { [key: string]: SystemLinkParameter } | SystemLinkParameter[] | BinaryData | FileSystemDirectoryHandle | null;
} | {
    method: string;
} | { stream: number }
    | undefined;

export type SystemLinkCall = {
    type: "call";
    method: string;
    params: SystemLinkParameter[];
}

export type SystemLinkResponseSuccess = {
    success: true;
    ok?: SystemLinkParameter;
}

export type SystemLinkResponseFailure = {
    success: false;
    err: string;
}

export type SystemLinkStreamChunk = {
    type: "stream";
    value?: SystemLinkParameter;
    done?: boolean;
    err?: string;
};

export type SystemLinkResponse = {
    type: "response";
} & (SystemLinkResponseSuccess | SystemLinkResponseFailure);

export type SystemLinkEnumerate = {
    type: "enumerate";
};

export type SystemLinkEnumerateResponse = {
    type: "enumerate_response";
    methods: string[];
};

export type SystemLinkMessage = {
    id: number;
} & (SystemLinkCall | SystemLinkResponse | SystemLinkStreamChunk | SystemLinkEnumerate | SystemLinkEnumerateResponse);

export type SystemLinkTransport = {
    send(message: SystemLinkMessage): Promise<void>;
    onMessage(handler: (message: SystemLinkMessage) => Promise<void>): void;
    offMessage(handler: (message: SystemLinkMessage) => Promise<void>): void;
    start(): Promise<void>;
    isOpen(): boolean;
    close(): Promise<void>;
}