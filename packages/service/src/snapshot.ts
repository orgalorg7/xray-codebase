import type { Snapshot } from "./types.js";

/** A snapshot as plain data (exports, stored maps): sources, when present, as a map. */
export type SnapshotData = Omit<Snapshot, "sources"> & { sources?: Record<string, string> };

/** The snapshot as plain data, with the source text of every module when `withSources`. */
export function snapshotData(snapshot: Snapshot, withSources: boolean): SnapshotData {
  const { sources, ...rest } = snapshot;
  const data: SnapshotData = rest;
  if (withSources && sources) {
    const read = typeof sources === "function" ? sources : (path: string) => sources[path];
    const map: Record<string, string> = {};
    for (const node of snapshot.graph.nodes) {
      if (node.kind !== "module") continue;
      const text = read(node.qualifiedName);
      if (text !== undefined) map[node.qualifiedName] = text;
    }
    data.sources = map;
  }
  return data;
}
