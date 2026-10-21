import { describe, expect, it } from "vitest";
import { callTree, tracePaths } from "../src/index.js";
import { fixtureIndex, graph } from "./helpers.js";

describe("tracePaths", () => {
  it("returns the k best distinct routes, shortest first", async () => {
    const index = await fixtureIndex("ts-reexports");
    const paths = tracePaths(index, "ts:src/app.ts#main", "ts:src/utils/math.ts#add", { k: 3 });
    expect(paths.map((p) => p.nodes)).toEqual([
      ["ts:src/app.ts#main", "ts:src/utils/math.ts#add"],
      ["ts:src/app.ts#main", "ts:src/utils/math.ts#multiply", "ts:src/utils/math.ts#add"],
    ]);
    expect(paths[1]?.edges.map((e) => e.kind)).toEqual(["calls", "calls"]);
  });

  it("accepts containers as endpoints", async () => {
    const index = await fixtureIndex("py-packages");
    const [path] = tracePaths(index, "py:app/main.py", "py:app/models.py");
    expect(path?.nodes).toEqual([
      "py:app/main.py#main",
      "py:app/services/users.py#create_user",
      "py:app/models.py#User",
    ]);
  });

  it("prefers sure routes over guessed shortcuts", () => {
    const g = graph(({ n, e }) => {
      for (const id of ["a", "b", "c", "z"]) n(`ts:m.ts#${id}`);
      e("ts:m.ts#a", "calls", "ts:m.ts#z", "heuristic");
      e("ts:m.ts#a", "calls", "ts:m.ts#b");
      e("ts:m.ts#b", "calls", "ts:m.ts#c");
      e("ts:m.ts#c", "calls", "ts:m.ts#z");
    });
    const paths = tracePaths(g, "ts:m.ts#a", "ts:m.ts#z", { k: 2 });
    expect(paths.map((p) => [p.nodes.length, p.confidence])).toEqual([
      [4, "exact"],
      [2, "heuristic"],
    ]);
  });

  it("returns nothing when unreachable or unknown", async () => {
    const index = await fixtureIndex("ts-reexports");
    expect(tracePaths(index, "ts:src/utils/math.ts#add", "ts:src/app.ts#main")).toEqual([]);
    expect(tracePaths(index, "ts:nope", "ts:src/app.ts#main")).toEqual([]);
  });
});

describe("callTree", () => {
  it("expands calls and marks recursion", async () => {
    const tree = callTree(await fixtureIndex("ts-cycles"), "ts:src/a.ts#a", { depth: 5 });
    const ids: string[] = [];
    let node = tree;
    while (node) {
      ids.push(`${node.id}${node.recursive ? " (recursive)" : ""}`);
      node = node.children[0];
    }
    expect(ids).toEqual([
      "ts:src/a.ts#a",
      "ts:src/b.ts#b",
      "ts:src/c.ts#c",
      "ts:src/a.ts#a (recursive)",
    ]);
  });

  it("shows callers and truncates at depth", async () => {
    const tree = callTree(await fixtureIndex("ts-reexports"), "ts:src/utils/math.ts#add", {
      direction: "in",
      depth: 1,
    });
    expect(tree?.children.map((c) => [c.id, c.truncated ?? false])).toEqual([
      ["ts:src/app.ts#main", false],
      ["ts:src/utils/math.ts#multiply", true],
    ]);
  });
});
