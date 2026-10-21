/**
 * Compiles a gitignore-style glob to a regular expression over POSIX paths:
 * `**` matches any number of segments, `*` anything but `/`, `?` one character.
 * A pattern ending in `/` (or `/**`) matches everything below that directory.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}
