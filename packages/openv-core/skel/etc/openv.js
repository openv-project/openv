// OpEnv Userspace v0.1.0
// OpEnv Programming Entrypoint
// This file is the standard entry point for accessing the
// OpEnv system regardless of the distribution or execution
// environment. This is both a sort of configuration file and
// a library at the same time.
// Exports: getOpEnv() -> Promise<OpEnv>

import { connect } from "/@/lib/openv/openv-core/mod.js";
export async function getOpEnv() {
    return await connect();
}