import type { Manifest } from "../types/manifest.js";

export async function parseManifest(data: string | null): Promise<Manifest | null> {
  if (!data) return null;
  
  try {
    const parsed = JSON.parse(data);
    return validateManifest(parsed);
  } catch (error) {
    throw new Error(`Failed to parse manifest: ${error}`);
  }
}

export function validateManifest(manifest: any): Manifest {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("Manifest must be an object");
  }
  
  if (manifest.name !== undefined && typeof manifest.name !== "string") {
    throw new Error("Manifest 'name' must be a string");
  }
  
  if (manifest.version !== undefined && typeof manifest.version !== "string") {
    throw new Error("Manifest 'version' must be a string");
  }
  
  if (manifest["upk-schema"] !== undefined && manifest["upk-schema"] !== "1") {
    console.warn(`Warning: Unknown UPK schema version: ${manifest["upk-schema"]}`);
  }
  
  return manifest as Manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}
