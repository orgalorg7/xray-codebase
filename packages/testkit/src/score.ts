import type { EdgeKind, Graph } from "@xray/schema";
import type { ExpectedGraph } from "./fixtures.js";

export type EdgeKey = `${string} -${EdgeKind}-> ${string}`;

export const edgeKey = (edge: { source: string; kind: EdgeKind; target: string }): EdgeKey =>
  `${edge.source} -${edge.kind}-> ${edge.target}`;

export type KindScore = {
  kind: EdgeKind;
  expected: number;
  found: number;
  /** Share of found edges that are expected. 1 when nothing was found. */
  precision: number;
  /** Share of expected edges that were found. 1 when nothing was expected. */
  recall: number;
  missing: EdgeKey[];
  unexpected: EdgeKey[];
};

export type GraphScore = {
  missingNodes: string[];
  kinds: KindScore[];
  precision: number;
  recall: number;
};

const ratio = (hits: number, total: number): number => (total === 0 ? 1 : hits / total);

/**
 * Compares an extracted graph with a fixture's ground truth. Edges are compared as sets of
 * (source, kind, target), so several call sites of the same callee count once. Only the
 * fixture's `edgeKinds` are scored.
 */
export function scoreGraph(expected: ExpectedGraph, actual: Graph): GraphScore {
  const actualNodes = new Set(actual.nodes.map((node) => `${node.kind} ${node.id}`));
  const missingNodes = expected.nodes
    .filter((node) => !actualNodes.has(`${node.kind} ${node.id}`))
    .map((node) => node.id);

  let hits = 0;
  let expectedTotal = 0;
  let foundTotal = 0;
  const kinds = expected.edgeKinds.map((kind): KindScore => {
    const want = new Set(expected.edges.filter((e) => e.kind === kind).map(edgeKey));
    const got = new Set(actual.edges.filter((e) => e.kind === kind).map(edgeKey));
    const missing = [...want].filter((key) => !got.has(key)).sort();
    const unexpected = [...got].filter((key) => !want.has(key)).sort();
    const kindHits = want.size - missing.length;
    hits += kindHits;
    expectedTotal += want.size;
    foundTotal += got.size;
    return {
      kind,
      expected: want.size,
      found: got.size,
      precision: ratio(kindHits, got.size),
      recall: ratio(kindHits, want.size),
      missing,
      unexpected,
    };
  });

  return {
    missingNodes,
    kinds,
    precision: ratio(hits, foundTotal),
    recall: ratio(hits, expectedTotal),
  };
}
