export interface VersionInfo {
  epoch: number;
  version: string;
  release: string;
}

export function parseVersion(versionStr: string): VersionInfo {
  const epochMatch = versionStr.match(/^(\d+):/);
  const epoch = epochMatch ? parseInt(epochMatch[1], 10) : 0;
  const withoutEpoch = epochMatch ? versionStr.substring(epochMatch[0].length) : versionStr;
  
  const releaseMatch = withoutEpoch.match(/^(.+)-([^-]+)$/);
  const version = releaseMatch ? releaseMatch[1] : withoutEpoch;
  const release = releaseMatch ? releaseMatch[2] : "0";
  
  return { epoch, version, release };
}

export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);
  
  if (vA.epoch !== vB.epoch) {
    return vA.epoch - vB.epoch;
  }
  
  const versionCmp = compareVersionParts(vA.version, vB.version);
  if (versionCmp !== 0) return versionCmp;
  
  return compareVersionParts(vA.release, vB.release);
}

function compareVersionParts(a: string, b: string): number {
  const aParts = a.split(/([0-9]+|[^0-9]+)/g).filter(s => s.length > 0);
  const bParts = b.split(/([0-9]+|[^0-9]+)/g).filter(s => s.length > 0);
  
  const maxLen = Math.max(aParts.length, bParts.length);
  
  for (let i = 0; i < maxLen; i++) {
    const aPart = aParts[i] || "";
    const bPart = bParts[i] || "";
    
    const aNum = parseInt(aPart, 10);
    const bNum = parseInt(bPart, 10);
    
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      const cmp = aPart.localeCompare(bPart);
      if (cmp !== 0) return cmp;
    }
  }
  
  return 0;
}

export function satisfiesVersion(version: string, operator: string, targetVersion: string): boolean {
  const cmp = compareVersions(version, targetVersion);
  
  switch (operator) {
    case "=": return cmp === 0;
    case "!=": return cmp !== 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    default: return false;
  }
}
