import type { OpEnv } from "./mod.ts";

export interface API<T extends string = string> {
    name: T;
    initialize(openv: OpEnv<any>): Promise<void>;
}