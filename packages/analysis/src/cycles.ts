import type { GraphEdge } from "@xray/schema";
import { CALL_KINDS, compareStrings, type GraphIndex } from "./graph-index.js";

export type Cycle = {
  /** Sorted member IDs. */
  members: string[];
  /** Edges between members. */
  edges: GraphEdge[];
  /** A small set of edges whose removal leaves no cycle among the members. */
  cut: GraphEdge[];
};

export type ImportCycleOptions = {
  /** Ignore `import type` edges, which vanish at runtime. */
  ignoreTypeOnly?: boolean;
  /** Ignore imports made inside functions, which do not run at load time. */
  ignoreDeferred?: boolean;
};

/** Strongly connected components with more than one member (Tarjan, iterative). */
export function stronglyConnected(
  nodes: readonly string[],
  successors: (id: string) => readonly string[],
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { id: string; next: number; succ: readonly string[] }[] = [];
    const open = (id: string): void => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, next: 0, succ: successors(id) });
    };
    open(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as (typeof work)[number];
      if (frame.next < frame.succ.length) {
        const next = frame.succ[frame.next++] as string;
        if (!index.has(next)) open(next);
        else if (onStack.has(next))
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(next) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent)
        low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components;
}

/**
 * Edges to cut so the remaining graph is acyclic, using the Eades–Lin–Smyth ordering
 * heuristic with weights: cheap edges (type-only, deferred) are preferred cuts.
 */
export function feedbackArcs(
  members: readonly string[],
  edges: readonly GraphEdge[],
  weight: (edge: GraphEdge) => number,
): GraphEdge[] {
  const remaining = new Set(members);
  const outW = new Map<string, number>();
  const inW = new Map<string, number>();
  const live = (edge: GraphEdge): boolean =>
    remaining.has(edge.source) && remaining.has(edge.target);
  const recompute = (): void => {
    outW.clear();
    inW.clear();
    for (const id of remaining) {
      outW.set(id, 0);
      inW.set(id, 0);
    }
    for (const edge of edges) {
      if (!live(edge) || edge.source === edge.target) continue;
      outW.set(edge.source, (outW.get(edge.source) ?? 0) + weight(edge));
      inW.set(edge.target, (inW.get(edge.target) ?? 0) + weight(edge));
    }
  };
  const head: string[] = [];
  const tail: string[] = [];
  while (remaining.size > 0) {
    recompute();
    const sorted = [...remaining].sort();
    const sink = sorted.find((id) => outW.get(id) === 0);
    if (sink !== undefined) {
      tail.unshift(sink);
      remaining.delete(sink);
      continue;
    }
    const source = sorted.find((id) => inW.get(id) === 0);
    if (source !== undefined) {
      head.push(source);
      remaining.delete(source);
      continue;
    }
    let best = sorted[0] as string;
    for (const id of sorted) {
      const delta = (outW.get(id) ?? 0) - (inW.get(id) ?? 0);
      if (delta > (outW.get(best) ?? 0) - (inW.get(best) ?? 0)) best = id;
    }
    head.push(best);
    remaining.delete(best);
  }
  const position = new Map([...head, ...tail].map((id, i) => [id, i]));
  return edges.filter(
    (edge) =>
      edge.source !== edge.target &&
      (position.get(edge.source) as number) > (position.get(edge.target) as number),
  );
}

const byMembers = (a: Cycle, b: Cycle): number =>
  b.members.length - a.members.length || compareStrings(a.members[0] ?? "", b.members[0] ?? "");

/** Circular imports between modules of the project (externals excluded). */
export function importCycles(index: GraphIndex, options: ImportCycleOptions = {}): Cycle[] {
  const keep = (edge: GraphEdge): boolean =>
    edge.kind === "imports" &&
    edge.source !== edge.target &&
    index.node(edge.target)?.kind === "module" &&
    !(options.ignoreTypeOnly && edge.detail === "type-only") &&
    !(options.ignoreDeferred && edge.detail === "deferred");
  const modules = index
    .byKind("module")
    .map((node) => node.id)
    .sort();
  const successors = (id: string): string[] =>
    index
      .out(id)
      .filter(keep)
      .map((edge) => edge.target);
  // Cheaper to cut: imports that only exist for types or at call time.
  const weight = (edge: GraphEdge): number =>
    edge.detail === "type-only"
      ? 0.25
      : edge.detail === "deferred" || edge.detail === "dynamic-import"
        ? 0.5
        : 1;

  return stronglyConnected(modules, successors)
    .map((members) => {
      const set = new Set(members);
      const edges = members.flatMap((id) =>
        index.out(id).filter((edge) => keep(edge) && set.has(edge.target)),
      );
      return { members, edges, cut: feedbackArcs(members, edges, weight) };
    })
    .sort(byMembers);
}

/** Groups of functions that call each other in a loop (mutual recursion). */
export function callCycles(index: GraphIndex): Cycle[] {
  const callables = [...index.nodes.values()]
    .filter((node) => node.kind !== "module" && node.kind !== "external")
    .map((node) => node.id)
    .sort();
  const keep = (edge: GraphEdge): boolean =>
    CALL_KINDS.includes(edge.kind) && edge.source !== edge.target;
  const successors = (id: string): string[] => [
    ...new Set(
      index
        .out(id)
        .filter(keep)
        .map((edge) => edge.target),
    ),
  ];
  return stronglyConnected(callables, successors)
    .map((members) => {
      const set = new Set(members);
      const edges = members.flatMap((id) =>
        index.out(id).filter((edge) => keep(edge) && set.has(edge.target)),
      );
      return { members, edges, cut: feedbackArcs(members, edges, () => 1) };
    })
    .sort(byMembers);
}
