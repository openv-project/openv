export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  platform?: string;
  packager?: string;
  builddate?: number;
  size?: number;
  urls?: Record<string, string>;
  group?: string[];
  replace?: RelationValue[];
  depend?: RelationValue[];
  optdepend?: OptionalDependency[];
  makedepend?: RelationValue[];
  checkdepend?: RelationValue[];
  conflict?: RelationValue[];
  provides?: RelationValue[];
  backup?: string[];
  "upk-schema"?: string;
}

export type RelationValue = string;

export type OptionalDependency = string | {
  relation: string;
  reason: string;
};

export interface RelationParsed {
  target: string;
  operator?: "=" | "!=" | ">" | "<" | ">=" | "<=";
  version?: string;
}

export function parseRelation(relation: string): RelationParsed {
  const match = relation.match(/^([^=!<>]+)(([=!<>]+)(.+))?$/);
  if (!match) {
    throw new Error(`Invalid relation format: ${relation}`);
  }

  const target = match[1].trim();
  const operator = match[3] as RelationParsed["operator"];
  const version = match[4]?.trim();

  return { target, operator, version };
}

export function normalizeOptDependency(dep: OptionalDependency): { relation: string; reason?: string } {
  if (typeof dep === "string") {
    return { relation: dep };
  }
  return dep;
}

export function isAnonymousPackage(manifest: Manifest | null): boolean {
  return !manifest || !manifest.name || manifest.name.trim() === "";
}
