/** Languages with a parser plugin. Directory, package and external nodes carry no language. */
export const LANGUAGES = ["ts", "js", "py", "go", "java", "kt", "rs", "cs", "php", "rb"] as const;
export type Language = (typeof LANGUAGES)[number];

/** How languages are called in prose. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  py: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  rs: "Rust",
  cs: "C#",
  php: "PHP",
  rb: "Ruby",
};

export const NODE_KINDS = [
  "repo",
  "package",
  "directory",
  "module",
  "class",
  "interface",
  "type-alias",
  "enum",
  "function",
  "method",
  "property",
  "variable",
  "route",
  "cli-command",
  "component",
  "test",
  "external",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "contains",
  "imports",
  "exports",
  "re-exports",
  "calls",
  "instantiates",
  "extends",
  "implements",
  "overrides",
  "references",
  "type-of",
  "decorates",
  "tests",
  "handles",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * How sure the analyzer is that an edge exists.
 * - exact: resolved by a compiler/type checker or an unambiguous static import.
 * - inferred: resolved through local type inference (e.g. `x = Foo(); x.bar()`).
 * - heuristic: matched by name only; the real target may differ at runtime.
 */
export const CONFIDENCES = ["exact", "inferred", "heuristic"] as const;
export type Confidence = (typeof CONFIDENCES)[number];
