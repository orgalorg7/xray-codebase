import type { EdgeKind, GraphNode } from "@xray/schema";
import {
  CALL_KINDS,
  compareStrings,
  DEPENDENCY_KINDS,
  ENTRY_POINT_KINDS,
  type GraphIndex,
  isTestPath,
} from "./graph-index.js";

export type NodeMetrics = {
  /** Distinct nodes that depend on this one. */
  fanIn: number;
  /** Distinct nodes this one depends on. */
  fanOut: number;
  /** PageRank over dependencies: high for code that much else builds on. Sums to 1. */
  centrality: number;
  /** Source lines spanned by the node's declaration. */
  lines: number;
};

const linesOf = (node: GraphNode): number =>
  node.location ? (node.location.endLine ?? node.location.line) - node.location.line + 1 : 0;

/** Fan-in, fan-out, centrality and size for every node. */
export function nodeMetrics(index: GraphIndex): Map<string, NodeMetrics> {
  const metrics = new Map<string, NodeMetrics>();
  const outSets = new Map<string, Set<string>>();
  const inSets = new Map<string, Set<string>>();
  for (const edge of index.edges) {
    if (edge.kind === "contains" || edge.source === edge.target) continue;
    (outSets.get(edge.source) ?? outSets.set(edge.source, new Set()).get(edge.source))?.add(
      edge.target,
    );
    (inSets.get(edge.target) ?? inSets.set(edge.target, new Set()).get(edge.target))?.add(
      edge.source,
    );
  }
  const centrality = pageRank(index, outSets);
  for (const node of index.nodes.values()) {
    metrics.set(node.id, {
      fanIn: inSets.get(node.id)?.size ?? 0,
      fanOut: outSets.get(node.id)?.size ?? 0,
      centrality: centrality.get(node.id) ?? 0,
      lines: linesOf(node),
    });
  }
  // Module lines are the file length: the furthest end of anything inside it.
  for (const mod of index.byKind("module")) {
    const end = Math.max(
      0,
      ...index.descendants(mod.id).map((id) => index.node(id)?.location?.endLine ?? 0),
    );
    const entry = metrics.get(mod.id);
    if (entry) entry.lines = end;
  }
  return metrics;
}

function pageRank(
  index: GraphIndex,
  out: Map<string, Set<string>>,
  iterations = 30,
  damping = 0.85,
): Map<string, number> {
  const ids = [...index.nodes.keys()];
  const n = ids.length || 1;
  let rank = new Map(ids.map((id) => [id, 1 / n]));
  for (let i = 0; i < iterations; i++) {
    const next = new Map(ids.map((id) => [id, (1 - damping) / n]));
    let dangling = 0;
    for (const id of ids) {
      const targets = out.get(id);
      const value = rank.get(id) ?? 0;
      if (!targets || targets.size === 0) {
        dangling += value;
        continue;
      }
      for (const target of targets)
        next.set(target, (next.get(target) ?? 0) + (damping * value) / targets.size);
    }
    for (const id of ids) next.set(id, (next.get(id) ?? 0) + (damping * dangling) / n);
    rank = next;
  }
  return rank;
}

/** Aggregated dependencies between modules: how much each module uses each other module. */
export function moduleGraph(index: GraphIndex): Map<string, Map<string, number>> {
  const graph = new Map<string, Map<string, number>>();
  for (const edge of index.edges) {
    if (!DEPENDENCY_KINDS.includes(edge.kind)) continue;
    const a = index.moduleOf(edge.source);
    const b = index.moduleOf(edge.target);
    if (!a || !b || a === b) continue;
    const row = graph.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    graph.set(a, row);
  }
  return graph;
}

export type DeadSymbol = {
  id: string;
  kind: GraphNode["kind"];
  module: string | undefined;
  lines: number;
};

export type DeadCodeOptions = {
  /** Treat exported symbols as used from outside the repo (default true: libraries). */
  assumeExportsUsed?: boolean;
};

const DEAD_CANDIDATES: ReadonlySet<GraphNode["kind"]> = new Set([
  "function",
  "method",
  "class",
  "component",
  "variable",
]);
const REACH_KINDS: readonly EdgeKind[] = [
  ...CALL_KINDS,
  "references",
  "re-exports",
  "extends",
  "implements",
  "type-of",
  "decorates",
];

/**
 * Functions, methods and classes nothing reachable uses, and variables nothing references.
 * Roots are module top-level code and initializers (they run on load), entry points, tests,
 * framework-decorated functions and (by default) exports and their public methods. Results are
 * candidates: dynamic calls the analyzer cannot see keep code alive too.
 */
export function deadCode(index: GraphIndex, options: DeadCodeOptions = {}): DeadSymbol[] {
  const assumeExportsUsed = options.assumeExportsUsed ?? true;
  const roots: string[] = [];
  const isPublic = (name: string): boolean => !name.startsWith("_") && !name.startsWith("#");
  for (const node of index.nodes.values()) {
    // Public methods of exported classes are API too.
    const parent = index.parent(node.id);
    if (
      assumeExportsUsed &&
      node.kind === "method" &&
      isPublic(node.name) &&
      parent !== undefined &&
      index.node(parent)?.exported === true
    ) {
      roots.push(node.id);
      continue;
    }
    const decorated = Array.isArray(node.meta?.decorators) && node.meta.decorators.length > 0;
    if (
      node.kind === "module" ||
      // Variable and class attribute initializers run when the code loads.
      node.kind === "variable" ||
      node.kind === "property" ||
      node.kind === "test" ||
      ENTRY_POINT_KINDS.has(node.kind) ||
      decorated ||
      (assumeExportsUsed && node.exported === true)
    ) {
      roots.push(node.id);
    }
  }
  const alive = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (alive.has(id)) continue;
    alive.add(id);
    for (const edge of index.out(id, REACH_KINDS)) stack.push(edge.target);
    // Dynamic dispatch: a live method keeps its overrides alive.
    for (const edge of index.in(id, ["overrides"])) stack.push(edge.source);
  }
  // Members of live classes that the runtime calls implicitly.
  const implicit = (node: GraphNode): boolean =>
    /^(constructor|__\w+__)$/.test(node.name) ||
    node.meta?.accessor !== undefined ||
    index.out(node.id, ["overrides"]).length > 0;
  for (const node of index.nodes.values()) {
    const parent = index.parent(node.id);
    if (node.kind === "method" && parent && alive.has(parent) && implicit(node)) alive.add(node.id);
  }
  return (
    [...index.nodes.values()]
      .filter((node) =>
        node.kind === "variable"
          ? !(assumeExportsUsed && node.exported === true) &&
            !index.in(node.id, DEPENDENCY_KINDS).some((edge) => edge.source !== node.id)
          : DEAD_CANDIDATES.has(node.kind) && !alive.has(node.id),
      )
      // A method of a dead class is reported through its class.
      .filter((node) => !(node.kind === "method" && !alive.has(index.parent(node.id) ?? "")))
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        module: index.moduleOf(node.id),
        lines: linesOf(node),
      }))
      .sort((a, b) => compareStrings(a.id, b.id))
  );
}

/**
 * Exported top-level symbols no other module uses (re-exports count as use). Skips modules
 * whose exports are implicit (Python without `__all__`) and test files.
 */
export function unusedExports(index: GraphIndex): string[] {
  return [...index.nodes.values()]
    .filter((node) => node.exported === true)
    .filter((node) => {
      const mod = index.node(index.moduleOf(node.id) ?? "");
      return (
        mod !== undefined && mod.meta?.implicitExports !== true && !isTestPath(mod.qualifiedName)
      );
    })
    .filter((node) => {
      const own = index.moduleOf(node.id);
      return !index
        .in(node.id, DEPENDENCY_KINDS)
        .some((edge) => index.moduleOf(edge.source) !== own);
    })
    .map((node) => node.id)
    .sort();
}

export type Hotspots = {
  /** Modules that are very large or very connected. */
  modules: { id: string; lines: number; symbols: number; fanIn: number; fanOut: number }[];
  /** Classes with many methods or many dependencies. */
  classes: { id: string; methods: number; fanOut: number }[];
};

/** Likely refactoring targets: oversized or over-connected modules and classes. */
export function hotspots(
  index: GraphIndex,
  metrics: Map<string, NodeMetrics> = nodeMetrics(index),
): Hotspots {
  const graph = moduleGraph(index);
  const incoming = new Map<string, number>();
  for (const row of graph.values())
    for (const target of row.keys()) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  const modules = index.byKind("module").map((mod) => ({
    id: mod.id,
    lines: metrics.get(mod.id)?.lines ?? 0,
    symbols: index.children(mod.id).length,
    fanIn: incoming.get(mod.id) ?? 0,
    fanOut: graph.get(mod.id)?.size ?? 0,
  }));
  const degrees = modules.map((m) => m.fanIn + m.fanOut).sort((a, b) => a - b);
  const p95 = degrees[Math.floor(degrees.length * 0.95)] ?? 0;
  const classes = index
    .byKind("class")
    .map((cls) => {
      const members = index.children(cls.id).filter((id) => index.node(id)?.kind === "method");
      const fanOut = new Set(
        [cls.id, ...members].flatMap((id) => index.out(id, DEPENDENCY_KINDS).map((e) => e.target)),
      ).size;
      return { id: cls.id, methods: members.length, fanOut };
    })
    .filter((c) => c.methods > 25 || c.fanOut > 40)
    .sort((a, b) => b.methods + b.fanOut - (a.methods + a.fanOut) || compareStrings(a.id, b.id));
  return {
    modules: modules
      .filter(
        (m) =>
          m.lines > 800 || m.symbols > 40 || (m.fanIn + m.fanOut >= Math.max(10, p95) && p95 > 0),
      )
      .sort((a, b) => b.lines - a.lines || compareStrings(a.id, b.id)),
    classes,
  };
}
