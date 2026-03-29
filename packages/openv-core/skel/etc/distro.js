// OpEnv Userspace v0.1.0
// Distribution Config
// Processes can import this library to set up
// access to the OpEnv system components and
// use the built in API wrappers.
// Exports: configure(OpEnv?) -> Promise<OpEnv>

// Import the getOpEnv helper from the openv config.
import { getOpEnv } from "/@/etc/openv.js";

export async function configure(openv) {
    openv ||= await getOpEnv();
    // await openv.installAPI(...);
    return openv;
}
