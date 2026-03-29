export function normalizePath(path: string): string {
  return path
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return normalized.substring(0, lastSlash);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return normalized;
  return normalized.substring(lastSlash + 1);
}

export function isSubPath(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  
  if (normalizedParent === normalizedChild) return false;
  
  return normalizedChild.startsWith(normalizedParent + "/");
}
