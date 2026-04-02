import { FileSystemCoreComponent, FileSystemLocalComponent, FileSystemReadOnlyComponent, FileSystemReadWriteComponent, OpEnv, ProcessComponent, ProcessLocalComponent } from "@openv-project/openv-api";
import SyncAPI from "@openv-project/api-sync";
import { getOpEnv } from "/@/etc/openv.js";

const openv: OpEnv<ProcessLocalComponent & ProcessComponent & FileSystemLocalComponent & FileSystemCoreComponent & FileSystemReadOnlyComponent & FileSystemReadWriteComponent> = await getOpEnv();
openv.installAPI(new SyncAPI());

export default openv;