import type { Confidence, EdgeKind, NodeKind } from "@xray/schema";

const KIND_LABELS: Record<NodeKind, string> = {
  repo: "repository",
  package: "package",
  directory: "directory",
  module: "file",
  class: "class",
  interface: "interface",
  "type-alias": "type",
  enum: "enum",
  function: "function",
  method: "method",
  property: "property",
  variable: "variable",
  route: "route",
  "cli-command": "command",
  component: "component",
  test: "test",
  external: "package",
};

export const kindLabel = (kind: NodeKind): string => KIND_LABELS[kind];

/** Short glyphs used in lists and badges. */
const KIND_GLYPHS: Partial<Record<NodeKind, string>> = {
  repo: "◎",
  package: "▣",
  directory: "▢",
  module: "▤",
  class: "C",
  interface: "I",
  "type-alias": "T",
  enum: "E",
  function: "ƒ",
  method: "m",
  property: "p",
  variable: "v",
  route: "⇄",
  "cli-command": "›_",
  component: "◇",
  test: "✓",
  external: "⬡",
};

export const kindGlyph = (kind: NodeKind): string => KIND_GLYPHS[kind] ?? "•";

const EDGE_VERBS: Record<EdgeKind, [string, string]> = {
  contains: ["contains", "contained in"],
  imports: ["imports", "imported by"],
  exports: ["exports", "exported by"],
  "re-exports": ["re-exports", "re-exported by"],
  calls: ["calls", "called by"],
  instantiates: ["creates", "created by"],
  extends: ["extends", "extended by"],
  implements: ["implements", "implemented by"],
  overrides: ["overrides", "overridden by"],
  references: ["uses", "used by"],
  "type-of": ["typed as", "type of"],
  decorates: ["decorates", "decorated by"],
  tests: ["tests", "tested by"],
  handles: ["handled by", "handles"],
};

/** "calls" / "called by" depending on the direction the edge is seen from. */
export const edgeVerb = (kind: EdgeKind, outgoing: boolean): string =>
  EDGE_VERBS[kind][outgoing ? 0 : 1];

export const confidenceLabel: Record<Confidence, string> = {
  exact: "resolved exactly",
  inferred: "inferred from types or assignments",
  heuristic: "guessed by name: may be wrong",
};

export const confidenceGlyph: Record<Confidence, string> = {
  exact: "",
  inferred: "~",
  heuristic: "?",
};

export const formatCount = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

export const plural = (n: number, word: string, many = `${word}s`): string =>
  `${formatCount(n)} ${n === 1 ? word : many}`;

/** "src/auth/login.ts" → "…/auth/login.ts" when longer than `max`. */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let out = parts.pop() ?? path;
  while (parts.length > 0 && out.length + (parts.at(-1)?.length ?? 0) + 2 <= max)
    out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [2592000, "month"],
    [31536000, "year"],
  ];
  let label = "";
  for (const [size, name] of units)
    if (seconds >= size) label = plural(Math.floor(seconds / size), name);
  return `${label} ago`;
}
