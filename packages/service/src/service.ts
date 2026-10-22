import {
  CALL_KINDS,
  type Cycle,
  callCycles,
  callTree,
  compareStrings,
  DEPENDENCY_KINDS,
  deadCode,
  districts,
  FeatureIndex,
  GraphIndex,
  hotspots,
  type ImpactOptions,
  type ImportCycleOptions,
  impact,
  importCycles,
  type MapLayout,
  mapLayout,
  moduleGraph,
  type NodeMetrics,
  nodeMetrics,
  parseUnifiedDiff,
  roads,
  SYMBOL_KINDS,
  symbolsForChanges,
  tracePaths,
  unusedExports,
} from "@xray/analysis";
import type { EdgeKind, GraphNode, Language } from "@xray/schema";
import type {
  CyclesView,
  CycleView,
  DsmView,
  EdgeView,
  FileSymbol,
  ImpactView,
  InsightsView,
  MapData,
  MapNode,
  Meta,
  NodeDetails,
  RoadsView,
  SearchView,
  Snapshot,
  SourceView,
  Summary,
  TraceView,
  TreeView,
} from "./types.js";

const EDGE_LIMIT = 500;

/** Node kinds editors annotate with usage counts. */
const LENS_KINDS: ReadonlySet<string> = new Set([
  "function",
  "method",
  "class",
  "interface",
  "component",
  "route",
  "cli-command",
  "type-alias",
  "enum",
]);
const IMPACT_LIMIT = 2000;

/** Memoizes a zero-argument computation. */
function lazy<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

/**
 * The xray API over one snapshot. Every method returns plain JSON-serializable data, so the
 * same service backs the HTTP server, the self-contained HTML export and editor integrations.
 * Derived structures (index, layout, metrics, search index) are built on first use.
 */
export class XrayService {
  readonly snapshot: Snapshot;
  readonly index: () => GraphIndex;
  readonly #layout: () => MapLayout;
  readonly #metrics: () => Map<string, NodeMetrics>;
  readonly #ranks: () => Map<string, number>;
  readonly #districts: () => ReturnType<typeof districts>;
  readonly #districtOf: () => Map<string, number>;
  readonly #features: () => FeatureIndex;
  readonly #dead: () => Set<string>;
  readonly #importCycles: () => Cycle[];
  readonly #tested: () => Set<string>;
  readonly #roads = new Map<number, RoadsView>();
  /** Module nodes by repo-relative path. */
  readonly #modules: () => Map<string, GraphNode>;

  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.index = lazy(() => new GraphIndex(snapshot.graph));
    this.#layout = lazy(() => mapLayout(this.index()));
    this.#metrics = lazy(() => nodeMetrics(this.index()));
    this.#ranks = lazy(() => {
      const symbols = [...this.#metrics()]
        .filter(([id]) => SYMBOL_KINDS.has(this.index().node(id)?.kind ?? "module"))
        .sort((a, b) => b[1].centrality - a[1].centrality || compareStrings(a[0], b[0]));
      return new Map(symbols.map(([id], i) => [id, i + 1]));
    });
    this.#districts = lazy(() => districts(this.index()));
    this.#districtOf = lazy(() => {
      const map = new Map<string, number>();
      for (const d of this.#districts()) for (const mod of d.modules) map.set(mod, d.id);
      return map;
    });
    this.#features = lazy(() => new FeatureIndex(this.index()));
    this.#modules = lazy(
      () =>
        new Map(
          this.index()
            .byKind("module")
            .map((m) => [m.qualifiedName, m] as const),
        ),
    );
    this.#dead = lazy(() => new Set(deadCode(this.index()).map((d) => d.id)));
    this.#importCycles = lazy(() => importCycles(this.index()));
    this.#tested = lazy(() => {
      const index = this.index();
      const reached = new Set<string>();
      const stack = index.byKind("test").map((t) => t.id);
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (reached.has(id)) continue;
        reached.add(id);
        for (const edge of index.out(id, [...CALL_KINDS, "references"])) stack.push(edge.target);
      }
      return reached;
    });
  }

  // ---- helpers -------------------------------------------------------------------------

  summary(id: string): Summary {
    const node = this.index().node(id);
    if (!node) return { id, kind: "external", name: id, label: id };
    return summarize(node);
  }

  #source(path: string): string | undefined {
    const { sources } = this.snapshot;
    if (!sources) return undefined;
    return typeof sources === "function" ? sources(path) : sources[path];
  }

  #edgeView(edge: import("@xray/schema").GraphEdge, other: string): EdgeView {
    const view: EdgeView = {
      kind: edge.kind,
      confidence: edge.confidence,
      other: this.summary(other),
    };
    if (edge.detail) view.detail = edge.detail;
    if (edge.location) view.location = edge.location;
    return view;
  }

  #districtFor(id: string): number | undefined {
    const mod = this.index().moduleOf(id);
    return mod === undefined ? undefined : this.#districtOf().get(mod);
  }

  // ---- API -----------------------------------------------------------------------------

  meta(): Meta {
    const index = this.index();
    const languages: Partial<Record<Language, number>> = {};
    let files = 0;
    let symbols = 0;
    let entryPoints = 0;
    let tests = 0;
    for (const node of index.nodes.values()) {
      if (node.kind === "module") {
        files++;
        if (node.language) languages[node.language] = (languages[node.language] ?? 0) + 1;
      } else if (SYMBOL_KINDS.has(node.kind)) symbols++;
      if (node.kind === "route" || node.kind === "cli-command" || node.kind === "component")
        entryPoints++;
      if (node.kind === "test") tests++;
    }
    const diagnostics = this.snapshot.diagnostics ?? [];
    return {
      name: this.snapshot.name,
      root: this.snapshot.root,
      scannedAt: this.snapshot.scannedAt,
      stats: { files, symbols, edges: index.edges.length, languages, entryPoints, tests },
      diagnostics: { count: diagnostics.length, sample: diagnostics.slice(0, 50) },
      hasSources: this.snapshot.sources !== undefined,
      hasGit: (this.snapshot.git?.commits ?? 0) > 0,
    };
  }

  map(): MapData {
    const index = this.index();
    const layout = this.#layout();
    const metrics = this.#metrics();
    const ranks = this.#ranks();
    const dead = this.#dead();
    const tested = this.#tested();
    const inCycle = new Set(this.#importCycles().flatMap((c) => c.members));
    const git = this.snapshot.git?.files;
    const nodes: MapNode[] = [];
    for (const node of index.nodes.values()) {
      const place = layout.placements.get(node.id);
      if (!place) continue;
      const m = metrics.get(node.id);
      const entry: MapNode = {
        ...summarize(node),
        x: round(place.x),
        y: round(place.y),
        r: round(place.r),
        depth: place.depth,
        lines: m?.lines ?? 0,
        fanIn: m?.fanIn ?? 0,
        fanOut: m?.fanOut ?? 0,
      };
      const parent = index.parent(node.id);
      if (parent) entry.parent = parent;
      if (node.exported !== undefined) entry.exported = node.exported;
      const rank = ranks.get(node.id);
      if (rank !== undefined) entry.rank = rank;
      const district = this.#districtFor(node.id);
      if (district !== undefined) entry.district = district;
      const file = node.location?.file;
      const history = file ? git?.[file] : undefined;
      if (history) entry.churn = history.commits;
      if (dead.has(node.id)) entry.dead = true;
      if (inCycle.has(node.id)) entry.inCycle = true;
      if (tested.has(node.id) && node.kind !== "test") entry.tested = true;
      nodes.push(entry);
    }
    // Parents first, so renderers can draw containers below their contents.
    nodes.sort((a, b) => a.depth - b.depth || compareStrings(a.id, b.id));
    return {
      size: layout.size,
      nodes,
      districts: this.#districts().map((d) => ({ id: d.id, name: d.name })),
    };
  }

  roads(depth: number): RoadsView {
    let view = this.#roads.get(depth);
    if (!view) {
      view = { depth, roads: roads(this.index(), this.#layout(), depth) };
      this.#roads.set(depth, view);
    }
    return view;
  }

  node(id: string): NodeDetails | undefined {
    const index = this.index();
    const node = index.node(id);
    if (!node) return undefined;
    const outgoing = index.out(id).filter((e) => e.kind !== "contains");
    const incoming = index.in(id).filter((e) => e.kind !== "contains");
    const m = this.#metrics().get(id);
    const details: NodeDetails = {
      node,
      ancestors: index.ancestors(id).map((a) => this.summary(a)),
      children: index.children(id).map((c) => this.summary(c)),
      outgoing: outgoing.slice(0, EDGE_LIMIT).map((e) => this.#edgeView(e, e.target)),
      incoming: incoming.slice(0, EDGE_LIMIT).map((e) => this.#edgeView(e, e.source)),
      truncated: outgoing.length > EDGE_LIMIT || incoming.length > EDGE_LIMIT,
      metrics: {
        fanIn: m?.fanIn ?? 0,
        fanOut: m?.fanOut ?? 0,
        lines: m?.lines ?? 0,
        centrality: m?.centrality ?? 0,
      },
    };
    const rank = this.#ranks().get(id);
    if (rank !== undefined) details.metrics.rank = rank;
    const district = this.#districtFor(id);
    if (district !== undefined) {
      const d = this.#districts()[district];
      if (d) details.district = { id: d.id, name: d.name };
    }
    const file = node.location?.file;
    const git = this.snapshot.git;
    if (file && git) {
      const history = git.files[file];
      if (history) details.git = history;
      details.coChanges = git.coChange
        .filter((c) => c.a === file || c.b === file)
        .slice(0, 10)
        .map((c) => ({ file: c.a === file ? c.b : c.a, count: c.count, confidence: c.confidence }));
    }
    return details;
  }

  /**
   * Source lines of a project file. Only files that are modules of the graph are served, so
   * a caller can never read arbitrary paths.
   */
  source(file: string, start = 1, end = Number.POSITIVE_INFINITY): SourceView | undefined {
    const mod = this.#modules().get(file);
    if (!mod) return undefined;
    const text = this.#source(file);
    if (text === undefined) return undefined;
    const all = text.split("\n");
    const first = Math.max(1, Math.floor(start));
    const last = Math.min(all.length, Math.floor(end));
    const view: SourceView = {
      file,
      startLine: first,
      lines: all.slice(first - 1, last),
      totalLines: all.length,
    };
    if (mod.language) view.language = mod.language;
    return view;
  }

  search(query: string, limit = 20): SearchView {
    const result = this.#features().search(query, { limit });
    return {
      query: result.query,
      terms: result.terms,
      hits: result.hits.map((hit) => ({ ...hit, node: this.summary(hit.id) })),
      territory: {
        modules: result.territory.modules.map((m) => ({
          node: this.summary(m.id),
          score: m.score,
        })),
        entryPoints: result.territory.entryPoints.map((id) => this.summary(id)),
        tests: result.territory.tests.map((id) => this.summary(id)),
      },
    };
  }

  /**
   * Declarations in one file that editors annotate (functions, methods, classes, interfaces,
   * components, routes, commands), with how many distinct nodes call and depend on each.
   */
  fileSymbols(file: string): FileSymbol[] {
    const index = this.index();
    const mod = this.#modules().get(file);
    if (!mod) return [];
    const calls: readonly EdgeKind[] = [...CALL_KINDS];
    const out: FileSymbol[] = [];
    for (const id of index.descendants(mod.id)) {
      const node = index.node(id);
      if (!node?.location || !LENS_KINDS.has(node.kind)) continue;
      const distinct = (edges: readonly { source: string }[]) =>
        new Set(edges.map((e) => e.source).filter((source) => source !== id)).size;
      out.push({
        ...summarize(node),
        line: node.location.line,
        column: node.location.column,
        callers: distinct(index.in(id, calls)),
        dependents: distinct(index.in(id, DEPENDENCY_KINDS)),
      });
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  /**
   * Nodes a user-typed reference may mean: an exact ID, `path#Qualified.Name`, `path:line`
   * (the innermost symbol there), a path, or a name (exact, then case-insensitive).
   */
  resolve(reference: string): Summary[] {
    const index = this.index();
    const ref = reference.trim();
    if (index.node(ref)) return [this.summary(ref)];
    const nodes = [...index.nodes.values()];
    const hash = ref.indexOf("#");
    if (hash > 0) {
      const path = ref.slice(0, hash);
      const qn = ref.slice(hash + 1);
      const found = nodes.filter((n) => n.location?.file === path && n.qualifiedName === qn);
      if (found.length > 0) return found.map(summarize);
    }
    const lineRef = /^(.+):(\d+)$/.exec(ref);
    if (lineRef) {
      const ids = symbolsForChanges(
        index,
        new Map([[lineRef[1] as string, [{ start: Number(lineRef[2]), end: Number(lineRef[2]) }]]]),
      );
      if (ids.length > 0) return ids.map((id) => this.summary(id));
    }
    const byPath = nodes.filter(
      (n) =>
        (n.kind === "module" || n.kind === "directory" || n.kind === "package") &&
        n.qualifiedName === ref,
    );
    if (byPath.length > 0) return byPath.map(summarize);
    const exact = nodes.filter((n) => n.name === ref || n.qualifiedName === ref);
    if (exact.length > 0) return exact.map(summarize).sort((a, b) => compareStrings(a.id, b.id));
    const lower = ref.toLowerCase();
    return nodes
      .filter((n) => n.name.toLowerCase() === lower || n.qualifiedName.toLowerCase() === lower)
      .map(summarize)
      .sort((a, b) => compareStrings(a.id, b.id));
  }

  impact(ids: readonly string[], options: ImpactOptions = {}): ImpactView {
    const report = impact(this.index(), ids, options);
    const withNode = <T extends { id: string }>(item: T) => ({
      ...item,
      node: this.summary(item.id),
    });
    return {
      targets: report.targets.map((id) => this.summary(id)),
      impacted: report.impacted.slice(0, IMPACT_LIMIT).map(withNode),
      truncated: report.impacted.length > IMPACT_LIMIT,
      rings: report.rings,
      entryPoints: report.entryPoints.map(withNode),
      tests: report.tests.map(withNode),
      modules: report.modules,
      risk: report.risk,
    };
  }

  /** Impact of a unified diff (`git diff` output): the changed symbols, then what they affect. */
  impactOfDiff(
    diff: string,
    options: ImpactOptions = {},
  ): { changed: Summary[]; report: ImpactView } {
    const changed = symbolsForChanges(this.index(), parseUnifiedDiff(diff));
    return {
      changed: changed.map((id) => this.summary(id)),
      report: this.impact(changed, options),
    };
  }

  trace(from: string, to: string, options: { k?: number; kinds?: EdgeKind[] } = {}): TraceView {
    return {
      paths: tracePaths(this.index(), from, to, options).map((p) => ({
        nodes: p.nodes.map((id) => this.summary(id)),
        edges: p.edges,
        cost: p.cost,
        confidence: p.confidence,
      })),
    };
  }

  tree(id: string, direction: "in" | "out" = "out", depth = 3): TreeView {
    const tree = callTree(this.index(), id, { direction, depth });
    const ids = new Set<string>();
    const visit = (t: NonNullable<typeof tree>): void => {
      ids.add(t.id);
      for (const child of t.children) visit(child);
    };
    if (tree) visit(tree);
    return { tree, nodes: Object.fromEntries([...ids].map((n) => [n, this.summary(n)])) };
  }

  cycles(options: ImportCycleOptions = {}): CyclesView {
    const view = (cycle: Cycle): CycleView => ({
      ...cycle,
      members: cycle.members.map((id) => this.summary(id)),
    });
    const imports =
      options.ignoreTypeOnly || options.ignoreDeferred
        ? importCycles(this.index(), options)
        : this.#importCycles();
    return { imports: imports.map(view), calls: callCycles(this.index()).map(view) };
  }

  insights(): InsightsView {
    const index = this.index();
    const spots = hotspots(index, this.#metrics());
    const git = this.snapshot.git;
    return {
      deadCode: deadCode(index).map((d) => ({ ...this.summary(d.id), lines: d.lines })),
      unusedExports: unusedExports(index).map((id) => this.summary(id)),
      hotspots: {
        modules: spots.modules.map((m) => ({ ...m, node: this.summary(m.id) })),
        classes: spots.classes.map((c) => ({ ...c, node: this.summary(c.id) })),
      },
      districts: this.#districts().map((d) => ({
        id: d.id,
        name: d.name,
        highlights: d.highlights,
        modules: d.modules.length,
        sample: d.modules.slice(0, 5).map((id) => this.summary(id)),
      })),
      churn: git
        ? Object.entries(git.files)
            .filter(([file]) => this.#modules().has(file))
            .map(([file, h]) => ({ file, commits: h.commits, authors: h.authors.length }))
            .sort((a, b) => b.commits - a.commits || compareStrings(a.file, b.file))
            .slice(0, 50)
        : [],
    };
  }

  /**
   * Dependency structure matrix between modules or directories, ordered by district then
   * path so related items sit together.
   */
  dsm(level: "module" | "directory" = "module", limit = 400): DsmView {
    const index = this.index();
    const graph = moduleGraph(index);
    const groupOf = (mod: string): string | undefined => {
      if (level === "module") return mod;
      return index.parent(mod);
    };
    const counts = new Map<string, Map<string, number>>();
    for (const [a, row] of graph) {
      const ga = groupOf(a);
      if (!ga) continue;
      for (const [b, w] of row) {
        const gb = groupOf(b);
        if (!gb || ga === gb) continue;
        const r = counts.get(ga) ?? new Map<string, number>();
        r.set(gb, (r.get(gb) ?? 0) + w);
        counts.set(ga, r);
      }
    }
    const districtOf = this.#districtOf();
    const items = [
      ...new Set(
        index.byKind("module").flatMap((m) => {
          const g = groupOf(m.id);
          return g ? [g] : [];
        }),
      ),
    ]
      .sort(
        (a, b) =>
          (districtOf.get(a) ?? 0) - (districtOf.get(b) ?? 0) ||
          compareStrings(this.summary(a).label, this.summary(b).label),
      )
      .slice(0, limit);
    const position = new Map(items.map((id, i) => [id, i]));
    const cells: [number, number, number][] = [];
    for (const [a, row] of counts) {
      const i = position.get(a);
      if (i === undefined) continue;
      for (const [b, w] of row) {
        const j = position.get(b);
        if (j !== undefined) cells.push([i, j, w]);
      }
    }
    cells.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return { level, items: items.map((id) => this.summary(id)), cells };
  }
}

function summarize(node: GraphNode): Summary {
  const summary: Summary = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    label: node.qualifiedName || node.name,
  };
  if (node.location) {
    summary.file = node.location.file;
    summary.line = node.location.line;
  }
  if (node.language) summary.language = node.language;
  return summary;
}

const round = (value: number): number => Math.round(value * 100) / 100;
