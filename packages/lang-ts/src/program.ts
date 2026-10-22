import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SourceFile } from "@xray/parser";
import ts from "typescript";

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

/** Used when a project has no config, and as the base under a config's own options. */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowImportingTsExtensions: true,
};

/** Options xray always needs, whatever the project config says. */
const FORCED_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
  declaration: false,
  composite: false,
  incremental: false,
  // Diagnostic output options would print to stdout from inside xray.
  traceResolution: false,
  listFiles: false,
  listEmittedFiles: false,
  explainFiles: false,
  diagnostics: false,
  extendedDiagnostics: false,
  generateTrace: undefined,
  generateCpuProfile: undefined,
};

/**
 * One TypeScript program over files whose nearest tsconfig/jsconfig yields the same effective
 * options. Monorepo packages usually differ only in output settings, so they share a program
 * (and a single type checker) instead of each loading the standard library again.
 */
export type ProgramGroup = {
  /** Identifies the effective options; stable across scans. */
  key: string;
  options: ts.CompilerOptions;
  files: SourceFile[];
};

/** Options that only affect emit or bookkeeping, ignored when deciding to share a program. */
const OUTPUT_OPTIONS = [
  "configFilePath",
  "rootDir",
  "rootDirs",
  "outDir",
  "outFile",
  "declarationDir",
  "tsBuildInfoFile",
  "sourceRoot",
  "mapRoot",
] as const;

function optionsKey(options: ts.CompilerOptions): string {
  const relevant: Record<string, unknown> = { ...options };
  for (const name of OUTPUT_OPTIONS) delete relevant[name];
  return JSON.stringify(
    Object.keys(relevant)
      .sort()
      .map((name) => [name, relevant[name]]),
  );
}

function findConfig(root: string, absolutePath: string): string | undefined {
  let dir = dirname(absolutePath);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === root || relative(root, dir).startsWith("..")) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readConfigOptions(configPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  return parsed?.options ?? {};
}

export function groupByConfig(root: string, files: readonly SourceFile[]): ProgramGroup[] {
  const workspace = workspacePaths(root, files);
  const optionsByConfig = new Map<string, ts.CompilerOptions>();
  const groups = new Map<string, ProgramGroup>();
  for (const file of files) {
    const configPath = findConfig(root, file.absolutePath) ?? "";
    let options = optionsByConfig.get(configPath);
    if (options === undefined) {
      const own = configPath === "" ? {} : readConfigOptions(configPath);
      options = {
        ...DEFAULT_OPTIONS,
        ...own,
        ...FORCED_OPTIONS,
        // The project's own path mappings win over inferred workspace ones.
        paths: { ...workspace, ...own.paths },
      };
      optionsByConfig.set(configPath, options);
    }
    const key = optionsKey(options);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, options, files: [] };
      groups.set(key, group);
    }
    group.files.push(file);
  }
  return [...groups.values()];
}

type CachedSourceFile = {
  text: string;
  target: ts.ScriptTarget;
  format: ts.ResolutionMode;
  sourceFile: ts.SourceFile;
};

/**
 * Parses files once and builds programs whose project files come from the engine's snapshot
 * rather than disk. Programs are built one at a time and released after use: holding every
 * program of a multi-app repository at once costs gigabytes, mostly in node_modules types.
 */
export class ProgramCache {
  readonly #sourceFiles = new Map<string, CachedSourceFile>();

  #parse(
    fileName: string,
    text: string,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
  ): ts.SourceFile {
    const options =
      typeof languageVersionOrOptions === "object" ? languageVersionOrOptions : undefined;
    const target = options
      ? options.languageVersion
      : (languageVersionOrOptions as ts.ScriptTarget);
    // node16/nodenext programs parse each file as ESM or CommonJS; a tree parsed for another
    // format must not be reused.
    const format = options?.impliedNodeFormat;
    const cached = this.#sourceFiles.get(fileName);
    if (cached?.text === text && cached.target === target && cached.format === format) {
      return cached.sourceFile;
    }
    const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    this.#sourceFiles.set(fileName, { text, target, format, sourceFile });
    return sourceFile;
  }

  /** A project file's syntax tree, shared with the program built for its group later. */
  parse(file: SourceFile, group: ProgramGroup): ts.SourceFile {
    return this.#parse(
      resolve(file.absolutePath),
      file.text,
      group.options.target ?? ts.ScriptTarget.ES2022,
    );
  }

  /** `allFiles` is the whole project snapshot; only the group's files become root names. */
  program(
    root: string,
    group: ProgramGroup,
    allFiles: readonly SourceFile[],
  ): { program: ts.Program; host: ts.CompilerHost } {
    const snapshot = new Map(allFiles.map((file) => [resolve(file.absolutePath), file.text]));
    const host = ts.createCompilerHost(group.options, true);
    // Only the repository and TypeScript's own lib files are visible: resolution must not pick
    // up node_modules or @types from directories above the scanned root.
    const visible = [resolve(root), dirname(ts.getDefaultLibFilePath(group.options))];
    const inside = (path: string): boolean => {
      const absolute = resolve(path);
      return visible.some((dir) => absolute === dir || absolute.startsWith(dir + sep));
    };
    const readFile = (fileName: string): string | undefined =>
      snapshot.get(resolve(fileName)) ?? (inside(fileName) ? ts.sys.readFile(fileName) : undefined);
    host.readFile = readFile;
    host.fileExists = (fileName) =>
      snapshot.has(resolve(fileName)) || (inside(fileName) && ts.sys.fileExists(fileName));
    host.directoryExists = (dir) => inside(dir) && ts.sys.directoryExists(dir);
    host.getDirectories = (dir) => (inside(dir) ? ts.sys.getDirectories(dir) : []);
    host.getSourceFile = (fileName, languageVersionOrOptions) => {
      const text = readFile(fileName);
      return text === undefined ? undefined : this.#parse(fileName, text, languageVersionOrOptions);
    };
    const program = ts.createProgram({
      rootNames: group.files.map((file) => resolve(file.absolutePath)),
      options: group.options,
      host,
    });
    return { program, host };
  }

  /**
   * Forgets parsed dependency files (node_modules and other non-project files) so the next
   * group's program does not keep them alive. TypeScript's own lib files stay: every group
   * uses them.
   */
  releaseDependencies(projectFiles: ReadonlySet<string>): void {
    const libDir = dirname(ts.getDefaultLibFilePath({}));
    for (const fileName of this.#sourceFiles.keys()) {
      const absolute = resolve(fileName);
      if (!projectFiles.has(absolute) && !absolute.startsWith(libDir + sep))
        this.#sourceFiles.delete(fileName);
    }
  }
}

/**
 * Maps workspace package names to their TypeScript entry file, so imports between packages of
 * a monorepo resolve to source instead of built `.d.ts` files. Returns `paths` entries.
 */
export function workspacePaths(
  root: string,
  files: readonly SourceFile[],
): Record<string, string[]> {
  const known = new Set(files.map((file) => resolve(file.absolutePath)));
  const paths: Record<string, string[]> = {};
  const manifests = new Set<string>();
  for (const file of files) {
    let dir = dirname(file.absolutePath);
    while (!relative(root, dir).startsWith("..")) {
      const manifest = join(dir, "package.json");
      if (manifests.has(manifest)) break;
      manifests.add(manifest);
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue;
    let pkg: {
      name?: unknown;
      exports?: unknown;
      types?: unknown;
      main?: unknown;
      source?: unknown;
    };
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg.name !== "string") continue;
    const entry = entryCandidates(pkg)
      .flatMap((candidate) => sourceCandidates(resolve(dirname(manifest), candidate)))
      .find((candidate) => known.has(candidate));
    if (entry !== undefined) paths[pkg.name] = [entry];
  }
  return paths;
}

function entryCandidates(pkg: {
  exports?: unknown;
  types?: unknown;
  main?: unknown;
  source?: unknown;
}): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // Prefer the root export, then source-like conditions.
      if ("." in record) {
        visit(record["."]);
        return;
      }
      for (const key of ["development", "source", "types", "import", "default", "require"]) {
        if (key in record) visit(record[key]);
      }
    }
  };
  visit(pkg.source);
  visit(pkg.exports);
  visit(pkg.types);
  visit(pkg.main);
  return out;
}

/** `dist/index.d.ts` → `src/index.ts`, `src/index.tsx`, ... (and the path itself). */
function sourceCandidates(path: string): string[] {
  const stem = path.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");
  const stems = [stem, stem.replace(/([/\\])(dist|lib|build|out)([/\\])/, "$1src$3")];
  return stems.flatMap((s) => [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map((ext) => s + ext));
}
