import { LANGUAGES, type Language } from "./kinds.js";

/**
 * Stable node IDs. They must survive rescans unchanged, because URLs, saved layouts and
 * graph diffs are keyed by them.
 *
 *   module      ts:src/auth/login.ts
 *   symbol      ts:src/auth/login.ts#AuthService.login
 *   overload    ts:src/auth/login.ts#parse(string)
 *   directory   dir:src/auth
 *   package     pkg:@acme/web
 *   external    ext:npm/react, ext:pypi/requests
 *   repo        repo:
 *
 * Paths are repo-relative and POSIX-style. `%` and `#` in paths are percent-encoded so the
 * first `#` always separates the path from the qualified name.
 */
export type ParsedId =
  | { type: "module"; language: Language; path: string }
  | {
      type: "symbol";
      language: Language;
      path: string;
      qualifiedName: string;
      signature?: string;
    }
  | { type: "directory"; path: string }
  | { type: "package"; name: string }
  | { type: "external"; registry: string; name: string }
  | { type: "repo" };

export const REPO_ID = "repo:";

const encodePath = (path: string): string => path.replaceAll("%", "%25").replaceAll("#", "%23");
const decodePath = (path: string): string => path.replaceAll("%23", "#").replaceAll("%25", "%");

/** Normalizes a path to repo-relative POSIX form: no leading `./` or `/`, no trailing `/`. */
export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function moduleId(language: Language, path: string): string {
  return `${language}:${encodePath(normalizePath(path))}`;
}

export function symbolId(
  language: Language,
  path: string,
  qualifiedName: string,
  signature?: string,
): string {
  const sig = signature === undefined ? "" : `(${signature})`;
  return `${moduleId(language, path)}#${qualifiedName}${sig}`;
}

export function directoryId(path: string): string {
  return `dir:${encodePath(normalizePath(path))}`;
}

export function packageId(name: string): string {
  return `pkg:${name}`;
}

export function externalId(registry: string, name: string): string {
  return `ext:${registry}/${name}`;
}

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** Parses an ID produced by the builders above. Returns undefined for anything else. */
export function parseId(id: string): ParsedId | undefined {
  if (id === REPO_ID) return { type: "repo" };
  const colon = id.indexOf(":");
  if (colon <= 0) return undefined;
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (rest === "") return undefined;

  switch (prefix) {
    case "dir":
      return { type: "directory", path: decodePath(rest) };
    case "pkg":
      return { type: "package", name: rest };
    case "ext": {
      const slash = rest.indexOf("/");
      if (slash <= 0 || slash === rest.length - 1) return undefined;
      return { type: "external", registry: rest.slice(0, slash), name: rest.slice(slash + 1) };
    }
  }

  if (!isLanguage(prefix)) return undefined;
  const hash = rest.indexOf("#");
  if (hash === -1) return { type: "module", language: prefix, path: decodePath(rest) };

  const path = decodePath(rest.slice(0, hash));
  const symbol = rest.slice(hash + 1);
  if (path === "" || symbol === "") return undefined;
  const sigMatch = /^(.*?)\((.*)\)$/.exec(symbol);
  if (sigMatch?.[1]) {
    return {
      type: "symbol",
      language: prefix,
      path,
      qualifiedName: sigMatch[1],
      signature: sigMatch[2] ?? "",
    };
  }
  return { type: "symbol", language: prefix, path, qualifiedName: symbol };
}
