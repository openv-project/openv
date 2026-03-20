import { ClientOpEnv, createPostMessageTransport } from "./mod";

export async function createOpEnv() {
    if (typeof self === "undefined" || typeof (self as any).addEventListener === "undefined") {
        throw new Error("not in a worker context");
    }
    const url = new URL(self.location.href);
    const pid = url.searchParams.get("pid")!;
    if (!pid) {
        throw new Error("missing pid query parameter");
    }
    const channel = `openv-process-${pid}`;

    const localEndpoint = {
        postMessage(_msg: any) { },
        addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            (self as any).addEventListener("message", handler);
        },
        removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            (self as any).removeEventListener("message", handler);
        },
    };

    const remoteEndpoint = {
        postMessage(msg: any) {
            (self as any).postMessage(msg);
        },
    };

    const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, channel);
    await transport.start();
    const openv = new ClientOpEnv(transport);
    await openv.enumerateRemote();
    return openv;
}