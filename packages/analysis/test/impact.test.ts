import { describe, expect, it } from "vitest";
import { impact, parseUnifiedDiff, symbolsForChanges } from "../src/index.js";
import { fixtureIndex, graph } from "./helpers.js";

describe("impact", () => {
  it("follows callers, overrides and dynamic dispatch", async () => {
    const index = await fixtureIndex("ts-classes");
    const report = impact(index, ["ts:src/user-repo.ts#UserRepo.find"]);
    const byId = new Map(report.impacted.map((n) => [n.id, n]));
    // AdminRepo.find overrides and super-calls it.
    expect(byId.get("ts:src/admin-repo.ts#AdminRepo.find")?.depth).toBe(1);
    // Calls through the interface may land in UserRepo.find.
    expect(byId.get("ts:src/repository.ts#Repository.find")).toMatchObject({
      via: "overrides",
      confidence: "inferred",
    });
    expect(byId.get("ts:src/service.ts#lookup")?.depth).toBe(2);
    expect(byId.get("ts:src/service.ts#adminLookup")?.depth).toBe(3);
    expect(report.rings.map((r) => r.depth)).toEqual([
      ...new Set(report.impacted.map((n) => n.depth)),
    ]);
    expect(report.modules).toEqual([
      "ts:src/admin-repo.ts",
      "ts:src/repository.ts",
      "ts:src/service.ts",
    ]);
  });

  it("carries the weakest confidence along the path", async () => {
    const index = await fixtureIndex("py-packages");
    const report = impact(index, ["py:app/models.py#User.save"]);
    const byId = new Map(report.impacted.map((n) => [n.id, n]));
    expect(byId.get("py:app/services/users.py#create_user")?.confidence).toBe("inferred");
    expect(byId.get("py:app/main.py#main")?.confidence).toBe("inferred");
    expect(byId.get("py:app/main.py")?.via).toBe("calls");
  });

  it("expands containers and stops at maxDepth", async () => {
    const index = await fixtureIndex("ts-reexports");
    const all = impact(index, ["ts:src/utils/math.ts"]);
    expect(all.targets).toEqual([
      "ts:src/utils/math.ts",
      "ts:src/utils/math.ts#add",
      "ts:src/utils/math.ts#multiply",
    ]);
    expect(all.impacted.map((n) => n.id)).toContain("ts:src/app.ts#main");
    const shallow = impact(index, ["ts:src/utils/math.ts#add"], { maxDepth: 1, kinds: ["calls"] });
    expect(shallow.impacted.map((n) => n.id)).toEqual([
      "ts:src/app.ts#main",
      "ts:src/utils/math.ts#multiply",
    ]);
  });

  it("reports entry points, tests and risk", () => {
    const g = graph(({ n, e }) => {
      n("ts:db.ts#save");
      n("ts:svc.ts#createUser");
      n("ts:api.ts#POST /users", "route");
      n("ts:api.test.ts#test:creates", "test");
      e("ts:svc.ts#createUser", "calls", "ts:db.ts#save");
      e("ts:api.ts#POST /users", "handles", "ts:svc.ts#createUser");
      e("ts:api.test.ts#test:creates", "calls", "ts:svc.ts#createUser", "heuristic");
    });
    const report = impact(g, ["ts:db.ts#save"]);
    expect(report.entryPoints.map((n) => n.id)).toEqual(["ts:api.ts#POST /users"]);
    expect(report.tests.map((n) => [n.id, n.confidence])).toEqual([
      ["ts:api.test.ts#test:creates", "heuristic"],
    ]);
    expect(report.risk.level).toBe("medium");
    expect(report.risk.reasons).toContain("1 dependent is only linked by name");
    expect(impact(g, ["ts:db.ts#save"], { includeHeuristic: false }).tests).toEqual([]);

    const untested = impact(g, ["ts:svc.ts#createUser"], { includeHeuristic: false });
    expect(untested.risk.reasons).toContain("no tests reach the change");
    expect(impact(g, ["ts:api.test.ts#test:creates"]).risk).toEqual({
      score: 0,
      level: "low",
      reasons: [],
    });
  });
});

describe("diffs", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ function f() {",
    " context",
    "-old",
    "+new",
    "+added",
    " context",
    "@@ -40,2 +41,0 @@",
    "-gone",
    "-gone too",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
  ].join("\n");

  it("parses changed line ranges per file", () => {
    const changes = parseUnifiedDiff(diff);
    expect(changes.get("src/a.ts")).toEqual([
      { start: 10, end: 12 },
      { start: 41, end: 42 },
    ]);
    expect(changes.get("src/new.ts")).toEqual([{ start: 1, end: 2 }]);
    expect(changes.get("src/old.ts")).toEqual([{ start: 1, end: Number.POSITIVE_INFINITY }]);
  });

  it("maps changes to the innermost symbols, or the module", () => {
    const loc = (line: number, endLine: number) => ({
      location: { file: "src/a.ts", line, column: 1, endLine },
    });
    const g = graph(({ n }) => {
      n("ts:src/a.ts", "module", { location: { file: "src/a.ts", line: 1, column: 1 } });
      n("ts:src/a.ts#Box", "class", loc(5, 30));
      n("ts:src/a.ts#Box.open", "method", loc(9, 14));
      n("ts:src/a.ts#Box.close", "method", loc(16, 20));
      n("ts:src/a.ts#later", "function", loc(35, 45));
      n("ts:src/old.ts", "module", { location: { file: "src/old.ts", line: 1, column: 1 } });
    });
    const changes = new Map([
      [
        "src/a.ts",
        [
          { start: 10, end: 12 },
          { start: 22, end: 23 },
          { start: 1, end: 2 },
        ],
      ],
      ["src/old.ts", [{ start: 1, end: Number.POSITIVE_INFINITY }]],
    ]);
    expect(symbolsForChanges(g, changes)).toEqual([
      "ts:src/a.ts",
      "ts:src/a.ts#Box",
      "ts:src/a.ts#Box.open",
      "ts:src/old.ts",
    ]);
  });
});
