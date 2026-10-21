import { compareStrings } from "@xray/analysis";

export type FocusEdge = { source: string; target: string };

export type FocusLayout = {
  positions: Map<string, { x: number; y: number; layer: number }>;
  width: number;
  height: number;
  /** Edges reversed to break cycles before layering (drawn as back edges). */
  reversed: Set<string>;
};

const key = (e: FocusEdge): string => `${e.source}\u0000${e.target}`;

/**
 * A layered (Sugiyama-style) left-to-right layout for small graphs such as a cycle or a call
 * tree: break cycles, assign layers by longest path, order layers by barycenters.
 */
export function layeredLayout(
  nodes: readonly string[],
  edges: readonly FocusEdge[],
  options: { layerGap?: number; nodeGap?: number } = {},
): FocusLayout {
  const layerGap = options.layerGap ?? 180;
  const nodeGap = options.nodeGap ?? 56;
  const ids = [...new Set(nodes)];
  const valid = edges.filter(
    (e) => e.source !== e.target && ids.includes(e.source) && ids.includes(e.target),
  );

  // 1. Break cycles: edges that close a DFS cycle are reversed.
  const reversed = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const out = new Map(ids.map((id) => [id, valid.filter((e) => e.source === id)]));
  const dfs = (id: string): void => {
    state.set(id, 1);
    for (const edge of out.get(id) ?? []) {
      const s = state.get(edge.target);
      if (s === 1) reversed.add(key(edge));
      else if (s === undefined) dfs(edge.target);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) dfs(id);
  const dag = valid.map((e) => (reversed.has(key(e)) ? { source: e.target, target: e.source } : e));

  // 2. Layers: longest path from the sources.
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of dag) {
      const next = (layer.get(e.source) ?? 0) + 1;
      if (next > (layer.get(e.target) ?? 0)) {
        layer.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers: string[][] = [];
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    layers[l] ??= [];
    layers[l]?.push(id);
  }

  // 3. Order within layers by the average position of neighbours, sweeping both ways.
  const position = new Map<string, number>();
  for (const l of layers) {
    for (const [i, id] of (l ?? []).entries()) position.set(id, i);
  }
  const neighbours = (id: string, dir: "up" | "down") =>
    dag
      .filter((e) => (dir === "up" ? e.target === id : e.source === id))
      .map((e) => (dir === "up" ? e.source : e.target));
  for (let sweep = 0; sweep < 4; sweep++) {
    const dir = sweep % 2 === 0 ? "up" : "down";
    const order = dir === "up" ? layers : [...layers].reverse();
    for (const l of order) {
      if (!l) continue;
      const bary = new Map(
        l.map((id) => {
          const ns = neighbours(id, dir);
          return [
            id,
            ns.length === 0
              ? (position.get(id) ?? 0)
              : ns.reduce((s, n) => s + (position.get(n) ?? 0), 0) / ns.length,
          ];
        }),
      );
      l.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || compareStrings(a, b));
      for (const [i, id] of l.entries()) position.set(id, i);
    }
  }

  const tallest = Math.max(1, ...layers.map((l) => l?.length ?? 0));
  const positions = new Map<string, { x: number; y: number; layer: number }>();
  layers.forEach((l, li) => {
    const offset = ((tallest - (l?.length ?? 0)) * nodeGap) / 2;
    for (const [i, id] of (l ?? []).entries()) {
      positions.set(id, { x: li * layerGap, y: offset + i * nodeGap, layer: li });
    }
  });
  return {
    positions,
    width: Math.max(0, layers.length - 1) * layerGap,
    height: (tallest - 1) * nodeGap,
    reversed,
  };
}
