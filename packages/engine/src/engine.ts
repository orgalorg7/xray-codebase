import { createHash } from "node:crypto";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { createPythonPlugin } from "@xray/lang-python";
import { createTypeScriptPlugin } from "@xray/lang-ts";
import type { Diagnostic, FileAnalysis, LanguagePlugin, SourceFile } from "@xray/parser";
import type { GraphStore } from "@xray/store";
import { DEFAULT_IGNORES, discoverFiles } from "./discover.js";
import { buildStructure } from "./structure.js";

export type EngineOptions = {
  root: string;
  store: GraphStore;
  /** Defaults to TypeScript/JavaScript and Python. */
  plugins?: LanguagePlugin[];
  /** Extra gitignore-style patterns. */
  ignore?: readonly string[];
  /** Files larger than this are skipped (default 1 MiB): usually generated or vendored. */
  maxFileSize?: number;
};

export type ScanReport = {
  files: number;
  added: string[];
  changed: string[];
  removed: string[];
  /** Files whose stored rows were rewritten, including unchanged files whose resolution changed. */
  rewritten: number;
  skipped: { path: string; reason: string }[];
  nodes: number;
  edges: number;
  diagnostics: Diagnostic[];
  timings: { discover: number; read: number; analyze: number; write: number; total: number };
};

export type Watcher = { close(): void };

type CachedFile = { mtimeMs: number; size: number; file: SourceFile };

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

function digestOf(analysis: FileAnalysis): string {
  return sha1(JSON.stringify([analysis.nodes, analysis.edges]));
}

/**
 * Scans a repository with language plugins and keeps a graph store in sync. Keep one Engine per
 * repository: plugins and file contents are cached between scans, so rescans are incremental.
 */
export class Engine {
  readonly root: string;
  readonly #store: GraphStore;
  readonly #plugins: LanguagePlugin[];
  readonly #ignore: readonly string[];
  readonly #maxFileSize: number;
  readonly #files = new Map<string, CachedFile>();
  #scanning: Promise<ScanReport> | undefined;
  #queued: Promise<ScanReport> | undefined;

  constructor(options: EngineOptions) {
    this.root = resolve(options.root);
    this.#store = options.store;
    this.#plugins = options.plugins ?? [createTypeScriptPlugin(), createPythonPlugin()];
    this.#ignore = options.ignore ?? [];
    this.#maxFileSize = options.maxFileSize ?? 1024 * 1024;
  }

  #pluginFor(path: string): LanguagePlugin | undefined {
    return this.#plugins.find((plugin) => plugin.languageOf(path) !== undefined);
  }

  /**
   * Scans the repository. A call made while a scan runs waits for one follow-up scan, shared by
   * every caller that arrives in the meantime, so the result always reflects the latest files.
   */
  scan(): Promise<ScanReport> {
    if (this.#scanning) {
      this.#queued ??= this.#scanning
        .catch(() => undefined)
        .then(() => {
          this.#queued = undefined;
          return this.scan();
        });
      return this.#queued;
    }
    this.#scanning = this.#scan().finally(() => {
      this.#scanning = undefined;
    });
    return this.#scanning;
  }

  async #scan(): Promise<ScanReport> {
    const started = performance.now();
    const paths = discoverFiles(this.root, {
      ignore: this.#ignore,
      accept: (path) => this.#pluginFor(path) !== undefined,
    });
    const discovered = performance.now();

    const skipped: ScanReport["skipped"] = [];
    const current = new Map<string, SourceFile>();
    for (const path of paths) {
      const absolutePath = join(this.root, path);
      let stat: import("node:fs").Stats;
      try {
        stat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (stat.size > this.#maxFileSize) {
        skipped.push({ path, reason: `larger than ${this.#maxFileSize} bytes` });
        continue;
      }
      const cached = this.#files.get(path);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        current.set(path, cached.file);
        continue;
      }
      const text = readFileSync(absolutePath, "utf8");
      if (text.includes("\u0000")) {
        skipped.push({ path, reason: "binary content" });
        continue;
      }
      const language = this.#pluginFor(path)?.languageOf(path);
      if (language === undefined) continue;
      const file: SourceFile = { path, absolutePath, language, text, hash: sha1(text) };
      this.#files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, file });
      current.set(path, file);
    }
    for (const path of this.#files.keys()) if (!current.has(path)) this.#files.delete(path);
    const read = performance.now();

    const diagnostics: Diagnostic[] = [];
    const analyses: FileAnalysis[] = [];
    const shared: {
      nodes: import("@xray/schema").GraphNode[];
      edges: import("@xray/schema").GraphEdge[];
    } = {
      nodes: [],
      edges: [],
    };
    for (const plugin of this.#plugins) {
      const files = [...current.values()].filter((file) => this.#pluginFor(file.path) === plugin);
      if (files.length === 0) continue;
      try {
        const result = await plugin.analyze({ root: this.root, files });
        analyses.push(...result.files);
        shared.nodes.push(...result.shared.nodes);
        shared.edges.push(...result.shared.edges);
        diagnostics.push(...result.diagnostics);
      } catch (error) {
        diagnostics.push({
          severity: "error",
          message: `${plugin.name} plugin failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const analyzed = performance.now();

    const stored = new Map(this.#store.listFiles().map((file) => [file.path, file]));
    const added: string[] = [];
    const changed: string[] = [];
    let rewritten = 0;
    const byPath = new Map(analyses.map((analysis) => [analysis.path, analysis]));
    const modules: { id: string; path: string }[] = [];
    this.#store.transaction(() => {
      for (const file of current.values()) {
        const analysis = byPath.get(file.path) ?? { path: file.path, nodes: [], edges: [] };
        const module = analysis.nodes.find((node) => node.kind === "module");
        if (module) modules.push({ id: module.id, path: file.path });
        const previous = stored.get(file.path);
        if (previous === undefined) added.push(file.path);
        else if (previous.hash !== file.hash) changed.push(file.path);
        const digest = digestOf(analysis);
        if (previous?.digest === digest && previous.hash === file.hash) continue;
        const size = this.#files.get(file.path)?.size ?? file.text.length;
        this.#store.replaceFile(
          { path: file.path, language: file.language, hash: file.hash, size, digest },
          analysis.nodes,
          analysis.edges,
        );
        rewritten++;
      }
      for (const path of stored.keys()) if (!current.has(path)) this.#store.removeFile(path);
      const structure = buildStructure(this.root, modules);
      this.#store.replaceShared(
        [...structure.nodes, ...shared.nodes],
        [...structure.edges, ...shared.edges],
      );
    });
    const removed = [...stored.keys()].filter((path) => !current.has(path));
    const written = performance.now();

    const stats = this.#store.stats();
    return {
      files: current.size,
      added,
      changed,
      removed,
      rewritten,
      skipped,
      nodes: stats.nodes,
      edges: stats.edges,
      diagnostics,
      timings: {
        discover: discovered - started,
        read: read - discovered,
        analyze: analyzed - read,
        write: written - analyzed,
        total: written - started,
      },
    };
  }

  /**
   * Rescans whenever files under the root change (debounced). `onScan` receives every report;
   * `onError` any scan failure.
   */
  watch(
    onScan: (report: ScanReport) => void,
    onError: (error: unknown) => void = () => {},
    debounceMs = 150,
  ): Watcher {
    const noise = DEFAULT_IGNORES.filter((pattern) => pattern.endsWith("/")).map((pattern) =>
      pattern.slice(0, -1),
    );
    let timer: NodeJS.Timeout | undefined;
    const trigger = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.scan().then(onScan, onError);
      }, debounceMs);
    };
    const watcher: FSWatcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (filename === null) return trigger();
      const path = filename.toString().replaceAll("\\", "/");
      const segments = path.split("/");
      if (segments.some((segment) => noise.includes(segment))) return;
      const name = segments.at(-1) ?? "";
      // Source files, ignore rules, and extension-less names (usually directories).
      const relevant =
        this.#pluginFor(path) !== undefined ||
        name === ".gitignore" ||
        name === ".xrayignore" ||
        !name.includes(".");
      if (relevant) trigger();
    });
    return {
      close: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  }
}
