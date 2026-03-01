import type { OpEnv } from "../openv";

export interface API<T extends string = string> {
    name: T;
    initialize(openv: OpEnv<any>): Promise<void>;
}