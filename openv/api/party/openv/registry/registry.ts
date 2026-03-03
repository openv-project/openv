import type { RegistryReadComponent, RegistryWriteComponent, RegistryValue } from "../../../../syscall/index.ts";
import { REGISTRY_READ_NAMESPACE, REGISTRY_WRITE_NAMESPACE } from "../../../../syscall/index.ts";
import type { OpEnv } from "../../../../openv.ts";
import type { API } from "../../../api.ts";

export type RegKey = {
  default: RegistryValue | null;
  entries: Record<string, RegistryValue>;
  subkeys: Record<string, RegKey>;
}

// async optimization for serialization - allows for promises to be resolved in parallel
type UnresolvedRegKey = {
  default: Promise<RegistryValue | null>;
  entries: Promise<Record<string, Promise<RegistryValue>>>;
  subkeys: Promise<Record<string, UnresolvedRegKey>>;
}

export type RegistryFile = {
  meta: {
    key: string;
    format: "party.openv.registryapi.json";
  };
  root: RegKey | null;
}

export default class RegistryApi implements API<"party.openv.api.registry"> {

  name = "party.openv.api.registry" as const;

  openv!: OpEnv<RegistryReadComponent & RegistryWriteComponent>;

  async initialize(openv: OpEnv<RegistryReadComponent & RegistryWriteComponent>) {
    this.openv = openv;
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) {
      throw new Error("Registry is not supported in this environment.");
    }  
  }

  async readEntry(key: string, entry: string): Promise<RegistryValue | null> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.readEntry"] as any)(key, entry);
  }

  async readDefault(key: string): Promise<RegistryValue | null> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    console.log("Reading default value for key:", key);
    return await (this.openv.system["party.openv.registry.read.readDefault"] as any)(key);
  }

  async listEntries(key: string): Promise<string[] | null> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.listEntries"] as any)(key);
  }

  async listSubkeys(key: string): Promise<string[] | null> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.listSubkeys"] as any)(key);
  }

  async keyExists(key: string): Promise<boolean> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.keyExists"] as any)(key);
  }

  async watchEntry(key: string, entry: string): Promise<{
    changes: AsyncIterable<RegistryValue | null>;
    abort: () => Promise<void>;
  }> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.watchEntry"] as any)(key, entry);
  }

  async watchDefault(key: string): Promise<{
    changes: AsyncIterable<RegistryValue | null>;
    abort: () => Promise<void>;
  }> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    return await (this.openv.system["party.openv.registry.read.watchDefault"] as any)(key);
  }

  async writeEntry(key: string, entry: string, value: RegistryValue): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    await (this.openv.system["party.openv.registry.write.writeEntry"] as any)(key, entry, value);
  }

  async writeDefault(key: string, value: RegistryValue): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    await (this.openv.system["party.openv.registry.write.writeDefault"] as any)(key, value);
  }

  async deleteEntry(key: string, entry: string): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    await (this.openv.system["party.openv.registry.write.deleteEntry"] as any)(key, entry);
  }

  async deleteKey(key: string): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    await (this.openv.system["party.openv.registry.write.deleteKey"] as any)(key);
  }

  async createKey(key: string): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    await (this.openv.system["party.openv.registry.write.createKey"] as any)(key);
  }

  async #resolveRegKey(unresolved: UnresolvedRegKey): Promise<RegKey> {
    const [defaultValue, rawEntries, rawSubkeys] = await Promise.all([
      unresolved.default,
      unresolved.entries,
      unresolved.subkeys, 
    ]);
  
    const entries = await Promise.all(
      Object.entries(rawEntries).map(async ([k, v]) => [k, await v] as const)
    );
  
    const subkeys = await Promise.all(
      Object.entries(rawSubkeys).map(async ([k, v]) => [
        k,
        await this.#resolveRegKey(v)
      ] as const)
    );
  
    return {
      default: defaultValue,
      entries: Object.fromEntries(entries),
      subkeys: Object.fromEntries(subkeys),
    };
  }

  #serializeKey(key: string): UnresolvedRegKey {
    return {
      default: this.readDefault(key),
      entries: this.listEntries(key).then(entries => {
        if (!entries) return {};
        return Object.fromEntries(entries.map(entry => [entry, this.readEntry(key, entry) as Promise<RegistryValue>] as const));
      }),
      subkeys: this.listSubkeys(key).then(subkeys => {
        if (!subkeys) return {};
        return Object.fromEntries(subkeys.map(subkey => [subkey, this.#serializeKey(`${key}/${subkey}`)] as const));
      }),
    };
  }


  async serialize(key: string, space?: string | number): Promise<string> {
    if (!await this.openv.system.supports(REGISTRY_READ_NAMESPACE)) throw new Error("Registry is not supported in this environment.");

    if (!await this.openv.system["party.openv.registry.read.keyExists"](key)) {
      throw new Error(`Key ${key} does not exist.`);
    }
    
    const data: RegistryFile = {
      meta: {
        key,
        format: "party.openv.registryapi.json",
      },
      root: await this.#resolveRegKey(this.#serializeKey(key)),
    };

    return JSON.stringify(data, null, space);
  }

  async deserialize(data: string): Promise<void> {
    if (!await this.openv.system.supports(REGISTRY_WRITE_NAMESPACE)) throw new Error("Registry is not supported in this environment.");
    const parsed: RegistryFile = JSON.parse(data);
    if (parsed.meta.format !== "party.openv.registryapi.json") {
      throw new Error("Invalid registry file format.");
    }

    const writeKey = async (key: string, regKey: RegKey) => {
      await this.openv.system["party.openv.registry.write.createKey"](key);
      if (regKey.default !== null) {
        await this.writeDefault(key, regKey.default);
      }
      for (const [entry, value] of Object.entries(regKey.entries)) {
        await this.writeEntry(key, entry, value);
      }
      for (const [subkey, subRegKey] of Object.entries(regKey.subkeys)) {
        await writeKey(`${key}/${subkey}`, subRegKey);
      }
    };

    await writeKey(parsed.meta.key, parsed.root ?? { default: null, entries: {}, subkeys: {} });
  }
}
