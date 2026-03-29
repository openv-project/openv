import {
  FileSystemCoreComponent,
  FileSystemPipeComponent,
  FileSystemReadOnlyComponent,
  FileSystemReadWriteComponent,
  ProcessComponent,
} from "@openv-project/openv-api";
import {
  ClientOpEnv,
  CoreFSExt,
  CoreProcessExt,
  ProcessScopedFS,
  ProcessScopedProcess,
  ProcessScopedRegistry,
  createPostMessageTransport,
  registerWebExecutor,
} from "@openv-project/openv-core";

const CHANNEL = "openv-sw-channel";
const controller = navigator.serviceWorker.controller;
if (!controller) {
  throw new Error("No service worker controller available");
}

const localEndpoint = {
  postMessage(_msg: unknown) {},
  addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
    navigator.serviceWorker.addEventListener("message", handler);
  },
  removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
    navigator.serviceWorker.removeEventListener("message", handler);
  },
};

const remoteEndpoint = {
  postMessage(msg: unknown) {
    controller.postMessage(msg);
  },
};

const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, CHANNEL);
const openv = new ClientOpEnv<
  FileSystemCoreComponent &
    FileSystemReadOnlyComponent &
    FileSystemReadWriteComponent &
    FileSystemPipeComponent &
    CoreFSExt &
    ProcessComponent &
    CoreProcessExt
>(transport);

await openv.enumerateRemote();
(globalThis as any).openv = openv;

await registerWebExecutor(openv.system, async (ctx) => {
  const scopedFs = new ProcessScopedFS(ctx.pid, openv.system as any);
  if (ctx.stdioOfds) {
    for (let i = 0; i < ctx.stdioOfds.length; i++) {
      const ofd = ctx.stdioOfds[i];
      if (ofd !== undefined) {
        await scopedFs["party.openv.filesystem.local.setfd"](i, ofd);
      }
    }
  }

  const scopedRegistry = new ProcessScopedRegistry(ctx.pid, openv.system as any);
  const scopedProcess = new ProcessScopedProcess(ctx.pid, openv.system as any);

  const exports: Record<string, Function> = {};
  for (const scoped of [scopedFs, scopedProcess, scopedRegistry]) {
    let proto = Object.getPrototypeOf(scoped);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || name === "supports" || exports[name]) continue;
        const value = (scoped as any)[name];
        if (typeof value === "function") exports[name] = value.bind(scoped);
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
  return exports;
});