function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/" || i + 2 === pattern.length) {
          regexStr += ".*";
          i += 2;
          if (pattern[i] === "/") {
            regexStr += "\\/";
            i++;
          }
          continue;
        }
      }
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "/") {
      regexStr += "\\/";
      i++;
    } else if ("\\^$+.()[]{}|".indexOf(char) !== -1) {
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

export function matchGlob(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

export function filterGlob(paths: string[], pattern: string): string[] {
  const regex = globToRegex(pattern);
  return paths.filter((path) => regex.test(path));
}

export function matchAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchGlob(path, pattern));
}
