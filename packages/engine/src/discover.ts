import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Never worth mapping: dependencies, build output, caches and VCS metadata. */
export const DEFAULT_IGNORES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  ".parcel-cache/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".tox/",
  ".nox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  "site-packages/",
  ".xray/",
  "*.min.js",
  "*.bundle.js",
  "*.d.ts",
];

export type DiscoverOptions = {
  /** Extra gitignore-style patterns, relative to the root. */
  ignore?: readonly string[];
  /** Keep only paths a plugin can handle. */
  accept: (path: string) => boolean;
};

type Matcher = { base: string; rules: Ignore };

function readRules(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lists repo-relative POSIX paths of source files under `root`, honouring nested `.gitignore`
 * files, a root `.xrayignore`, the defaults above and `options.ignore`. Symlinks are skipped so
 * cycles cannot occur.
 */
export function discoverFiles(root: string, options: DiscoverOptions): string[] {
  const base = ignore()
    .add(DEFAULT_IGNORES)
    .add([...(options.ignore ?? [])]);
  const xrayignore = readRules(join(root, ".xrayignore"));
  if (xrayignore) base.add(xrayignore);
  const found: string[] = [];

  const ignored = (matchers: Matcher[], path: string, isDir: boolean): boolean =>
    matchers.some(({ base: dir, rules }) => {
      const rel = relative(dir, path).replaceAll("\\", "/");
      return rel !== "" && !rel.startsWith("..") && rules.ignores(isDir ? `${rel}/` : rel);
    });

  const walk = (dir: string, inherited: Matcher[]): void => {
    const gitignore = readRules(join(dir, ".gitignore"));
    const matchers = gitignore
      ? [...inherited, { base: dir, rules: ignore().add(gitignore) }]
      : inherited;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      if (ignored(matchers, path, isDir)) continue;
      if (isDir) walk(path, matchers);
      else {
        const rel = relative(root, path).replaceAll("\\", "/");
        if (options.accept(rel)) found.push(rel);
      }
    }
  };

  walk(root, [{ base: root, rules: base }]);
  return found;
}
