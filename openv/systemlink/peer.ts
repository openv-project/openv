import { PlainParameter, SystemLinkParameter } from "./wire";

export interface SystemLinkPeer {
    // function registry that has all the calls that this peer can handle.
    storeFunction<T extends (...args: PlainParameter[]) => Promise<PlainParameter | void>>(name: string, func: T): void;
    destroyFunction(name: string): void;
    getFunction<T extends (...args: PlainParameter[]) => Promise<PlainParameter | void>>(name: string): T | null;
    hasFunction(name: string): boolean;

    // Call a function
    callRemote(method: string, params: PlainParameter[]): Promise<PlainParameter>;
}