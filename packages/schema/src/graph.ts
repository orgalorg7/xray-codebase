import { z } from "zod";
import { CONFIDENCES, EDGE_KINDS, LANGUAGES, NODE_KINDS } from "./kinds.js";

/** Lines and columns are 1-based, matching editors and compiler diagnostics. */
export const SourceLocationSchema = z.object({
  file: z.string().min(1),
  line: z.int().positive(),
  column: z.int().positive(),
  endLine: z.int().positive().optional(),
  endColumn: z.int().positive().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  /** Short display name, e.g. `login`. */
  name: z.string().min(1),
  /** Name within its module, e.g. `AuthService.login`. Equals `name` for top-level items. */
  qualifiedName: z.string().min(1),
  language: z.enum(LANGUAGES).optional(),
  location: SourceLocationSchema.optional(),
  /** Human-readable signature, e.g. `(user: string, password: string) => Promise<Session>`. */
  signature: z.string().optional(),
  /** Docstring or JSDoc summary. */
  doc: z.string().optional(),
  exported: z.boolean().optional(),
  /** Plugin-specific extras (decorators, HTTP method of a route, ...). Must be JSON. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(EDGE_KINDS),
  confidence: z.enum(CONFIDENCES),
  /** Where the relationship appears in source, e.g. the call site. */
  location: SourceLocationSchema.optional(),
  /** Finer-grained kind, e.g. `dynamic-import`, `self-call`, `type-only`. */
  detail: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GRAPH_FORMAT_VERSION = 1;

/** The JSON export format (v1): what `xray export --format json` writes. */
export const GraphSchema = z.object({
  version: z.literal(GRAPH_FORMAT_VERSION),
  /** Absolute path or URL of the scanned repository. */
  root: z.string().optional(),
  /** ISO-8601 timestamp. */
  generatedAt: z.string().optional(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
export type Graph = z.infer<typeof GraphSchema>;

export type GraphIssue = { path: string; message: string };

/**
 * Validates a graph's shape plus referential integrity: unique node IDs and edges whose
 * endpoints exist. Returns the parsed graph or the list of problems.
 */
export function validateGraph(
  input: unknown,
): { ok: true; graph: Graph } | { ok: false; issues: GraphIssue[] } {
  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const graph = parsed.data;
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  graph.nodes.forEach((node, i) => {
    if (ids.has(node.id))
      issues.push({ path: `nodes.${i}.id`, message: `duplicate id ${node.id}` });
    ids.add(node.id);
  });
  graph.edges.forEach((edge, i) => {
    for (const end of ["source", "target"] as const) {
      if (!ids.has(edge[end])) {
        issues.push({ path: `edges.${i}.${end}`, message: `unknown node ${edge[end]}` });
      }
    }
  });
  return issues.length === 0 ? { ok: true, graph } : { ok: false, issues };
}
