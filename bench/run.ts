// Usage: pnpm --filter @xray/bench bench [name ...]
// Clones each pinned repo into bench/repos (gitignored, never executed), scans it twice
// (cold, then unchanged) and writes bench/results/latest.json. Requires a built workspace.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "@xray/engine";
import { GraphStore } from "@xray/store";

type Repo = { name: string; url: string; commit: string; language: string };

const here = dirname(fileURLToPath(import.meta.url));
const repos: Repo[] = JSON.parse(readFileSync(join(here, "repos.json"), "utf8"));
const only = process.argv.slice(2);

function checkout(repo: Repo): string {
  const dir = join(here, "repos", repo.name);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", repo.url);
  }
  const head = existsSync(join(dir, ".git", "HEAD"))
    ? git("rev-parse", "HEAD").toString().trim()
    : "";
  if (head !== repo.commit) {
    git("fetch", "-q", "--depth", "1", "origin", repo.commit);
    git("checkout", "-q", "--detach", "FETCH_HEAD");
  }
  return dir;
}

const count = <T>(items: T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
};

const results = [];
for (const repo of repos) {
  if (only.length > 0 && !only.includes(repo.name)) continue;
  const root = checkout(repo);
  const store = GraphStore.open(":memory:");
  const engine = new Engine({ root, store });
  const cold = await engine.scan();
  const warm = await engine.scan();
  const graph = store.exportGraph();
  const calls = graph.edges.filter((edge) => edge.kind === "calls");
  const lines = graph.nodes
    .filter((node) => node.kind === "module")
    .reduce(
      (sum, node) => sum + readFileSync(join(root, node.qualifiedName), "utf8").split("\n").length,
      0,
    );
  const result = {
    name: repo.name,
    commit: repo.commit,
    files: cold.files,
    lines,
    nodes: cold.nodes,
    edges: cold.edges,
    coldMs: Math.round(cold.timings.total),
    analyzeMs: Math.round(cold.timings.analyze),
    unchangedRescanMs: Math.round(warm.timings.total),
    calls: calls.length,
    callConfidence: count(calls, (edge) => edge.confidence),
    edgeKinds: count(graph.edges, (edge) => edge.kind),
    entryPoints: count(
      graph.nodes.filter((node) =>
        ["route", "cli-command", "test", "component"].includes(node.kind),
      ),
      (node) => node.kind,
    ),
    diagnostics: cold.diagnostics.length,
  };
  results.push(result);
  store.close();
  const exact = ((result.callConfidence.exact ?? 0) / Math.max(1, result.calls)) * 100;
  console.log(
    `${repo.name.padEnd(10)} ${String(result.lines).padStart(7)} lines  ${String(result.coldMs).padStart(6)} ms cold  ` +
      `${String(result.unchangedRescanMs).padStart(4)} ms rescan  ${result.calls} calls (${exact.toFixed(0)}% exact)  ` +
      `${result.diagnostics} diagnostics`,
  );
}

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(
  join(here, "results", "latest.json"),
  `${JSON.stringify({ node: process.version, date: new Date().toISOString(), results }, null, 2)}\n`,
);
