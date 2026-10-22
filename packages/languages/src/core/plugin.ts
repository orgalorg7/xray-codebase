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
  type SourceFile,
  type Tree,
} from "@xray/parser";
import type { Language } from "@xray/schema";
import type { FileModel } from "./model.js";
import { type LanguageRules, Project } from "./resolve.js";

/** One language of a plugin: its files, grammar and extractor. */
export type Dialect = {
  language: Language;
  /** Files of the language. */
  extensions: RegExp;
  /** The grammar: its npm package and `.wasm` file name. */
  grammar: { package: string; file: string };
  extract(tree: Tree, file: SourceFile): FileModel;
  /** Rewrites source the grammar misreads, keeping every line where it was. */
  prepare?(text: string): string;
};

export type LanguageDefinition = {
  /** Plugin name, e.g. `go`. */
  name: string;
  /** Languages resolved together (Java and Kotlin call each other freely). */
  dialects: Dialect[];
  /** Fresh rules for each analysis (they may hold project state, such as go.mod). */
  rules(): LanguageRules;
};

/**
 * Where a grammar lives: bundled builds ship grammars next to the code (`grammars/`), in the
 * workspace they come from their npm package.
 */
export function grammarPath(grammar: { package: string; file: string }): string {
  const bundled = fileURLToPath(new URL(`./grammars/${grammar.file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve(`${grammar.package}/${grammar.file}`);
}

/**
 * A plugin from a language definition: tree-sitter parsing (cached per file by content hash)
 * and the shared resolver. Any change re-resolves the whole language; no change reuses the
 * last result.
 */
export function createLanguagePlugin(definition: LanguageDefinition): LanguagePlugin {
  const parsers = new Map<Dialect, Promise<Parser>>();
  const cache = new Map<string, { hash: string; model: FileModel }>();
  let last: { fingerprint: string; result: AnalysisResult } | undefined;
  const dialectOf = (path: string) => definition.dialects.find((d) => d.extensions.test(path));

  return {
    name: definition.name,
    languageOf: (path) => dialectOf(path)?.language,
    async analyze(input: ProjectInput): Promise<AnalysisResult> {
      const fingerprint = JSON.stringify(input.files.map((f) => [f.path, f.hash]));
      if (last?.fingerprint === fingerprint) return last.result;
      const builder = new AnalysisBuilder();
      const models: FileModel[] = [];
      const live = new Set<string>();
      for (const file of input.files) {
        live.add(file.path);
        builder.file(file.path);
        const cached = cache.get(file.path);
        if (cached?.hash === file.hash) {
          models.push(cached.model);
          continue;
        }
        const dialect = dialectOf(file.path);
        if (!dialect) continue;
        let parser = parsers.get(dialect);
        if (!parser) {
          parser = createParser(grammarPath(dialect.grammar));
          parsers.set(dialect, parser);
        }
        const tree = (await parser).parse(dialect.prepare ? dialect.prepare(file.text) : file.text);
        if (!tree) {
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
        cached?.model.tree.delete();
        try {
          const model = dialect.extract(tree, file);
          cache.set(file.path, { hash: file.hash, model });
          models.push(model);
        } catch (error) {
          tree.delete();
          builder.diagnostics.push({
            severity: "error",
            file: file.path,
            message: `could not analyze: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      for (const [path, entry] of cache) {
        if (!live.has(path)) {
          entry.model.tree.delete();
          cache.delete(path);
        }
      }
      const project = new Project(input.root, models, definition.rules());
      project.link();
      project.emit(builder);
      const result = builder.build();
      last = { fingerprint, result };
      return result;
    },
  };
}
