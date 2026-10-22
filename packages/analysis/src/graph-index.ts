import type { Confidence, EdgeKind, Graph, GraphEdge, GraphNode, NodeKind } from "@xray/schema";

/** Edges that mean "source depends on target": following them backwards gives impact. */
export const DEPENDENCY_KINDS: readonly EdgeKind[] = [
  "calls",
  "instantiates",
  "references",
  "extends",
  "implements",
  "overrides",
  "handles",
  "imports",
  "re-exports",
  "type-of",
  "decorates",
  "tests",
];

/** Edges that transfer control at runtime: what call traces follow. */
export const CALL_KINDS: readonly EdgeKind[] = ["calls", "instantiates", "handles"];

export const ENTRY_POINT_KINDS: ReadonlySet<NodeKind> = new Set([
  "route",
  "cli-command",
  "component",
]);

export const SYMBOL_KINDS: ReadonlySet<NodeKind> = new Set([
  "class",
  "interface",
  "type-alias",
  "enum",
  "function",
  "method",
  "property",
  "variable",
  "route",
  "cli-command",
  "component",
  "test",
]);

/** Test files across the supported ecosystems. */
export const isTestPath = (path: string): boolean =>
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$|_test\.go$|(Test|Tests|IT)\.(java|kt|cs)$|_(spec|test)\.rb$|Test\.php$|(^|\/)src\/test\//.test(
    path,
  );

/** Documentation, examples and benchmarks: real code, but rarely where a feature lives. */
export const isAuxiliaryPath = (path: string): boolean =>
  /(^|\/)(docs?|docs_src|examples?|samples?|demos?|benchmarks?|bench|fixtures?)\//.test(path);

/** Code-point order: unlike localeCompare, identical on every machine. */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, inferred: 1, heuristic: 2 };

/** The weaker of two confidences. */
export const weakest = (a: Confidence, b: Confidence): Confidence =>
  CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;

/**
 * An immutable in-memory view of a graph with adjacency lists and containment lookups.
 * Analyses run on this rather than the store so they are fast and easy to test.
 */
export class GraphIndex {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly #out = new Map<string, GraphEdge[]>();
  readonly #in = new Map<string, GraphEdge[]>();
  readonly #parent = new Map<string, string>();
  readonly #children = new Map<string, string[]>();

  constructor(graph: Pick<Graph, "nodes" | "edges">) {
    this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    // Edges whose endpoints are gone (e.g. a stale reference after a partial rescan) are dropped.
    this.edges = graph.edges.filter(
      (edge) => this.nodes.has(edge.source) && this.nodes.has(edge.target),
    );
    for (const edge of this.edges) {
      push(this.#out, edge.source, edge);
      push(this.#in, edge.target, edge);
      if (edge.kind === "contains" && !this.#parent.has(edge.target)) {
        this.#parent.set(edge.target, edge.source);
        push(this.#children, edge.source, edge.target);
      }
    }
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  out(id: string, kinds?: readonly EdgeKind[]): GraphEdge[] {
    const edges = this.#out.get(id) ?? [];
    return kinds ? edges.filter((edge) => kinds.includes(edge.kind)) : edges;
  }

  in(id: string, kinds?: readonly EdgeKind[]): GraphEdge[] {
    const edges = this.#in.get(id) ?? [];
    return kinds ? edges.filter((edge) => kinds.includes(edge.kind)) : edges;
  }

  parent(id: string): string | undefined {
    return this.#parent.get(id);
  }

  children(id: string): readonly string[] {
    return this.#children.get(id) ?? [];
  }

  /** `id` and everything it contains, depth first. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      out.push(current);
      const children = this.children(current);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as string);
    }
    return out;
  }

  /** Containers of `id`, nearest first, ending at the repo node. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let current = this.#parent.get(id);
    while (current !== undefined && !out.includes(current)) {
      out.push(current);
      current = this.#parent.get(current);
    }
    return out;
  }

  /** The module that contains a symbol (or the module itself). */
  moduleOf(id: string): string | undefined {
    if (this.nodes.get(id)?.kind === "module") return id;
    return this.ancestors(id).find((ancestor) => this.nodes.get(ancestor)?.kind === "module");
  }

  byKind(kind: NodeKind): GraphNode[] {
    return [...this.nodes.values()].filter((node) => node.kind === kind);
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
