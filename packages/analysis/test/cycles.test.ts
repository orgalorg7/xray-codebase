import { listFixtures, loadFixture } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import { callCycles, importCycles, stronglyConnected } from "../src/index.js";
import { fixtureIndex, graph } from "./helpers.js";

describe("importCycles", () => {
  const withCycles = listFixtures().filter((name) => loadFixture(name).expected.cycles);

  it.each(withCycles)("finds exactly the expected cycles in %s", async (name) => {
    const cycles = importCycles(await fixtureIndex(name));
    expect(cycles.map((c) => c.members)).toEqual(loadFixture(name).expected.cycles);
  });

  it("finds no cycles in acyclic fixtures", async () => {
    for (const name of listFixtures().filter((n) => !loadFixture(n).expected.cycles)) {
      expect(importCycles(await fixtureIndex(name)), name).toEqual([]);
    }
  });

  it("prefers cutting type-only and deferred imports", async () => {
    const ts = importCycles(await fixtureIndex("ts-cycles"));
    expect(ts[1]?.cut.map((e) => `${e.source}->${e.target}`)).toEqual(["ts:src/d.ts->ts:src/e.ts"]);
    expect(ts[0]?.cut).toHaveLength(1);
    const py = importCycles(await fixtureIndex("py-cycles"));
    expect(py[0]?.cut.map((e) => e.detail)).toEqual(["deferred"]);
  });

  it("can ignore type-only and deferred imports", async () => {
    expect(
      importCycles(await fixtureIndex("ts-cycles"), { ignoreTypeOnly: true }).map((c) => c.members),
    ).toEqual([["ts:src/a.ts", "ts:src/b.ts", "ts:src/c.ts"]]);
    expect(importCycles(await fixtureIndex("py-cycles"), { ignoreDeferred: true })).toEqual([]);
  });

  it("leaves an acyclic graph after removing the cut", () => {
    const g = graph(({ n, e }) => {
      const m = ["a", "b", "c", "d", "e"].map((x) => n(`ts:${x}.ts`, "module"));
      const [a, b, c, d, x] = m as [string, string, string, string, string];
      for (const [s, t] of [
        [a, b],
        [b, c],
        [c, a],
        [c, d],
        [d, b],
        [d, x],
        [x, a],
      ])
        e(s as string, "imports", t as string);
    });
    const [cycle] = importCycles(g);
    expect(cycle?.members).toHaveLength(5);
    const cut = new Set(cycle?.cut);
    const rest = (cycle?.edges ?? []).filter((edge) => !cut.has(edge));
    const succ = (id: string) =>
      rest.filter((edge) => edge.source === id).map((edge) => edge.target);
    expect(stronglyConnected(cycle?.members ?? [], succ)).toEqual([]);
  });
});

describe("callCycles", () => {
  it("finds mutual recursion", async () => {
    expect(callCycles(await fixtureIndex("ts-cycles")).map((c) => c.members)).toEqual([
      ["ts:src/a.ts#a", "ts:src/b.ts#b", "ts:src/c.ts#c"],
    ]);
  });
});

describe("stronglyConnected", () => {
  it("handles long chains without recursion limits", () => {
    const ids = Array.from({ length: 200_000 }, (_, i) => `n${i}`);
    const components = stronglyConnected(ids, (id) => {
      const i = Number(id.slice(1));
      return i === ids.length - 1 ? ["n0"] : [`n${i + 1}`];
    });
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(200_000);
  });

  it("ignores self-loops and singletons", () => {
    expect(stronglyConnected(["a", "b"], (id) => (id === "a" ? ["a", "b"] : []))).toEqual([]);
  });
});
