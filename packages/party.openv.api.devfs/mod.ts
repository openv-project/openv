import type {
  API,
  CharacterDeviceInfo,
  CharacterDeviceRegistration,
  FileSystemDevFsComponent,
  FileSystemIoctlComponent,
  OpEnv,
  PlainParameter,
} from "@openv-project/openv-api";

type DevFsSystem = FileSystemDevFsComponent & FileSystemIoctlComponent;
type DevFsOpEnv = OpEnv<DevFsSystem>;

export default class DevFsApi implements API<"party.openv.api.devfs"> {
  name = "party.openv.api.devfs" as const;
  openv!: DevFsOpEnv;

  async initialize(openv: DevFsOpEnv): Promise<void> {
    this.openv = openv;
    if (!await this.openv.system.supports("party.openv.filesystem.devfs")) {
      throw new Error("DevFS is not supported in this environment.");
    }
  }

  async registerCharacterDevice(path: string, device: CharacterDeviceRegistration): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.devfs")) {
      throw new Error("DevFS is not supported in this environment.");
    }
    if (device.type !== "character") {
      throw new Error("Only character devices are supported by this API.");
    }
    const info: CharacterDeviceInfo = {
      type: "character",
      mode: device.mode,
      uid: device.uid,
      gid: device.gid,
    };
    await this.openv.system["party.openv.filesystem.devfs.register"](path, info);
    if (device.open) {
      await this.openv.system["party.openv.filesystem.devfs.onopen"](path, device.open);
    }
    if (device.close) {
      await this.openv.system["party.openv.filesystem.devfs.onclose"](path, device.close);
    }
    if (device.read) {
      await this.openv.system["party.openv.filesystem.devfs.onread"](path, device.read);
    }
    if (device.write) {
      await this.openv.system["party.openv.filesystem.devfs.onwrite"](path, device.write);
    }
    if (device.ioctl) {
      await this.openv.system["party.openv.filesystem.devfs.onioctl"](path, device.ioctl);
    }
  }

  async unregisterDevice(path: string): Promise<void> {
    if (!await this.openv.system.supports("party.openv.filesystem.devfs")) {
      throw new Error("DevFS is not supported in this environment.");
    }
    await this.openv.system["party.openv.filesystem.devfs.unregister"](path);
  }

  async listDevices(): Promise<string[]> {
    if (!await this.openv.system.supports("party.openv.filesystem.devfs")) {
      throw new Error("DevFS is not supported in this environment.");
    }
    return this.openv.system["party.openv.filesystem.devfs.list"]();
  }

  async ioctl(fd: number, request: string, argument?: PlainParameter): Promise<PlainParameter> {
    if (!await this.openv.system.supports("party.openv.filesystem.ioctl")) {
      throw new Error("Filesystem ioctl is not supported in this environment.");
    }
    return this.openv.system["party.openv.filesystem.ioctl.ioctl"](fd, request, argument);
  }
}
