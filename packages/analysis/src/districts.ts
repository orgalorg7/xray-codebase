import { compareStrings, type GraphIndex } from "./graph-index.js";
import { moduleGraph } from "./metrics.js";

export type District = {
  /** Stable within one graph: the index of the district by size. */
  id: number;
  /**
   * The deepest directory the members share, e.g. `src/auth`, plus the best-connected module
   * names when several districts share that directory: `tests · basic, blueprints`.
   */
  name: string;
  /** Module names (without extension) of the most connected members, best first. */
  highlights: string[];
  modules: string[];
};

type Weighted = Map<string, Map<string, number>>;

function undirected(
  directed: Map<string, Map<string, number>>,
  nodes: readonly string[],
): Weighted {
  const graph: Weighted = new Map(nodes.map((id) => [id, new Map()]));
  for (const [a, row] of directed) {
    for (const [b, w] of row) {
      if (!graph.has(a) || !graph.has(b) || a === b) continue;
      graph.get(a)?.set(b, (graph.get(a)?.get(b) ?? 0) + w);
      graph.get(b)?.set(a, (graph.get(b)?.get(a) ?? 0) + w);
    }
  }
  return graph;
}

/** One Louvain level: greedy local moves until no node improves modularity. */
function localMoves(graph: Weighted): Map<string, string> {
  const ids = [...graph.keys()].sort();
  const degree = new Map(
    ids.map((id) => [id, [...(graph.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0)]),
  );
  const m2 = [...degree.values()].reduce((a, b) => a + b, 0);
  const community = new Map(ids.map((id) => [id, id]));
  const total = new Map(ids.map((id) => [id, degree.get(id) ?? 0]));
  if (m2 === 0) return community;
  let improved = true;
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (const id of ids) {
      const current = community.get(id) as string;
      const k = degree.get(id) ?? 0;
      const links = new Map<string, number>();
      for (const [neighbor, w] of graph.get(id) ?? []) {
        if (neighbor === id) continue;
        const c = community.get(neighbor) as string;
        links.set(c, (links.get(c) ?? 0) + w);
      }
      total.set(current, (total.get(current) ?? 0) - k);
      let best = current;
      let bestGain = (links.get(current) ?? 0) - ((total.get(current) ?? 0) * k) / m2;
      for (const [c, w] of [...links].sort(([a], [b]) => compareStrings(a, b))) {
        const gain = w - ((total.get(c) ?? 0) * k) / m2;
        if (gain > bestGain + 1e-12) {
          best = c;
          bestGain = gain;
        }
      }
      total.set(best, (total.get(best) ?? 0) + k);
      if (best !== current) {
        community.set(id, best);
        improved = true;
      }
    }
  }
  return community;
}

function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split("/").slice(0, -1));
  const first = split[0] as string[];
  let depth = 0;
  while (depth < first.length && split.every((parts) => parts[depth] === first[depth])) depth++;
  if (depth > 0) return first.slice(0, depth).join("/");
  // No shared prefix: name after the most common top-level directory.
  const counts = new Map<string, number>();
  for (const parts of split) counts.set(parts[0] ?? ".", (counts.get(parts[0] ?? ".") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0] ?? "";
}

/**
 * Groups modules into "districts" that depend on each other more than on the rest (Louvain
 * community detection on the module dependency graph). Deterministic for a given graph.
 */
export function districts(index: GraphIndex): District[] {
  const modules = index
    .byKind("module")
    .map((m) => m.id)
    .sort();
  let graph = undirected(moduleGraph(index), modules);
  // members[c] = original modules represented by aggregated node c
  let members = new Map(modules.map((id) => [id, [id]]));
  for (let level = 0; level < 10; level++) {
    const community = localMoves(graph);
    const groups = new Map<string, string[]>();
    for (const [id, c] of community) groups.set(c, [...(groups.get(c) ?? []), id]);
    if (groups.size === graph.size) break;
    const nextMembers = new Map<string, string[]>();
    for (const [c, ids] of groups)
      nextMembers.set(
        c,
        ids.flatMap((id) => members.get(id) ?? []),
      );
    const next: Weighted = new Map([...groups.keys()].map((c) => [c, new Map()]));
    for (const [a, row] of graph) {
      for (const [b, w] of row) {
        // Weight inside a community stays as a self-loop, so its degree is preserved.
        const ca = community.get(a) as string;
        const cb = community.get(b) as string;
        next.get(ca)?.set(cb, (next.get(ca)?.get(cb) ?? 0) + w);
      }
    }
    graph = next;
    members = nextMembers;
  }
  const pathOf = (id: string): string => index.node(id)?.qualifiedName ?? id;
  const full = undirected(moduleGraph(index), modules);
  const stemOf = (id: string): string =>
    (pathOf(id).split("/").at(-1) ?? id)
      .replace(/\.[^.]+$/, "")
      .replace(/^__init__$/, pathOf(id).split("/").at(-2) ?? "__init__");
  const groups = [...members.values()]
    .map((ids) => ids.sort())
    .sort((a, b) => b.length - a.length || compareStrings(a[0] ?? "", b[0] ?? ""));
  const result = groups.map((ids, i) => {
    const set = new Set(ids);
    const internal = (id: string): number =>
      [...(full.get(id) ?? [])].reduce((sum, [other, w]) => sum + (set.has(other) ? w : 0), 0);
    const highlights = [...ids]
      .sort((a, b) => internal(b) - internal(a) || compareStrings(a, b))
      .slice(0, 3)
      .map(stemOf);
    return { id: i, name: commonDirectory(ids.map(pathOf)) || ".", highlights, modules: ids };
  });
  const counts = new Map<string, number>();
  for (const d of result) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  for (const d of result) {
    if ((counts.get(d.name) ?? 0) > 1)
      d.name = `${d.name} · ${d.highlights.slice(0, 2).join(", ")}`;
  }
  return result;
}
