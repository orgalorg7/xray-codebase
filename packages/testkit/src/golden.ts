import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Diagnostic, LanguagePlugin } from "@xray/parser";
import type { EdgeKind, Graph } from "@xray/schema";
import type { ExpectedGraph } from "./fixtures.js";
import { loadFixture } from "./fixtures.js";
import { edgeKey, scoreGraph } from "./score.js";
import { loadSources } from "./sources.js";

/** Runs one plugin over a fixture and flattens its output into a graph. */
export async function analyzeFixture(
  plugin: LanguagePlugin,
  name: string,
): Promise<{ graph: Graph; diagnostics: Diagnostic[]; expected: ExpectedGraph }> {
  const { dir, expected } = loadFixture(name);
  const result = await plugin.analyze({
    root: dir,
    files: loadSources(dir, (path) => plugin.languageOf(path)),
  });
  const graph: Graph = {
    version: 1,
    nodes: [...result.files.flatMap((f) => f.nodes), ...result.shared.nodes],
    edges: [...result.files.flatMap((f) => f.edges), ...result.shared.edges],
  };
  return { graph, diagnostics: result.diagnostics, expected };
}

/**
 * Everything that differs from a fixture's ground truth: missing nodes, missing and unexpected
 * edges of scored kinds, and expected confidence/detail values that no matching edge has.
 * An empty result means a perfect match.
 */
export function goldenProblems(expected: ExpectedGraph, graph: Graph): string[] {
  const score = scoreGraph(expected, graph);
  const problems = [
    ...score.missingNodes.map((id) => `missing node ${id}`),
    ...score.kinds.flatMap((k) => k.missing.map((key) => `missing ${key}`)),
    ...score.kinds.flatMap((k) => k.unexpected.map((key) => `unexpected ${key}`)),
  ];
  for (const want of expected.edges) {
    const got = graph.edges.filter((edge) => edgeKey(edge) === edgeKey(want));
    if (got.length === 0) continue;
    if (want.confidence && !got.some((e) => e.confidence === want.confidence)) {
      problems.push(
        `${edgeKey(want)}: confidence ${got.map((e) => e.confidence).join("/")}, expected ${want.confidence}`,
      );
    }
    if (want.detail && !got.some((e) => e.detail === want.detail)) {
      problems.push(
        `${edgeKey(want)}: detail ${got.map((e) => e.detail).join("/")}, expected ${want.detail}`,
      );
    }
  }
  return problems;
}

/**
 * Writes `files` (path → contents) to a temporary directory, runs `plugin` over it and returns
 * the flattened graph plus helpers to query it.
 */
export async function analyzeProject(plugin: LanguagePlugin, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "xray-project-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const result = await plugin.analyze({
      root: dir,
      files: loadSources(dir, (path) => plugin.languageOf(path)),
    });
    const nodes = [...result.files.flatMap((f) => f.nodes), ...result.shared.nodes];
    const edges = [...result.files.flatMap((f) => f.edges), ...result.shared.edges];
    return {
      nodes,
      edges,
      diagnostics: result.diagnostics,
      node: (id: string) => nodes.find((n) => n.id === id),
      /** `source -kind-> target` keys of edges, optionally of one kind. */
      keys: (kind?: EdgeKind) =>
        edges.filter((e) => kind === undefined || e.kind === kind).map(edgeKey),
      edge: (source: string, kind: EdgeKind, target: string) =>
        edges.find((e) => e.source === source && e.kind === kind && e.target === target),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
