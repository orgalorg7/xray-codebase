import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { validateGraph } from "@xray/schema";
import { loadFixture } from "@xray/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUiDir, main } from "../src/index.js";

let dir: string;

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    color: false,
  });
  return { code, out, err };
}

function useFixture(name: string): void {
  cpSync(loadFixture(name).dir, dir, { recursive: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xray-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("xray", () => {
  it("prints help and version", async () => {
    expect((await run("--help")).out).toContain("X-ray vision for any codebase");
    expect((await run("--version")).out).toBe("0.3.0\n");
    expect((await run("where", "--help")).out).toContain("xray where <query>");
    const unknown = await run("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
  });

  it("scans and writes an index", async () => {
    useFixture("ts-reexports");
    const result = await run("scan", "--no-git");
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/✓ xray-cli-\w+: 4 files, \d+ symbols, \d+ links/);
    expect(existsSync(join(dir, ".xray", "index.db"))).toBe(true);
    const again = await run("scan", "--no-git", "--json");
    expect(JSON.parse(again.out)).toMatchObject({ files: 4, added: [], changed: [] });
  });

  it("finds features", async () => {
    useFixture("ts-classes");
    const result = await run("where", "admin", "lookup", "--no-git");
    expect(result.out.split("\n")[1]).toContain("adminLookup");
    const json = JSON.parse((await run("where", "repository", "--json", "--no-git")).out);
    expect(json.hits.length).toBeGreaterThan(0);
    expect((await run("where", "--no-git")).code).toBe(2);
  });

  it("reports impact of symbols, with ambiguity errors and suggestions", async () => {
    useFixture("ts-classes");
    const result = await run("impact", "UserRepo.find", "--no-git");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Direct dependents");
    expect(result.out).toContain("AdminRepo.find");
    const ambiguous = await run("impact", "find", "--no-git");
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("ambiguous (3 matches)");
    const missing = await run("impact", "nonexistent_symbol_xyz", "--no-git");
    expect(missing.err).toContain('nothing matches "nonexistent_symbol_xyz"');
  });

  it("reports impact of a git diff", async () => {
    useFixture("ts-reexports");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { stdio: "pipe" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const math = join(dir, "src/utils/math.ts");
    writeFileSync(math, readFileSync(math, "utf8").replace("return a + b;", "return b + a;"));
    const result = await run("impact", "--diff");
    expect(result.out).toContain("add  src/utils/math.ts:1");
    expect(result.out).toContain("main");
    const json = JSON.parse((await run("impact", "--diff", "--json")).out);
    expect(json.changed.map((c: { id: string }) => c.id)).toEqual(["ts:src/utils/math.ts#add"]);

    // The pull request comment: a marker to find it again, risk, and links to the files.
    const markdown = (
      await run(
        "impact",
        "--diff",
        "--format",
        "markdown",
        "--link",
        "https://github.com/o/r/blob/abc/",
      )
    ).out;
    expect(markdown.split("\n")[0]).toBe("<!-- xray-impact -->");
    expect(markdown).toContain("### xray: blast radius of this change");
    expect(markdown).toMatch(/\*\*(LOW|MEDIUM|HIGH) risk\*\*/);
    expect(markdown).toContain(
      "- [`add`](https://github.com/o/r/blob/abc/src/utils/math.ts#L1) function · src/utils/math.ts:1",
    );
    expect(markdown).toContain("<summary><b>Direct dependents");
    expect((await run("impact", "--diff", "--format", "yaml")).code).toBe(2);
  });

  it("compares the architecture of two revisions", async () => {
    useFixture("ts-reexports");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { stdio: "pipe" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    // A new module importing math, and math importing it back: a cycle.
    writeFileSync(
      join(dir, "src/utils/log.ts"),
      'import { add } from "./math";\nexport const log = () => add(1, 2);\n',
    );
    const math = join(dir, "src/utils/math.ts");
    writeFileSync(
      math,
      `import { log } from "./log";\n${readFileSync(math, "utf8")}\nexport const used = log;\n`,
    );
    git("add", ".");
    git("commit", "-q", "-m", "cycle");

    const text = await run("diff", "HEAD~1", "--no-git");
    expect(text.code).toBe(0);
    expect(text.out).toContain("New import cycles (1)");
    expect(text.out).toContain("src/utils/log.ts → src/utils/math.ts → src/utils/log.ts");
    expect(text.out).toContain("Added files (1)");

    const json = JSON.parse((await run("diff", "HEAD~1", "HEAD", "--json", "--no-git")).out);
    expect(json.modules.added.map((m: { id: string }) => m.id)).toEqual(["ts:src/utils/log.ts"]);
    expect(json.before.label).toBe("HEAD~1");

    const markdown = (await run("diff", "HEAD~1", "--format", "markdown", "--no-git")).out;
    expect(markdown).toContain("### xray: architecture changes");
    expect(markdown).toContain("⚠️ **1 new import cycle**");

    // Comparing a revision with itself finds nothing; a bad revision is an error.
    expect((await run("diff", "HEAD", "HEAD", "--format", "markdown", "--no-git")).out).toContain(
      "No architecture changes",
    );
    expect((await run("diff", "no-such-branch", "--no-git")).err).toContain(
      '"no-such-branch" is not a commit, branch or tag',
    );
    // The temporary worktrees are gone.
    expect(
      execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("traces call routes", async () => {
    useFixture("ts-reexports");
    const result = await run("trace", "main", "src/utils/math.ts#add", "--no-git");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Route 1");
    expect(result.out).toContain("Route 2");
    const none = await run("trace", "src/utils/math.ts#add", "main", "--no-git");
    expect(none.code).toBe(1);
    expect(none.out).toContain("No call route");
  });

  it("lists cycles", async () => {
    useFixture("ts-cycles");
    const result = await run("cycles", "--no-git", "--calls");
    expect(result.out).toContain("Cycle 1 (3 files)");
    expect(result.out).toContain("Cycle 2 (2 files)");
    expect(result.out).toContain("(type-only)");
    expect(result.out).toContain("Mutual recursion");
    expect((await run("cycles", "--ignore-type-only", "--no-git")).out).not.toContain("Cycle 2");
  });

  it("checks rules, with baselines and GitHub annotations", async () => {
    useFixture("ts-cycles");
    writeFileSync(
      join(dir, ".xray.json"),
      JSON.stringify({
        check: {
          maxImportCycles: 1,
          layers: [{ name: "f is a leaf", from: ["src/f.ts"], disallow: ["src/**"] }],
        },
      }),
    );
    const failing = await run("check", "--no-git");
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("2 import cycles, more than the allowed 1");
    expect(failing.out).toContain("f is a leaf: src/f.ts depends on src/a.ts");
    const github = await run("check", "--format", "github", "--no-git");
    expect(github.out).toContain("::error file=src/f.ts,line=1,title=xray layer::f is a leaf");

    writeFileSync(join(dir, ".xray.json"), JSON.stringify({ check: { noNewCycles: true } }));
    expect((await run("check", "--update-baseline", "--no-git")).out).toContain(
      "Recorded 2 accepted cycles",
    );
    expect((await run("check", "--no-git")).code).toBe(0);
    writeFileSync(
      join(dir, "src/g.ts"),
      'import { h } from "./h.js";\nexport const g = () => h;\n',
    );
    writeFileSync(
      join(dir, "src/h.ts"),
      'import { g } from "./g.js";\nexport const h = () => g;\n',
    );
    const fresh = await run("check", "--no-git");
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain("new import cycle: src/g.ts → src/h.ts");
  });

  it("exports JSON, DOT, Mermaid and GraphML", async () => {
    useFixture("py-packages");
    const json = JSON.parse((await run("export", "--no-git")).out);
    expect(validateGraph(json).ok).toBe(true);
    expect((await run("export", "-f", "dot", "--no-git")).out).toContain("digraph");
    expect((await run("export", "-f", "mermaid", "--no-git")).out).toContain("flowchart LR");
    const graphml = await run("export", "-f", "graphml", "-o", "out/graph.graphml", "--no-git");
    expect(graphml.err).toContain("Wrote");
    expect(readFileSync(join(dir, "out/graph.graphml"), "utf8")).toContain("<graphml");
    expect((await run("export", "-f", "pdf", "--no-git")).code).toBe(2);
  });

  it.skipIf(!findUiDir())("exports a self-contained HTML map", async () => {
    useFixture("py-classes");
    const result = await run("export", "-f", "html", "-o", "map.html", "--no-git");
    expect(result.code).toBe(0);
    const html = readFileSync(join(dir, "map.html"), "utf8");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("<title>xray-cli-");
    const payload =
      /<script id="xray-snapshot" type="application\/octet-stream">([^<]+)<\/script>/.exec(
        html,
      )?.[1];
    expect(payload).toBeDefined();
    const snapshot = JSON.parse(
      gunzipSync(Buffer.from(payload as string, "base64")).toString("utf8"),
    );
    expect(snapshot.graph.nodes.length).toBeGreaterThan(5);
    expect(Object.keys(snapshot.sources).sort()).toEqual(["report.py", "shapes.py"]);
    const bare = await run("export", "-f", "html", "-o", "bare.html", "--no-sources", "--no-git");
    expect(bare.code).toBe(0);
    expect(readFileSync(join(dir, "bare.html"), "utf8").length).toBeLessThan(html.length);
  });

  it("explains missing directories", async () => {
    const result = await run("scan", "does-not-exist");
    expect(result.code).toBe(1);
    expect(result.err).toContain("no such directory");
  });
});
