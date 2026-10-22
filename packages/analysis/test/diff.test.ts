import type { Graph, GraphEdge, GraphNode } from "@xray/schema";
import { describe, expect, it } from "vitest";
import { diffGraphs } from "../src/index.js";

const mod = (path: string): GraphNode => ({
  id: `ts:${path}`,
  kind: "module",
  name: path.split("/").pop() as string,
  qualifiedName: path,
});
const dir = (path: string): GraphNode => ({
  id: `dir:${path}`,
  kind: "directory",
  name: path,
  qualifiedName: path,
});
const fn = (path: string, name: string, signature: string, exported = true): GraphNode => ({
  id: `ts:${path}#${name}`,
  kind: "function",
  name,
  qualifiedName: name,
  signature,
  exported,
});
const edge = (source: string, kind: GraphEdge["kind"], target: string): GraphEdge => ({
  source,
  target,
  kind,
  confidence: "exact",
});
const graph = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({ version: 1, nodes, edges });

describe("diffGraphs", () => {
  const skeleton = [dir("src/ui"), dir("src/db")];
  const contain = [
    edge("dir:src/ui", "contains", "ts:src/ui/page.ts"),
    edge("dir:src/db", "contains", "ts:src/db/store.ts"),
    edge("dir:src/db", "contains", "ts:src/db/pool.ts"),
  ];

  it("reports modules, symbols, dependencies, cycles, API and coupling changes", () => {
    const before = graph(
      [
        ...skeleton,
        mod("src/ui/page.ts"),
        mod("src/db/store.ts"),
        mod("src/db/pool.ts"),
        fn("src/db/store.ts", "save", "(x: string)"),
        fn("src/db/store.ts", "drop", "()"),
      ],
      [
        ...contain.filter((e) => !e.target.includes("pool")),
        edge("ts:src/db/store.ts", "contains", "ts:src/db/store.ts#save"),
      ],
    );
    const after = graph(
      [
        ...skeleton,
        mod("src/ui/page.ts"),
        mod("src/db/store.ts"),
        mod("src/db/pool.ts"),
        fn("src/db/store.ts", "save", "(x: string, y: number)"),
        fn("src/db/pool.ts", "open", "()"),
      ],
      [
        ...contain,
        edge("ts:src/ui/page.ts", "imports", "ts:src/db/store.ts"),
        edge("ts:src/db/store.ts", "imports", "ts:src/db/pool.ts"),
        edge("ts:src/db/pool.ts", "imports", "ts:src/db/store.ts"),
      ],
    );
    const diff = diffGraphs(before, after);
    expect(diff.dependencies.added).toEqual([
      { source: "ts:src/db/pool.ts", target: "ts:src/db/store.ts" },
      { source: "ts:src/db/store.ts", target: "ts:src/db/pool.ts" },
      { source: "ts:src/ui/page.ts", target: "ts:src/db/store.ts" },
    ]);
    // Only the dependency crossing directories shows at the directory level.
    expect(diff.directories.added).toEqual([{ source: "dir:src/ui", target: "dir:src/db" }]);
    expect(diff.cycles.introduced).toEqual([["ts:src/db/pool.ts", "ts:src/db/store.ts"]]);
    expect(diff.cycles.resolved).toEqual([]);
    expect(diff.symbols).toEqual({
      added: ["ts:src/db/pool.ts#open"],
      removed: ["ts:src/db/store.ts#drop"],
    });
    expect(diff.api.removed).toEqual(["ts:src/db/store.ts#drop"]);
    expect(diff.api.changed).toEqual([
      { id: "ts:src/db/store.ts#save", before: "(x: string)", after: "(x: string, y: number)" },
    ]);
    expect(diff.coupling).toEqual([{ id: "ts:src/db/store.ts", before: 0, after: 2 }]);

    // The reverse comparison mirrors it.
    const back = diffGraphs(after, before);
    expect(back.cycles.resolved).toEqual(diff.cycles.introduced);
    expect(back.dependencies.removed).toEqual(diff.dependencies.added);
  });

  it("finds nothing between identical graphs", () => {
    const g = graph([mod("a.ts"), mod("b.ts")], [edge("ts:a.ts", "imports", "ts:b.ts")]);
    const diff = diffGraphs(g, g);
    expect(
      Object.values(diff).every((part) =>
        Array.isArray(part)
          ? part.length === 0
          : Object.values(part).every((l) => (l as unknown[]).length === 0),
      ),
    ).toBe(true);
  });
});
