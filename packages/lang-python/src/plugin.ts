import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AnalysisBuilder,
  type AnalysisResult,
  createParser,
  type LanguagePlugin,
  type Parser,
  type ProjectInput,
} from "@xray/parser";
import type { Language } from "@xray/schema";
import { extractModule, type ModuleInfo } from "./extract.js";
import { PythonProject } from "./resolve.js";

/**
 * The Python grammar. Bundled builds ship it next to the code (`grammars/`); in the workspace
 * it comes from the tree-sitter-python package.
 */
function grammarPath(): string {
  const bundled = fileURLToPath(new URL("./grammars/tree-sitter-python.wasm", import.meta.url));
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve("tree-sitter-python/tree-sitter-python.wasm");
}

export const languageOfPath = (path: string): Language | undefined =>
  /\.py$/.test(path) ? "py" : undefined;

/**
 * Python plugin: tree-sitter parsing plus xray's own resolver for imports, packages, classes
 * and local type inference. Parsed modules are cached by content hash between scans.
 */
export function createPythonPlugin(): LanguagePlugin {
  let parser: Promise<Parser> | undefined;
  const cache = new Map<string, { hash: string; info: ModuleInfo }>();
  let last: { fingerprint: string; result: AnalysisResult } | undefined;

  return {
    name: "python",
    languageOf: languageOfPath,
    async analyze(input: ProjectInput): Promise<AnalysisResult> {
      // Resolution is whole-project, so any change re-resolves; no change reuses the last result.
      const fingerprint = JSON.stringify(input.files.map((f) => [f.path, f.hash]));
      if (last?.fingerprint === fingerprint) return last.result;
      parser ??= createParser(grammarPath());
      const ready = await parser;
      const builder = new AnalysisBuilder();
      const modules: ModuleInfo[] = [];
      const live = new Set<string>();
      for (const file of input.files) {
        live.add(file.path);
        const cached = cache.get(file.path);
        if (cached?.hash === file.hash) {
          modules.push(cached.info);
          continue;
        }
        const tree = ready.parse(file.text);
        if (tree === null) {
          builder.diagnostics.push({ severity: "error", file: file.path, message: "parse failed" });
          continue;
        }
        if (tree.rootNode.hasError) {
          builder.diagnostics.push({
            severity: "warning",
            file: file.path,
            message: "syntax errors; results may be partial",
          });
        }
        cached?.info.tree.delete();
        const info = extractModule(file.path, tree);
        cache.set(file.path, { hash: file.hash, info });
        modules.push(info);
      }
      for (const [path, entry] of cache) {
        if (!live.has(path)) {
          entry.info.tree.delete();
          cache.delete(path);
        }
      }
      for (const mod of modules) builder.file(mod.path);
      new PythonProject(modules, builder).emit();
      const result = builder.build();
      last = { fingerprint, result };
      return result;
    },
  };
}
