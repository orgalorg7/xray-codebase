import { resolve } from "node:path";
import {
  AnalysisBuilder,
  type AnalysisResult,
  type LanguagePlugin,
  type ProjectInput,
} from "@xray/parser";
import { languageOfPath, ProgramAnalyzer, type Project } from "./analyze.js";
import { groupByConfig, ProgramCache } from "./program.js";

/**
 * TypeScript/JavaScript plugin. Uses the TypeScript compiler for both parsing and resolution,
 * so calls are followed through imports, re-exports, aliases, generics and typed receivers.
 */
export function createTypeScriptPlugin(): LanguagePlugin {
  const cache = new ProgramCache();
  let last: { fingerprint: string; result: AnalysisResult } | undefined;
  return {
    name: "typescript",
    languageOf: languageOfPath,
    async analyze(input: ProjectInput): Promise<AnalysisResult> {
      // Resolution is whole-program, so any change re-analyzes; no change reuses the last result.
      const fingerprint = JSON.stringify([input.root, input.files.map((f) => [f.path, f.hash])]);
      if (last?.fingerprint === fingerprint) return last.result;
      const builder = new AnalysisBuilder();
      const project: Project = {
        root: input.root,
        builder,
        files: new Map(input.files.map((file) => [resolve(file.absolutePath), file])),
        declarations: new Map(),
        callablesByName: new Map(),
        methodsByName: new Map(),
      };
      const groups = groupByConfig(input.root, input.files);
      const analyzers = groups.map((group) => {
        const { program, host } = cache.program(input.root, group, input.files);
        return { group, analyzer: new ProgramAnalyzer(project, program, host) };
      });
      for (const { group, analyzer } of analyzers) {
        for (const file of group.files) analyzer.extract(file);
      }
      for (const { group, analyzer } of analyzers) {
        for (const file of group.files) {
          try {
            analyzer.resolve(file);
          } catch (error) {
            builder.diagnostics.push({
              severity: "error",
              file: file.path,
              message: `resolution failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      const result = builder.build();
      last = { fingerprint, result };
      return result;
    },
  };
}
