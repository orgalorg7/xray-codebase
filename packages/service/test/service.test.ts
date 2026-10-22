import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@xray/engine";
import { validateGraph } from "@xray/schema";
import { GraphStore } from "@xray/store";
import { loadFixture } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import {
  globToRegExp,
  runCheck,
  type Snapshot,
  toDot,
  toGraphML,
  toMermaid,
  XrayService,
} from "../src/index.js";

async function service(
  name: string,
  options: { sources?: boolean; git?: Snapshot["git"] } = {},
): Promise<XrayService> {
  const { dir } = loadFixture(name);
  const store = GraphStore.open(":memory:");
  await new Engine({ root: dir, store }).scan();
  const graph = store.exportGraph(dir);
  store.close();
  const snapshot: Snapshot = { name, root: dir, graph, scannedAt: "2026-10-21T00:00:00.000Z" };
  if (options.sources !== false) snapshot.sources = (path) => readFileSync(join(dir, path), "utf8");
  if (options.git) snapshot.git = options.git;
  return new XrayService(snapshot);
}

describe("XrayService", () => {
  it("summarizes the project", async () => {
    const meta = (await service("ts-classes")).meta();
    expect(meta).toMatchObject({
      name: "ts-classes",
      stats: { files: 4, languages: { ts: 4 } },
      hasSources: true,
      hasGit: false,
    });
  });

  it("returns a complete, parent-first map", async () => {
    const s = await service("py-packages");
    const map = s.map();
    expect(map.nodes).toHaveLength(s.index().nodes.size);
    const seen = new Set<string>();
    for (const node of map.nodes) {
      if (node.parent) expect(seen.has(node.parent), node.id).toBe(true);
      seen.add(node.id);
    }
    const save = map.nodes.find((n) => n.id === "py:app/models.py#User.save");
    expect(save).toMatchObject({
      kind: "method",
      parent: "py:app/models.py#User",
      lines: 2,
      fanIn: 1,
    });
    expect(map.districts.length).toBeGreaterThan(0);
  });

  it("marks cycles, dead code and tested code on the map", async () => {
    const cycles = (await service("ts-cycles")).map();
    expect(
      cycles.nodes
        .filter((n) => n.inCycle)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["ts:src/a.ts", "ts:src/b.ts", "ts:src/c.ts", "ts:src/d.ts", "ts:src/e.ts"]);
    const py = (await service("py-classes")).map();
    expect(py.nodes.find((n) => n.id === "py:shapes.py#Circle.__init__")?.dead).toBeUndefined();
  });

  it("describes a node with its edges, metrics and ancestry", async () => {
    const details = (await service("ts-classes")).node("ts:src/service.ts#lookup");
    expect(details?.ancestors.map((a) => a.id)).toEqual(["ts:src/service.ts", "dir:src", "repo:"]);
    expect(details?.outgoing.find((e) => e.kind === "calls")?.other.id).toBe(
      "ts:src/repository.ts#Repository.find",
    );
    expect(details?.incoming.map((e) => `${e.kind} ${e.other.id}`)).toEqual([
      "calls ts:src/service.ts#adminLookup",
    ]);
    expect(details?.metrics.fanIn).toBe(1);
  });

  it("serves source lines only for project files", async () => {
    const s = await service("ts-reexports");
    expect(s.source("src/app.ts", 3, 5)).toEqual({
      file: "src/app.ts",
      language: "ts",
      startLine: 3,
      lines: ["export function main(): number {", "  return times(add(1, 2), 3);", "}"],
      totalLines: 6,
    });
    expect(s.source("tsconfig.json")).toBeUndefined();
    expect(s.source("../../package.json")).toBeUndefined();
    expect(
      (await service("ts-reexports", { sources: false })).source("src/app.ts"),
    ).toBeUndefined();
  });

  it("lists a file's declarations with caller and dependent counts", async () => {
    const s = await service("ts-classes");
    const symbols = s.fileSymbols("src/user-repo.ts");
    expect(symbols.map((x) => [x.label, x.line, x.callers, x.dependents])).toEqual([
      ["UserRepo", 3, 0, 1], // extended by AdminRepo (imports point at the file, not the class)
      ["UserRepo.find", 6, 1, 1], // AdminRepo.find super-calls and overrides it: one dependent
      ["UserRepo.add", 10, 0, 0],
    ]);
    expect(s.fileSymbols("nope.ts")).toEqual([]);
  });

  it("resolves references users type", async () => {
    const s = await service("ts-classes");
    const ids = (ref: string) => s.resolve(ref).map((r) => r.id);
    expect(ids("ts:src/service.ts#lookup")).toEqual(["ts:src/service.ts#lookup"]);
    expect(ids("src/service.ts#lookup")).toEqual(["ts:src/service.ts#lookup"]);
    expect(ids("src/admin-repo.ts:7")).toEqual(["ts:src/admin-repo.ts#AdminRepo.find"]);
    expect(ids("src/service.ts")).toEqual(["ts:src/service.ts"]);
    expect(ids("find")).toEqual([
      "ts:src/admin-repo.ts#AdminRepo.find",
      "ts:src/repository.ts#Repository.find",
      "ts:src/user-repo.ts#UserRepo.find",
    ]);
    expect(ids("adminrepo")).toEqual(["ts:src/admin-repo.ts#AdminRepo"]);
    expect(ids("nothing")).toEqual([]);
  });

  it("searches, traces, builds trees and computes impact with summaries", async () => {
    const s = await service("ts-reexports");
    expect(s.search("multiply").hits[0]?.node.id).toBe("ts:src/utils/math.ts#multiply");
    const trace = s.trace("ts:src/app.ts#main", "ts:src/utils/math.ts#add", { k: 2 });
    expect(trace.paths.map((p) => p.nodes.map((n) => n.name))).toEqual([
      ["main", "add"],
      ["main", "multiply", "add"],
    ]);
    const tree = s.tree("ts:src/utils/math.ts#add", "in", 2);
    expect(tree.tree?.children.map((c) => c.id)).toEqual([
      "ts:src/app.ts#main",
      "ts:src/utils/math.ts#multiply",
    ]);
    expect(tree.nodes["ts:src/app.ts#main"]?.name).toBe("main");
    const impact = s.impact(["ts:src/utils/math.ts#add"]);
    expect(impact.impacted.map((n) => n.node.name)).toContain("main");
    expect(impact.truncated).toBe(false);
  });

  it("maps a diff to changed symbols and their impact", async () => {
    const s = await service("ts-reexports");
    const diff = [
      "diff --git a/src/utils/math.ts b/src/utils/math.ts",
      "--- a/src/utils/math.ts",
      "+++ b/src/utils/math.ts",
      "@@ -2,1 +2,1 @@",
      "-  return a + b;",
      "+  return b + a;",
    ].join("\n");
    const result = s.impactOfDiff(diff);
    expect(result.changed.map((c) => c.id)).toEqual(["ts:src/utils/math.ts#add"]);
    expect(result.report.impacted.map((n) => n.id)).toContain("ts:src/app.ts#main");
  });

  it("reports cycles, insights and a dependency matrix", async () => {
    const s = await service("ts-cycles");
    const cycles = s.cycles();
    expect(cycles.imports.map((c) => c.members.map((m) => m.label))).toEqual([
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      ["src/d.ts", "src/e.ts"],
    ]);
    expect(s.cycles({ ignoreTypeOnly: true }).imports).toHaveLength(1);
    expect(cycles.calls).toHaveLength(1);
    const insights = s.insights();
    expect(insights.districts.reduce((n, d) => n + d.modules, 0)).toBe(6);
    expect(insights.churn).toEqual([]);
    const dsm = s.dsm("module");
    expect(dsm.items).toHaveLength(6);
    const label = (i: number) => dsm.items[i]?.label;
    expect(dsm.cells.map(([i, j]) => `${label(i)}->${label(j)}`)).toContain("src/a.ts->src/b.ts");
    expect(s.dsm("directory").items.map((i) => i.id)).toEqual(["dir:src"]);
  });

  it("exposes git history on nodes and insights", async () => {
    const s = await service("ts-reexports", {
      git: {
        commits: 4,
        files: {
          "src/app.ts": {
            commits: 4,
            additions: 9,
            deletions: 2,
            authors: ["Ada"],
            lastChanged: "2026-01-01",
          },
        },
        coChange: [{ a: "src/app.ts", b: "src/index.ts", count: 3, confidence: 0.75 }],
      },
    });
    expect(s.meta().hasGit).toBe(true);
    expect(s.map().nodes.find((n) => n.id === "ts:src/app.ts#main")?.churn).toBe(4);
    expect(s.node("ts:src/app.ts")?.coChanges).toEqual([
      { file: "src/index.ts", count: 3, confidence: 0.75 },
    ]);
    expect(s.insights().churn).toEqual([{ file: "src/app.ts", commits: 4, authors: 1 }]);
  });
});

describe("runCheck", () => {
  it("enforces cycle budgets, baselines and layer rules", async () => {
    const s = await service("ts-cycles");
    expect(runCheck(s, {}).ok).toBe(true);
    const budget = runCheck(s, { maxImportCycles: 1 });
    expect(budget.violations.map((v) => v.rule)).toEqual(["max-import-cycles"]);
    expect(runCheck(s, { maxImportCycles: 1, ignoreTypeOnlyCycles: true }).ok).toBe(true);

    const baseline = { cycles: ["src/a.ts → src/b.ts → src/c.ts"] };
    expect(runCheck(s, {}, baseline).violations.map((v) => v.message)).toEqual([
      "new import cycle: src/d.ts → src/e.ts",
    ]);
    expect(runCheck(s, {}, { cycles: runCheck(s, {}).cycles }).ok).toBe(true);

    const layers = runCheck(s, {
      layers: [{ name: "f is a leaf", from: ["src/f.ts"], disallow: ["src/**"] }],
    });
    expect(layers.violations).toEqual([
      {
        rule: "layer",
        message: "f is a leaf: src/f.ts depends on src/a.ts",
        location: { file: "src/f.ts", line: 1 },
      },
    ]);
    expect(
      runCheck(s, { layers: [{ from: ["src/f.ts"], disallow: ["src/**"], allow: ["src/a.ts"] }] })
        .ok,
    ).toBe(true);
  });
});

describe("globToRegExp", () => {
  it("matches gitignore-style patterns", () => {
    const m = (glob: string, path: string) => globToRegExp(glob).test(path);
    expect(m("src/**", "src/a/b.ts")).toBe(true);
    expect(m("src/", "src/a/b.ts")).toBe(true);
    expect(m("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(m("**/test/**", "pkg/test/x.ts")).toBe(true);
    expect(m("**/*.py", "x.py")).toBe(true);
    expect(m("a?.ts", "ab.ts")).toBe(true);
    expect(m("a.ts", "aXts")).toBe(false);
  });
});

describe("exporters", () => {
  it("writes DOT, Mermaid, GraphML and valid JSON", async () => {
    const s = await service("ts-cycles");
    const dot = toDot(s);
    expect(dot).toContain('digraph "ts-cycles" {');
    expect(dot).toContain('"ts:src/a.ts" -> "ts:src/b.ts"');
    expect(dot).toContain('label="src"');
    expect(toDot(s, "symbol")).toContain('"ts:src/a.ts#a" -> "ts:src/b.ts#b" [label="calls"]');
    const mermaid = toMermaid(s);
    expect(mermaid.startsWith("flowchart LR\n")).toBe(true);
    expect(mermaid).toMatch(/n\d+\["src\/a\.ts"\]/);
    expect(toMermaid(s, "module", 2)).toContain("less connected nodes omitted");
    const graphml = toGraphML(s);
    expect(graphml).toContain('<node id="ts:src/a.ts#a">');
    expect(graphml).toContain('<data key="ekind">calls</data>');
    expect(validateGraph(s.snapshot.graph).ok).toBe(true);
  });
});
