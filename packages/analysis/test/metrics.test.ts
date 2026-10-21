import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deadCode,
  districts,
  gitHistory,
  hotspots,
  mapLayout,
  nodeMetrics,
  parseGitLog,
  renamedPath,
  roads,
  unusedExports,
} from "../src/index.js";
import { fixtureIndex, graph } from "./helpers.js";

describe("nodeMetrics", () => {
  it("counts distinct dependents and dependencies", async () => {
    const metrics = nodeMetrics(await fixtureIndex("ts-reexports"));
    expect(metrics.get("ts:src/utils/math.ts#add")).toMatchObject({
      fanIn: 4,
      fanOut: 0,
      lines: 3,
    });
    expect(metrics.get("ts:src/app.ts#main")).toMatchObject({ fanIn: 0, fanOut: 2 });
    expect(metrics.get("ts:src/utils/math.ts")?.lines).toBe(9);
    const total = [...metrics.values()].reduce((sum, m) => sum + m.centrality, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(metrics.get("ts:src/utils/math.ts#add")?.centrality).toBeGreaterThan(
      metrics.get("ts:src/app.ts#main")?.centrality ?? 1,
    );
  });
});

describe("deadCode and unusedExports", () => {
  const g = graph(({ n, e }) => {
    n("ts:a.ts#main", "function", { exported: true });
    n("ts:a.ts#used");
    n("ts:a.ts#unused");
    n("ts:a.ts#Widget", "class");
    n("ts:a.ts#Widget.constructor", "method");
    n("ts:a.ts#Widget.render", "method");
    n("ts:a.ts#Widget.never", "method");
    n("ts:a.ts#Base", "class");
    n("ts:a.ts#Base.draw", "method");
    n("ts:a.ts#Widget.draw", "method");
    n("ts:a.ts#Orphan", "class");
    n("ts:a.ts#Orphan.go", "method");
    n("py:t.py#registered", "function", { meta: { decorators: ["app.get('/')"] } });
    n("ts:b.ts#helper", "function", { exported: true });
    n("ts:b.ts#lonely", "function", { exported: true });
    e("ts:a.ts#main", "calls", "ts:a.ts#used");
    e("ts:a.ts#used", "instantiates", "ts:a.ts#Widget");
    e("ts:a.ts#used", "calls", "ts:a.ts#Widget.render");
    e("ts:a.ts#Widget", "extends", "ts:a.ts#Base");
    e("ts:a.ts#used", "calls", "ts:a.ts#Base.draw");
    e("ts:a.ts#Widget.draw", "overrides", "ts:a.ts#Base.draw");
    e("ts:a.ts#main", "calls", "ts:b.ts#helper");
  });

  it("reports unreachable symbols, keeping roots, constructors and overrides alive", () => {
    expect(deadCode(g).map((d) => d.id)).toEqual([
      "ts:a.ts#Orphan",
      "ts:a.ts#Widget.never",
      "ts:a.ts#unused",
    ]);
    expect(deadCode(g, { assumeExportsUsed: false }).map((d) => d.id)).toContain("ts:b.ts#lonely");
  });

  it("lists exports no other module uses", () => {
    expect(unusedExports(g)).toEqual(["ts:a.ts#main", "ts:b.ts#lonely"]);
  });

  it("keeps what initializers use alive and reports unreferenced variables", () => {
    const g3 = graph(({ n, e }) => {
      n("py:m.py#_callback");
      n("py:m.py#_option", "variable");
      n("py:m.py#_unused", "variable");
      n("py:m.py#Config", "class");
      n("py:m.py#Config.lifetime", "property");
      n("py:m.py#_convert");
      n("py:m.py#run", "function", { exported: true });
      e("py:m.py#_option", "references", "py:m.py#_callback");
      e("py:m.py#Config.lifetime", "references", "py:m.py#_convert");
      e("py:m.py#run", "references", "py:m.py#_option");
    });
    expect(deadCode(g3).map((d) => d.id)).toEqual(["py:m.py#Config", "py:m.py#_unused"]);
  });

  it("treats public methods of exported classes as API", () => {
    const lib = graph(({ n }) => {
      n("ts:lib.ts#Client", "class", { exported: true });
      n("ts:lib.ts#Client.send", "method");
      n("ts:lib.ts#Client._retry", "method");
    });
    expect(deadCode(lib).map((d) => d.id)).toEqual(["ts:lib.ts#Client._retry"]);
  });

  it("skips implicit exports and test files", () => {
    const g2 = graph(({ n }) => {
      n("py:a.py", "module", { qualifiedName: "a.py", meta: { implicitExports: true } });
      n("py:a.py#f", "function", { exported: true });
      n("py:b.py", "module", { qualifiedName: "b.py" });
      n("py:b.py#g", "function", { exported: true });
      n("ts:x.test.ts", "module", { qualifiedName: "x.test.ts" });
      n("ts:x.test.ts#helper", "function", { exported: true });
    });
    expect(unusedExports(g2)).toEqual(["py:b.py#g"]);
  });
});

describe("hotspots", () => {
  it("flags classes with many methods", () => {
    const g = graph(({ n }) => {
      n("ts:big.ts#God", "class");
      for (let i = 0; i < 30; i++) n(`ts:big.ts#God.m${i}`, "method");
    });
    expect(hotspots(g).classes).toEqual([{ id: "ts:big.ts#God", methods: 30, fanOut: 0 }]);
  });
});

describe("districts", () => {
  it("groups tightly coupled modules and names them by directory", () => {
    const g = graph(({ n, e }) => {
      const mods = [
        "src/auth/a",
        "src/auth/b",
        "src/auth/c",
        "src/billing/x",
        "src/billing/y",
        "src/billing/z",
      ].map((p) => n(`ts:${p}.ts`, "module", { qualifiedName: `${p}.ts` }));
      const link = (i: number, j: number, times = 3) => {
        for (let t = 0; t < times; t++) e(mods[i] as string, "imports", mods[j] as string);
      };
      link(0, 1);
      link(1, 2);
      link(2, 0);
      link(3, 4);
      link(4, 5);
      link(5, 3);
      link(2, 3, 1);
    });
    expect(districts(g).map((d) => [d.name, d.modules.length])).toEqual([
      ["src/auth", 3],
      ["src/billing", 3],
    ]);
  });

  it("disambiguates districts that share a directory", () => {
    const g = graph(({ n, e }) => {
      const mods = ["tests/test_a", "tests/test_b", "tests/test_x", "tests/test_y"].map((p) =>
        n(`py:${p}.py`, "module", { qualifiedName: `${p}.py` }),
      );
      for (let t = 0; t < 3; t++) {
        e(mods[0] as string, "imports", mods[1] as string);
        e(mods[2] as string, "imports", mods[3] as string);
      }
    });
    expect(districts(g).map((d) => d.name)).toEqual([
      "tests · test_a, test_b",
      "tests · test_x, test_y",
    ]);
  });
});

describe("git history", () => {
  it("parses churn, authors and co-change", () => {
    const R = "\u001e";
    const F = "\u001f";
    const log = [
      `${R}c3${F}Ada${F}2026-03-01T00:00:00Z`,
      "",
      "5\t1\tsrc/a.ts",
      "2\t2\tsrc/b.ts",
      `${R}c2${F}Bob${F}2026-02-01T00:00:00Z`,
      "",
      "1\t0\tsrc/a.ts",
      "1\t1\tsrc/b.ts",
      "-\t-\tlogo.png",
      `${R}c1${F}Ada${F}2026-01-01T00:00:00Z`,
      "",
      "10\t0\tsrc/{old => a}.ts".replace("{old => a}.ts", "a.ts"),
      "3\t0\tsrc/b.ts",
    ].join("\n");
    const history = parseGitLog(log, { minCoChange: 2 });
    expect(history.commits).toBe(3);
    expect(history.files.get("src/a.ts")).toEqual({
      commits: 3,
      additions: 16,
      deletions: 1,
      authors: ["Ada", "Bob"],
      lastChanged: "2026-03-01T00:00:00Z",
    });
    expect(history.coChange).toEqual([{ a: "src/a.ts", b: "src/b.ts", count: 3, confidence: 1 }]);
  });

  it("maps renames to the new path", () => {
    expect(renamedPath("src/{old => new}/a.ts")).toBe("src/new/a.ts");
    expect(renamedPath("src/{lib => }/a.ts")).toBe("src/a.ts");
    expect(renamedPath("a.ts => b.ts")).toBe("b.ts");
  });

  it("reads a real repository, and tolerates non-repositories", () => {
    const dir = mkdtempSync(join(tmpdir(), "xray-git-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", [
          "-C",
          dir,
          "-c",
          "user.name=Ada",
          "-c",
          "user.email=ada@example.com",
          ...args,
        ]);
      expect(gitHistory(dir).commits).toBe(0);
      git("init", "-q");
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dir, "a.ts"), `export const a = ${i};\n`);
        writeFileSync(join(dir, "b.ts"), `export const b = ${i};\n`);
        git("add", ".");
        git("commit", "-q", "-m", `c${i}`);
      }
      const history = gitHistory(dir);
      expect(history.commits).toBe(3);
      expect(history.files.get("a.ts")?.authors).toEqual(["Ada"]);
      expect(history.coChange[0]).toMatchObject({ a: "a.ts", b: "b.ts", count: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mapLayout and roads", () => {
  it("nests every child inside its parent, deterministically, with externals outside", async () => {
    const index = await fixtureIndex("py-packages");
    const layout = mapLayout(index);
    expect(mapLayout(index)).toEqual(layout);
    for (const node of index.nodes.values()) {
      const place = layout.placements.get(node.id);
      expect(place, node.id).toBeDefined();
      const parent = index.parent(node.id);
      const outer = parent ? layout.placements.get(parent) : undefined;
      if (!place || !outer) continue;
      const distance = Math.hypot(place.x - outer.x, place.y - outer.y);
      expect(distance + place.r, node.id).toBeLessThanOrEqual(outer.r + 1e-6);
    }
    const g = graph(({ n, e }) => {
      n("ts:a.ts#f");
      n("ext:npm/react", "external");
      e("ts:a.ts", "imports", "ext:npm/react");
    });
    const withExternal = mapLayout(g);
    const ext = withExternal.placements.get("ext:npm/react");
    const mod = withExternal.placements.get("ts:a.ts");
    expect(ext && mod && Math.hypot(ext.x - 500, ext.y - 500) > 430).toBe(true);
  });

  it("lifts dependencies to the containers visible at a depth", async () => {
    const index = await fixtureIndex("py-packages");
    const layout = mapLayout(index);
    const depthOf = (id: string) => layout.placements.get(id)?.depth;
    // Modules under app/ sit at depth 2 (repo → app → module).
    expect(depthOf("py:app/main.py")).toBe(2);
    const moduleRoads = roads(index, layout, 2);
    expect(
      moduleRoads.find((r) => r.source === "py:app/main.py" && r.target === "dir:app/services"),
    ).toBeDefined();
    expect(roads(index, layout, 1)).toEqual([]); // everything lives in app/
  });
});
