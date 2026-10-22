import type {
  CallTree,
  Cycle,
  District,
  FeatureHit,
  Hotspots,
  ImpactedNode,
  ImpactReport,
  Road,
} from "@xray/analysis";
import type {
  Confidence,
  EdgeKind,
  Graph,
  GraphEdge,
  GraphNode,
  Language,
  NodeKind,
  SourceLocation,
} from "@xray/schema";

export type FileHistory = {
  commits: number;
  additions: number;
  deletions: number;
  authors: string[];
  lastChanged: string;
};

export type CoChange = { a: string; b: string; count: number; confidence: number };

/** Everything the service needs, independent of where it came from (live scan, export file). */
export type Snapshot = {
  /** Display name, usually the repository directory name. */
  name: string;
  /** Absolute path or URL of the repository. */
  root: string;
  graph: Graph;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  diagnostics?: { severity: "warning" | "error"; message: string; file?: string }[];
  /** Source text by repo-relative path, for previews. Absent in exports made without sources. */
  sources?: ((path: string) => string | undefined) | Record<string, string>;
  git?: { commits: number; files: Record<string, FileHistory>; coChange: CoChange[] };
};

/** A compact reference to a node, enough to show and link it. */
export type Summary = {
  id: string;
  kind: NodeKind;
  name: string;
  /** Qualified name for symbols, path for modules and directories. */
  label: string;
  file?: string;
  line?: number;
  language?: Language;
};

export type Meta = {
  name: string;
  root: string;
  scannedAt: string;
  stats: {
    files: number;
    symbols: number;
    edges: number;
    languages: Partial<Record<Language, number>>;
    entryPoints: number;
    tests: number;
  };
  diagnostics: { count: number; sample: NonNullable<Snapshot["diagnostics"]> };
  hasSources: boolean;
  hasGit: boolean;
};

/** A node as drawn on the map. Coordinates are in map units ([0, size]). */
export type MapNode = Summary & {
  parent?: string;
  x: number;
  y: number;
  r: number;
  depth: number;
  lines: number;
  exported?: boolean;
  fanIn: number;
  fanOut: number;
  /** Rank by centrality among symbols: 1 is the most depended-upon. */
  rank?: number;
  district?: number;
  /** Commits touching the node's file, when git history is available. */
  churn?: number;
  dead?: true;
  inCycle?: true;
  /** Reached from at least one test. */
  tested?: true;
};

export type MapData = { size: number; nodes: MapNode[]; districts: { id: number; name: string }[] };

export type EdgeView = {
  kind: EdgeKind;
  confidence: Confidence;
  detail?: string;
  location?: SourceLocation;
  /** The node at the other end. */
  other: Summary;
};

export type NodeDetails = {
  node: GraphNode;
  ancestors: Summary[];
  children: Summary[];
  outgoing: EdgeView[];
  incoming: EdgeView[];
  /** True when edge lists were cut at the limit. */
  truncated: boolean;
  metrics: { fanIn: number; fanOut: number; lines: number; rank?: number; centrality: number };
  district?: { id: number; name: string };
  git?: FileHistory;
  /** Files that often change together with this node's file. */
  coChanges?: { file: string; count: number; confidence: number }[];
};

export type SourceView = {
  file: string;
  language?: Language;
  startLine: number;
  lines: string[];
  totalLines: number;
};

export type SearchView = {
  query: string;
  terms: string[];
  hits: (FeatureHit & { node: Summary })[];
  territory: {
    modules: { node: Summary; score: number }[];
    entryPoints: Summary[];
    tests: Summary[];
  };
};

export type ImpactView = Omit<ImpactReport, "impacted" | "entryPoints" | "tests" | "targets"> & {
  targets: Summary[];
  impacted: (ImpactedNode & { node: Summary })[];
  entryPoints: (ImpactedNode & { node: Summary })[];
  tests: (ImpactedNode & { node: Summary })[];
  /** True when `impacted` was cut at the limit; counts in rings stay exact. */
  truncated: boolean;
};

export type TraceView = {
  paths: { nodes: Summary[]; edges: GraphEdge[]; cost: number; confidence: Confidence }[];
};

export type TreeView = { tree: CallTree | undefined; nodes: Record<string, Summary> };

export type CycleView = Omit<Cycle, "members"> & { members: Summary[] };

export type CyclesView = { imports: CycleView[]; calls: CycleView[] };

export type InsightsView = {
  deadCode: (Summary & { lines: number })[];
  unusedExports: Summary[];
  hotspots: {
    modules: (Hotspots["modules"][number] & { node: Summary })[];
    classes: (Hotspots["classes"][number] & { node: Summary })[];
  };
  districts: (Omit<District, "modules"> & { modules: number; sample: Summary[] })[];
  /** Files changed most often, when git history is available. */
  churn: { file: string; commits: number; authors: number }[];
  /** Module-level variables changed by some code and used by other code. */
  state: { node: Summary; writers: Summary[]; readers: Summary[]; modules: number }[];
};

export type DsmView = {
  level: "module" | "directory";
  items: Summary[];
  /** [row, column, count]: row depends on column `count` times. */
  cells: [number, number, number][];
};

export type RoadsView = { depth: number; roads: Road[] };

/** A declaration in one file with its usage counts: what editors show above code. */
export type FileSymbol = Summary & {
  line: number;
  column: number;
  /** Distinct functions and entry points that call or create it. */
  callers: number;
  /** Distinct nodes that depend on it in any way (calls, references, inheritance, ...). */
  dependents: number;
};

export type DependencyView = { source: Summary; target: Summary };

/** How the architecture changed between two versions (see `diffGraphs`), ready to show. */
export type DiffView = {
  /** What was compared, such as `main` and `working tree`. */
  before: { label: string; scannedAt: string };
  after: { label: string; scannedAt: string };
  modules: { added: Summary[]; removed: Summary[] };
  symbols: { added: Summary[]; removed: Summary[] };
  dependencies: { added: DependencyView[]; removed: DependencyView[] };
  directories: { added: DependencyView[]; removed: DependencyView[] };
  cycles: { introduced: Summary[][]; resolved: Summary[][] };
  api: {
    added: Summary[];
    removed: Summary[];
    changed: { node: Summary; before: string; after: string }[];
  };
  routes: { added: Summary[]; removed: Summary[] };
  coupling: { node: Summary; before: number; after: number }[];
};

/** Revisions to compare the working tree with: branches and recent commits. */
export type RevisionsView = {
  /** The checked-out branch, or HEAD when detached. */
  current: string;
  branches: string[];
  commits: { sha: string; subject: string; date: string }[];
};
