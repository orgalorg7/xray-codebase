import type { GraphEdge, GraphNode, Language } from "@xray/schema";

export type SourceFile = {
  /** Repo-relative POSIX path. */
  path: string;
  absolutePath: string;
  language: Language;
  text: string;
  /** Content hash, stable for identical text. Plugins may key caches by it. */
  hash: string;
};

export type ProjectInput = {
  /** Absolute path of the repository root. */
  root: string;
  /** Every file of the plugin's languages, not only the changed ones. */
  files: readonly SourceFile[];
};

export type FileAnalysis = {
  path: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type Diagnostic = {
  severity: "warning" | "error";
  message: string;
  file?: string;
};

export type AnalysisResult = {
  files: FileAnalysis[];
  /** Rows no single file owns, e.g. external packages imported from many files. */
  shared: { nodes: GraphNode[]; edges: GraphEdge[] };
  diagnostics: Diagnostic[];
};

/**
 * A language plugin turns source files into graph rows. `analyze` always receives the whole
 * project because resolution is cross-file; plugins keep their own caches (keyed by file hash)
 * so re-analysis after a small change stays cheap. The engine then writes only the files whose
 * output changed.
 */
export interface LanguagePlugin {
  readonly name: string;
  /** The plugin's language for a repo-relative path, or undefined if it does not handle it. */
  languageOf(path: string): Language | undefined;
  analyze(project: ProjectInput): Promise<AnalysisResult>;
}
