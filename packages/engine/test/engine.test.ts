import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGraph } from "@xray/schema";
import { GraphStore } from "@xray/store";
import { goldenProblems, listFixtures, loadFixture } from "@xray/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFiles, Engine, type ScanReport } from "../src/index.js";

describe.each(listFixtures())("golden %s through the engine", (name) => {
  it("matches the expected graph exactly", async () => {
    const { dir, expected } = loadFixture(name);
    const store = GraphStore.open(":memory:");
    const report = await new Engine({ root: dir, store }).scan();
    // Fixtures describe file-level analysis; the repo/directory skeleton is tested separately.
    const graph = store.exportGraph();
    graph.edges = graph.edges.filter((edge) => !/^(repo|dir):/.test(edge.source));
    expect(goldenProblems(expected, graph)).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(validateGraph(store.exportGraph())).toMatchObject({ ok: true });
    store.close();
  });
});

describe("Engine", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xray-engine-"));
    store = GraphStore.open(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  it("builds the repo, directory and package skeleton", async () => {
    write("package.json", JSON.stringify({ name: "acme" }));
    write("packages/web/package.json", JSON.stringify({ name: "@acme/web" }));
    write("packages/web/src/app.ts", "export const app = 1;\n");
    write("scripts/tool.py", "def main():\n    pass\n");
    await new Engine({ root: dir, store }).scan();

    expect(store.getNode("repo:")).toMatchObject({ kind: "repo", meta: { packageName: "acme" } });
    expect(store.getNode("dir:packages/web")).toMatchObject({
      kind: "package",
      meta: { packageName: "@acme/web" },
    });
    expect(store.getNode("dir:packages/web/src")?.kind).toBe("directory");
    expect(store.neighbors("repo:")).toEqual(["dir:packages", "dir:scripts"]);
    expect(store.neighbors("dir:packages/web/src")).toEqual(["ts:packages/web/src/app.ts"]);
    expect(store.neighbors("dir:scripts")).toEqual(["py:scripts/tool.py"]);
  });

  it("rescans incrementally and re-resolves dependents", async () => {
    cpSync(loadFixture("ts-reexports").dir, dir, { recursive: true });
    const engine = new Engine({ root: dir, store });
    const first = await engine.scan();
    expect(first.added).toHaveLength(4);
    expect(first.rewritten).toBe(4);

    const second = await engine.scan();
    expect(second).toMatchObject({ added: [], changed: [], removed: [], rewritten: 0 });

    // Renaming `add` changes math.ts and how app.ts resolves its call, but not app.ts's text.
    write(
      "src/utils/math.ts",
      "export function sum(a: number, b: number): number {\n  return a + b;\n}\nexport { sum as add };\n" +
        "export function multiply(a: number, b: number): number {\n  return sum(a, b);\n}\n",
    );
    const third = await engine.scan();
    expect(third.changed).toEqual(["src/utils/math.ts"]);
    expect(third.rewritten).toBeGreaterThan(1);
    expect(store.neighbors("ts:src/app.ts#main", { kinds: ["calls"] })).toEqual([
      "ts:src/utils/math.ts#multiply",
      "ts:src/utils/math.ts#sum",
    ]);

    unlinkSync(join(dir, "src/app.ts"));
    const fourth = await engine.scan();
    expect(fourth.removed).toEqual(["src/app.ts"]);
    expect(store.getNode("ts:src/app.ts")).toBeUndefined();
    expect(store.getNode("ts:src/app.ts#main")).toBeUndefined();
  });

  it("shares one follow-up scan between concurrent callers", async () => {
    write("a.ts", "export const a = 1;\n");
    const engine = new Engine({ root: dir, store });
    const [r1, r2, r3] = await Promise.all([engine.scan(), engine.scan(), engine.scan()]);
    expect(r1.added).toEqual(["a.ts"]);
    expect(r2).toBe(r3);
    expect(r2.added).toEqual([]);
  });

  it("skips oversized and binary files", async () => {
    write("big.ts", `export const big = "${"x".repeat(2000)}";\n`);
    write("bin.js", "\u0000\u0001");
    write("ok.ts", "export const ok = 1;\n");
    const report = await new Engine({ root: dir, store, maxFileSize: 1000 }).scan();
    expect(report.files).toBe(1);
    expect(report.skipped.map((s) => s.path).sort()).toEqual(["big.ts", "bin.js"]);
  });

  it("reports plugin diagnostics without failing the scan", async () => {
    write("a.ts", 'import { x } from "./missing";\nexport const y = x;\n');
    write("b.py", "def broken(:\n    pass\n");
    const report = await new Engine({ root: dir, store }).scan();
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "a.ts", message: 'cannot resolve import "./missing"' }),
        expect.objectContaining({ file: "b.py", severity: "warning" }),
      ]),
    );
    expect(store.getNode("ts:a.ts#y")).toBeDefined();
  });

  it("rescans on file changes in watch mode", async () => {
    write("a.ts", "export const a = 1;\n");
    const engine = new Engine({ root: dir, store });
    await engine.scan();
    const reports: ScanReport[] = [];
    const watcher = engine.watch((report) => reports.push(report), undefined, 20);
    try {
      write("b.ts", 'import { a } from "./a";\nexport const b = a;\n');
      await expect
        .poll(() => reports.some((r) => r.added.includes("b.ts")), { timeout: 5000 })
        .toBe(true);
      expect(store.neighbors("ts:b.ts", { kinds: ["imports"] })).toEqual(["ts:a.ts"]);
    } finally {
      watcher.close();
    }
  });
});

describe("discoverFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xray-discover-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("honours defaults, nested .gitignore, .xrayignore and extra patterns, and skips symlinks", () => {
    const files = [
      "src/a.ts",
      "src/a.d.ts",
      "src/gen/out.ts",
      "src/keep.ts",
      "node_modules/pkg/index.js",
      "dist/a.js",
      "lib/vendor.min.js",
      "py/app.py",
      "py/__pycache__/app.py",
      "py/.venv/lib/x.py",
      "docs/notes.ts",
      "tmp/scratch.ts",
      "README.md",
    ];
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
    writeFileSync(join(dir, "src/.gitignore"), "gen/\n");
    writeFileSync(join(dir, ".xrayignore"), "docs/\n");
    symlinkSync(join(dir, "src"), join(dir, "linked"));

    const found = discoverFiles(dir, {
      ignore: ["tmp/"],
      accept: (path) => /\.(ts|js|py)$/.test(path),
    });
    expect(found).toEqual(["py/app.py", "src/a.ts", "src/keep.ts"]);
  });
});
