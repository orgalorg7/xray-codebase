import type { EdgeKind, GraphEdge, GraphNode } from "@xray/schema";
import type { AnalysisResult, Diagnostic, FileAnalysis } from "./plugin.js";

/** Edge kinds recorded once per call site; every other kind is recorded once per node pair. */
const SITE_KINDS: ReadonlySet<EdgeKind> = new Set(["calls", "instantiates", "references"]);

function edgeKey(edge: GraphEdge): string {
  const base = `${edge.source}\u0000${edge.kind}\u0000${edge.target}`;
  if (!SITE_KINDS.has(edge.kind) || edge.location === undefined) return base;
  return `${base}\u0000${edge.location.line}:${edge.location.column}`;
}

/**
 * Accumulates a plugin's output, keeping nodes unique by ID and edges unique by
 * (source, kind, target), or per call site for calls, instantiations and references.
 */
export class AnalysisBuilder {
  readonly #files = new Map<
    string,
    { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> }
  >();
  readonly #sharedNodes = new Map<string, GraphNode>();
  readonly #sharedEdges = new Map<string, GraphEdge>();
  readonly diagnostics: Diagnostic[] = [];

  #file(path: string) {
    let file = this.#files.get(path);
    if (file === undefined) {
      file = { nodes: new Map(), edges: new Map() };
      this.#files.set(path, file);
    }
    return file;
  }

  /** Registers a file so it appears in the result even if it produces no rows. */
  file(path: string): void {
    this.#file(path);
  }

  node(path: string, node: GraphNode): void {
    const { nodes } = this.#file(path);
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  edge(path: string, edge: GraphEdge): void {
    const { edges } = this.#file(path);
    const key = edgeKey(edge);
    if (!edges.has(key)) edges.set(key, edge);
  }

  sharedNode(node: GraphNode): void {
    if (!this.#sharedNodes.has(node.id)) this.#sharedNodes.set(node.id, node);
  }

  sharedEdge(edge: GraphEdge): void {
    const key = edgeKey(edge);
    if (!this.#sharedEdges.has(key)) this.#sharedEdges.set(key, edge);
  }

  hasNode(path: string, id: string): boolean {
    return this.#files.get(path)?.nodes.has(id) ?? false;
  }

  build(): AnalysisResult {
    const files: FileAnalysis[] = [...this.#files].map(([path, { nodes, edges }]) => ({
      path,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    }));
    return {
      files,
      shared: { nodes: [...this.#sharedNodes.values()], edges: [...this.#sharedEdges.values()] },
      diagnostics: this.diagnostics,
    };
  }
}
