import { compareStrings, DEPENDENCY_KINDS, moduleGraph } from "@xray/analysis";
import type { GraphEdge, GraphNode } from "@xray/schema";
import type { XrayService } from "./service.js";

export type ExportLevel = "module" | "symbol";

type Simple = {
  nodes: GraphNode[];
  edges: { source: string; target: string; kind: string; weight: number; confidence?: string }[];
};

/** The graph at module level (aggregated dependencies) or symbol level (every edge but contains). */
function simplify(service: XrayService, level: ExportLevel): Simple {
  const index = service.index();
  if (level === "module") {
    const nodes = index.byKind("module").sort((a, b) => compareStrings(a.id, b.id));
    const edges: Simple["edges"] = [];
    for (const [source, row] of moduleGraph(index)) {
      for (const [target, weight] of row) edges.push({ source, target, kind: "depends", weight });
    }
    edges.sort((a, b) => compareStrings(a.source, b.source) || compareStrings(a.target, b.target));
    return { nodes, edges };
  }
  const nodes = [...index.nodes.values()].filter(
    (n) => n.kind !== "directory" && n.kind !== "repo" && n.kind !== "package",
  );
  const keep = new Set(nodes.map((n) => n.id));
  const edges = index.edges
    .filter(
      (e: GraphEdge) =>
        DEPENDENCY_KINDS.includes(e.kind) && keep.has(e.source) && keep.has(e.target),
    )
    .map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      weight: 1,
      confidence: e.confidence,
    }));
  return { nodes, edges };
}

const quote = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Graphviz DOT; modules are grouped in clusters by directory. */
export function toDot(service: XrayService, level: ExportLevel = "module"): string {
  const { nodes, edges } = simplify(service, level);
  const index = service.index();
  const byDir = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const mod = index.moduleOf(node.id);
    const dir =
      (mod ? index.node(mod)?.qualifiedName : undefined)?.split("/").slice(0, -1).join("/") ?? "";
    byDir.set(dir, [...(byDir.get(dir) ?? []), node]);
  }
  const lines = [
    `digraph ${quote(service.snapshot.name)} {`,
    "  rankdir=LR;",
    "  node [shape=box, fontname=Helvetica, fontsize=10];",
  ];
  let cluster = 0;
  for (const [dir, members] of [...byDir].sort((a, b) => compareStrings(a[0], b[0]))) {
    const body = members.map(
      (n) => `    ${quote(n.id)} [label=${quote(level === "module" ? n.name : n.qualifiedName)}];`,
    );
    if (dir === "") lines.push(...body.map((l) => l.slice(2)));
    else
      lines.push(`  subgraph cluster_${cluster++} {`, `    label=${quote(dir)};`, ...body, "  }");
  }
  for (const e of edges) {
    const attrs =
      level === "module"
        ? `[weight=${e.weight}, label=${e.weight}]`
        : `[label=${quote(e.kind)}${e.confidence === "heuristic" ? ", style=dashed" : ""}]`;
    lines.push(`  ${quote(e.source)} -> ${quote(e.target)} ${attrs};`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Mermaid flowchart. Large graphs are cut to the `limit` most connected nodes. */
export function toMermaid(
  service: XrayService,
  level: ExportLevel = "module",
  limit = 150,
): string {
  const { nodes, edges } = simplify(service, level);
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
  }
  const kept = [...nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || compareStrings(a.id, b.id))
    .slice(0, limit);
  const ids = new Map(kept.map((n, i) => [n.id, `n${i}`]));
  const label = (text: string): string => `"${text.replaceAll('"', "#quot;")}"`;
  const lines = ["flowchart LR"];
  for (const node of kept)
    lines.push(
      `  ${ids.get(node.id)}[${label(level === "module" ? node.qualifiedName : node.qualifiedName)}]`,
    );
  for (const e of edges) {
    const a = ids.get(e.source);
    const b = ids.get(e.target);
    if (a && b)
      lines.push(`  ${a} -->${level === "module" ? `|${e.weight}|` : `|${e.kind}|`} ${b}`);
  }
  if (nodes.length > kept.length)
    lines.push(`  %% ${nodes.length - kept.length} less connected nodes omitted`);
  return `${lines.join("\n")}\n`;
}

const xml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** GraphML with node and edge attributes, for Gephi, yEd and Cytoscape. */
export function toGraphML(service: XrayService, level: ExportLevel = "symbol"): string {
  const { nodes, edges } = simplify(service, level);
  const index = service.index();
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="file" for="node" attr.name="file" attr.type="string"/>',
    '  <key id="line" for="node" attr.name="line" attr.type="int"/>',
    '  <key id="module" for="node" attr.name="module" attr.type="string"/>',
    '  <key id="ekind" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="int"/>',
    '  <key id="confidence" for="edge" attr.name="confidence" attr.type="string"/>',
    '  <graph edgedefault="directed">',
  ];
  for (const node of nodes) {
    out.push(`    <node id="${xml(node.id)}">`);
    out.push(`      <data key="kind">${xml(node.kind)}</data>`);
    out.push(`      <data key="name">${xml(node.qualifiedName)}</data>`);
    if (node.location) {
      out.push(`      <data key="file">${xml(node.location.file)}</data>`);
      out.push(`      <data key="line">${node.location.line}</data>`);
    }
    const mod = index.moduleOf(node.id);
    if (mod) out.push(`      <data key="module">${xml(mod)}</data>`);
    out.push("    </node>");
  }
  edges.forEach((e, i) => {
    out.push(`    <edge id="e${i}" source="${xml(e.source)}" target="${xml(e.target)}">`);
    out.push(`      <data key="ekind">${xml(e.kind)}</data>`);
    out.push(`      <data key="weight">${e.weight}</data>`);
    if (e.confidence) out.push(`      <data key="confidence">${e.confidence}</data>`);
    out.push("    </edge>");
  });
  out.push("  </graph>", "</graphml>");
  return `${out.join("\n")}\n`;
}
