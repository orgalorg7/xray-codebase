import { Engine } from "@xray/engine";
import type { Confidence, EdgeKind, GraphEdge, GraphNode, NodeKind } from "@xray/schema";
import { GraphStore } from "@xray/store";
import { loadFixture } from "@xray/testkit";
import { GraphIndex } from "../src/index.js";

/** Scans a golden fixture with the real engine and indexes the result. */
export async function fixtureIndex(name: string): Promise<GraphIndex> {
  const store = GraphStore.open(":memory:");
  await new Engine({ root: loadFixture(name).dir, store }).scan();
  const index = new GraphIndex(store.exportGraph());
  store.close();
  return index;
}

/**
 * A tiny graph DSL. `n("ts:a.ts#f", "function")` declares a node (its module is created and
 * linked by `contains` automatically); `e(source, kind, target)` adds an edge.
 */
export function graph(
  build: (api: {
    n: (id: string, kind?: NodeKind, extra?: Partial<GraphNode>) => string;
    e: (
      source: string,
      kind: EdgeKind,
      target: string,
      confidence?: Confidence,
      extra?: Partial<GraphEdge>,
    ) => void;
  }) => void,
): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const ensure = (id: string, kind: NodeKind, extra: Partial<GraphNode> = {}): string => {
    if (!nodes.has(id)) {
      const name = id.split(/[#.:/]/).at(-1) ?? id;
      nodes.set(id, { id, kind, name, qualifiedName: id.split("#")[1] ?? id, ...extra });
    } else Object.assign(nodes.get(id) as GraphNode, extra);
    return id;
  };
  build({
    n: (id, kind = "function", extra = {}) => {
      const hash = id.indexOf("#");
      if (hash > 0) {
        const mod = ensure(id.slice(0, hash), "module");
        const qn = id.slice(hash + 1);
        const parent = qn.includes(".") ? `${mod}#${qn.slice(0, qn.lastIndexOf("."))}` : mod;
        edges.push({ source: parent, target: id, kind: "contains", confidence: "exact" });
      }
      return ensure(id, kind, extra);
    },
    e: (source, kind, target, confidence = "exact", extra = {}) => {
      edges.push({ source, target, kind, confidence, ...extra });
    },
  });
  return new GraphIndex({ nodes: [...nodes.values()], edges });
}
