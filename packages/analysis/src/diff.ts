import type { Graph, GraphNode } from "@xray/schema";
import { importCycles } from "./cycles.js";
import { GraphIndex } from "./graph-index.js";

/** A dependency between two modules or two directories, by ID. */
export type Dependency = { source: string; target: string };

/**
 * How the architecture changed between two versions of a repository: what appeared and
 * disappeared at each level (modules, symbols, dependencies, directories), import cycles
 * introduced and resolved, the exported API, routes, and the biggest shifts in coupling.
 */
export type ArchitectureDiff = {
  modules: { added: string[]; removed: string[] };
  /** Declarations (classes, functions, methods, routes…), not modules or directories. */
  symbols: { added: string[]; removed: string[] };
  /** Module → module imports. */
  dependencies: { added: Dependency[]; removed: Dependency[] };
  /** Directory → directory dependencies: the architecture at a coarser grain. */
  directories: { added: Dependency[]; removed: Dependency[] };
  /** Import cycles, each as its sorted module IDs. */
  cycles: { introduced: string[][]; resolved: string[][] };
  /** Exported symbols: added, removed, or with a different signature. */
  api: {
    added: string[];
    removed: string[];
    changed: { id: string; before: string; after: string }[];
  };
  routes: { added: string[]; removed: string[] };
  /** Modules whose number of importers changed the most. */
  coupling: { id: string; before: number; after: number }[];
};

const STRUCTURAL = new Set(["repo", "directory", "package", "module", "external"]);

/** Module-level imports between project modules, deduplicated. */
function moduleDependencies(
  index: GraphIndex,
  graph: Pick<Graph, "edges">,
): Map<string, Dependency> {
  const deps = new Map<string, Dependency>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports" || edge.source === edge.target) continue;
    if (index.node(edge.source)?.kind !== "module" || index.node(edge.target)?.kind !== "module")
      continue;
    deps.set(`${edge.source}\u0000${edge.target}`, { source: edge.source, target: edge.target });
  }
  return deps;
}

/** The directory containing a module (its nearest directory ancestor). */
function directoryOf(index: GraphIndex, id: string): string | undefined {
  for (let parent = index.parent(id); parent; parent = index.parent(parent)) {
    const kind = index.node(parent)?.kind;
    if (kind === "directory" || kind === "repo") return parent;
  }
  return undefined;
}

function directoryDependencies(
  index: GraphIndex,
  modules: Iterable<Dependency>,
): Map<string, Dependency> {
  const deps = new Map<string, Dependency>();
  for (const dep of modules) {
    const source = directoryOf(index, dep.source);
    const target = directoryOf(index, dep.target);
    if (!source || !target || source === target) continue;
    deps.set(`${source}\u0000${target}`, { source, target });
  }
  return deps;
}

const added = <T>(before: Map<string, T>, after: Map<string, T>): T[] =>
  [...after].filter(([key]) => !before.has(key)).map(([, value]) => value);

function importers(deps: Map<string, Dependency>): Map<string, number> {
  const count = new Map<string, number>();
  for (const dep of deps.values()) count.set(dep.target, (count.get(dep.target) ?? 0) + 1);
  return count;
}

/** Compares two graphs of the same repository (IDs are stable between versions). */
export function diffGraphs(
  before: Pick<Graph, "nodes" | "edges">,
  after: Pick<Graph, "nodes" | "edges">,
): ArchitectureDiff {
  const a = new GraphIndex(before);
  const b = new GraphIndex(after);
  const nodesOf = (graph: Pick<Graph, "nodes">, keep: (n: GraphNode) => boolean) =>
    new Map(graph.nodes.filter(keep).map((n) => [n.id, n]));

  const modulesA = nodesOf(before, (n) => n.kind === "module");
  const modulesB = nodesOf(after, (n) => n.kind === "module");
  const symbolsA = nodesOf(before, (n) => !STRUCTURAL.has(n.kind));
  const symbolsB = nodesOf(after, (n) => !STRUCTURAL.has(n.kind));
  const ids = (nodes: GraphNode[]) => nodes.map((n) => n.id).sort();

  const depsA = moduleDependencies(a, before);
  const depsB = moduleDependencies(b, after);
  const dirsA = directoryDependencies(a, depsA.values());
  const dirsB = directoryDependencies(b, depsB.values());
  const byKey = (d: Dependency) => `${d.source} ${d.target}`;
  const sortDeps = (deps: Dependency[]) => deps.sort((x, y) => byKey(x).localeCompare(byKey(y)));

  const cyclesOf = (index: GraphIndex) =>
    new Map(importCycles(index).map((c) => [c.members.join("\u0000"), c.members]));
  const cyclesA = cyclesOf(a);
  const cyclesB = cyclesOf(b);

  const apiA = nodesOf(before, (n) => n.exported === true && !STRUCTURAL.has(n.kind));
  const apiB = nodesOf(after, (n) => n.exported === true && !STRUCTURAL.has(n.kind));
  const changed = [...apiB.values()]
    .filter((n) => {
      const old = apiA.get(n.id);
      return (
        old?.signature !== undefined && n.signature !== undefined && old.signature !== n.signature
      );
    })
    .map((n) => ({
      id: n.id,
      before: apiA.get(n.id)?.signature as string,
      after: n.signature as string,
    }))
    .sort((x, y) => x.id.localeCompare(y.id));

  const routesA = nodesOf(before, (n) => n.kind === "route");
  const routesB = nodesOf(after, (n) => n.kind === "route");

  const fanA = importers(depsA);
  const fanB = importers(depsB);
  const coupling = [...new Set([...fanA.keys(), ...fanB.keys()])]
    .map((id) => ({ id, before: fanA.get(id) ?? 0, after: fanB.get(id) ?? 0 }))
    .filter((c) => Math.abs(c.after - c.before) >= 2)
    .sort(
      (x, y) =>
        Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || x.id.localeCompare(y.id),
    )
    .slice(0, 15);

  return {
    modules: { added: ids(added(modulesA, modulesB)), removed: ids(added(modulesB, modulesA)) },
    symbols: { added: ids(added(symbolsA, symbolsB)), removed: ids(added(symbolsB, symbolsA)) },
    dependencies: { added: sortDeps(added(depsA, depsB)), removed: sortDeps(added(depsB, depsA)) },
    directories: { added: sortDeps(added(dirsA, dirsB)), removed: sortDeps(added(dirsB, dirsA)) },
    cycles: { introduced: added(cyclesA, cyclesB), resolved: added(cyclesB, cyclesA) },
    api: { added: ids(added(apiA, apiB)), removed: ids(added(apiB, apiA)), changed },
    routes: { added: ids(added(routesA, routesB)), removed: ids(added(routesB, routesA)) },
    coupling,
  };
}
