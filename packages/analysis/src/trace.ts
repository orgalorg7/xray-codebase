import type { Confidence, EdgeKind, GraphEdge } from "@xray/schema";
import { CALL_KINDS, compareStrings, type GraphIndex, weakest } from "./graph-index.js";

/** Guessed links cost more, so the best route prefers what the analyzer is sure about. */
const COST: Record<Confidence, number> = { exact: 1, inferred: 1.5, heuristic: 4 };

export type TraceOptions = {
  /** How many alternative routes to return (default 3). */
  k?: number;
  kinds?: readonly EdgeKind[];
  /** Longest route considered, in hops (default 25). */
  maxHops?: number;
};

export type TracePath = {
  /** Node IDs from start to end. */
  nodes: string[];
  /** The edge taken into each node after the first. */
  edges: GraphEdge[];
  cost: number;
  confidence: Confidence;
};

type Search = { banned: Set<string>; bannedNodes: Set<string> };

const edgeId = (edge: GraphEdge): string => `${edge.source}\u0000${edge.target}`;

class MinHeap<T> {
  readonly #items: { key: number; value: T }[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(key: number, value: T): void {
    const items = this.#items;
    items.push({ key, value });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((items[p] as { key: number }).key <= key) break;
      [items[i], items[p]] = [
        items[p] as (typeof items)[number],
        items[i] as (typeof items)[number],
      ];
      i = p;
    }
  }
  pop(): { key: number; value: T } | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (
          l < items.length &&
          (items[l] as { key: number }).key < (items[m] as { key: number }).key
        )
          m = l;
        if (
          r < items.length &&
          (items[r] as { key: number }).key < (items[m] as { key: number }).key
        )
          m = r;
        if (m === i) break;
        [items[i], items[m]] = [
          items[m] as (typeof items)[number],
          items[i] as (typeof items)[number],
        ];
        i = m;
      }
    }
    return top;
  }
}

/** Cheapest outgoing edge per target, so parallel call sites do not multiply routes. */
function bestEdges(index: GraphIndex, id: string, kinds: readonly EdgeKind[]): GraphEdge[] {
  const best = new Map<string, GraphEdge>();
  for (const edge of index.out(id, kinds)) {
    const current = best.get(edge.target);
    if (!current || COST[edge.confidence] < COST[current.confidence]) best.set(edge.target, edge);
  }
  return [...best.values()];
}

function dijkstra(
  index: GraphIndex,
  sources: readonly string[],
  goals: ReadonlySet<string>,
  kinds: readonly EdgeKind[],
  maxHops: number,
  search: Search,
): TracePath | undefined {
  const dist = new Map<string, number>();
  const hops = new Map<string, number>();
  const via = new Map<string, GraphEdge>();
  const heap = new MinHeap<string>();
  for (const source of sources) {
    if (search.bannedNodes.has(source)) continue;
    dist.set(source, 0);
    hops.set(source, 0);
    heap.push(0, source);
  }
  while (heap.size > 0) {
    const { key, value: id } = heap.pop() as { key: number; value: string };
    if (key > (dist.get(id) ?? Number.POSITIVE_INFINITY)) continue;
    if (goals.has(id) && !sources.includes(id)) {
      const nodes = [id];
      const edges: GraphEdge[] = [];
      let step = id;
      let confidence: Confidence = "exact";
      while (via.has(step)) {
        const edge = via.get(step) as GraphEdge;
        edges.unshift(edge);
        confidence = weakest(confidence, edge.confidence);
        step = edge.source;
        nodes.unshift(step);
      }
      return { nodes, edges, cost: key, confidence };
    }
    if ((hops.get(id) ?? 0) >= maxHops) continue;
    for (const edge of bestEdges(index, id, kinds)) {
      if (search.banned.has(edgeId(edge)) || search.bannedNodes.has(edge.target)) continue;
      const next = key + COST[edge.confidence];
      if (next < (dist.get(edge.target) ?? Number.POSITIVE_INFINITY)) {
        dist.set(edge.target, next);
        hops.set(edge.target, (hops.get(id) ?? 0) + 1);
        via.set(edge.target, edge);
        heap.push(next, edge.target);
      }
    }
  }
  return undefined;
}

/**
 * Up to `k` cheapest distinct routes from `from` to `to` (Yen's algorithm). Either end may be
 * a container (module, class), meaning any symbol inside it.
 */
export function tracePaths(
  index: GraphIndex,
  from: string,
  to: string,
  options: TraceOptions = {},
): TracePath[] {
  const k = options.k ?? 3;
  const kinds = options.kinds ?? CALL_KINDS;
  const maxHops = options.maxHops ?? 25;
  if (!index.node(from) || !index.node(to)) return [];
  const sources = index.descendants(from);
  const goals = new Set(index.descendants(to));
  const first = dijkstra(index, sources, goals, kinds, maxHops, {
    banned: new Set(),
    bannedNodes: new Set(),
  });
  if (!first) return [];

  const found: TracePath[] = [first];
  const candidates: TracePath[] = [];
  const key = (path: TracePath): string => path.nodes.join("\u0001");
  for (let n = 1; n < k; n++) {
    const previous = found[n - 1] as TracePath;
    for (let i = 0; i < previous.nodes.length - 1; i++) {
      const spur = previous.nodes[i] as string;
      const rootNodes = previous.nodes.slice(0, i + 1);
      const rootEdges = previous.edges.slice(0, i);
      const banned = new Set<string>();
      for (const path of found) {
        if (path.nodes.slice(0, i + 1).join("\u0001") === rootNodes.join("\u0001")) {
          const edge = path.edges[i];
          if (edge) banned.add(edgeId(edge));
        }
      }
      const bannedNodes = new Set(rootNodes.slice(0, -1));
      const spurPath = dijkstra(index, [spur], goals, kinds, maxHops - i, { banned, bannedNodes });
      if (!spurPath) continue;
      const edges = [...rootEdges, ...spurPath.edges];
      const candidate: TracePath = {
        nodes: [...rootNodes.slice(0, -1), ...spurPath.nodes],
        edges,
        cost: edges.reduce((sum, edge) => sum + COST[edge.confidence], 0),
        confidence: edges.reduce<Confidence>((c, edge) => weakest(c, edge.confidence), "exact"),
      };
      if (
        !found.some((p) => key(p) === key(candidate)) &&
        !candidates.some((p) => key(p) === key(candidate))
      ) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) break;
    candidates.sort(
      (a, b) =>
        a.cost - b.cost || a.nodes.length - b.nodes.length || compareStrings(key(a), key(b)),
    );
    found.push(candidates.shift() as TracePath);
  }
  return found;
}

export type CallTree = {
  id: string;
  /** The edge from the parent (absent at the root). */
  edge?: GraphEdge;
  children: CallTree[];
  /** Already on the path from the root: not expanded again. */
  recursive?: true;
  /** Expansion stopped at the depth or breadth limit. */
  truncated?: true;
};

/**
 * What `root` calls (direction `out`), or what calls it (`in`), as a tree. Each node appears
 * once per branch; cycles are marked instead of expanded.
 */
export function callTree(
  index: GraphIndex,
  root: string,
  options: {
    direction?: "out" | "in";
    depth?: number;
    breadth?: number;
    kinds?: readonly EdgeKind[];
  } = {},
): CallTree | undefined {
  if (!index.node(root)) return undefined;
  const direction = options.direction ?? "out";
  const depth = options.depth ?? 3;
  const breadth = options.breadth ?? 50;
  const kinds = options.kinds ?? CALL_KINDS;
  const build = (
    id: string,
    edge: GraphEdge | undefined,
    level: number,
    path: Set<string>,
  ): CallTree => {
    const tree: CallTree = { id, children: [], ...(edge ? { edge } : {}) };
    if (path.has(id)) return { ...tree, recursive: true };
    const edges = direction === "out" ? index.out(id, kinds) : index.in(id, kinds);
    const unique = new Map<string, GraphEdge>();
    for (const e of edges) {
      const other = direction === "out" ? e.target : e.source;
      if (other !== id && !unique.has(other)) unique.set(other, e);
    }
    if (unique.size === 0) return tree;
    if (level >= depth) return { ...tree, truncated: true };
    const next = new Set(path).add(id);
    const entries = [...unique].sort(([a], [b]) => compareStrings(a, b));
    tree.children = entries.slice(0, breadth).map(([other, e]) => build(other, e, level + 1, next));
    if (entries.length > breadth) tree.truncated = true;
    return tree;
  };
  return build(root, undefined, 0, new Set());
}
