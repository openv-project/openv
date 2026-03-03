export type PlainParameter = string | number | boolean | { [key: string]: PlainParameter } | PlainParameter[] | ((...args: PlainParameter[]) => Promise<PlainParameter>) | void | null | undefined;

export type SystemLinkParameter = {
    literal: string | number | boolean | { [key: string]: SystemLinkParameter } | SystemLinkParameter[] | null;
} | {
    method: string;
} | undefined;

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

export type SystemLinkResponse = {
    type: "response";
} & (SystemLinkResponseSuccess | SystemLinkResponseFailure);

export type SystemLinkMessage = {
    id: number;
} & (SystemLinkCall | SystemLinkResponse);

export type SystemLinkTransport = {
    send(message: SystemLinkMessage): Promise<void>;
    onMessage(handler: (message: SystemLinkMessage) => Promise<void>): void;
    offMessage(handler: (message: SystemLinkMessage) => Promise<void>): void;
    start(): Promise<void>;
    isOpen(): boolean;
    close(): Promise<void>;
}