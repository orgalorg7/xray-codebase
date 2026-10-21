import { REPO_ID } from "@xray/schema";
import { hierarchy, pack } from "d3-hierarchy";
import { compareStrings, DEPENDENCY_KINDS, type GraphIndex } from "./graph-index.js";

export type Placement = {
  x: number;
  y: number;
  r: number;
  /** 0 for the repo, 1 for top-level directories, ... */
  depth: number;
};

export type MapLayout = {
  /** The map spans [0, size] on both axes. */
  size: number;
  placements: Map<string, Placement>;
};

type Tree = { id: string; lines: number; children: Tree[] };

/**
 * The base map: containment (repo → directories → modules → symbols) as nested circles sized
 * by lines of code. Deterministic, so a node keeps its place between scans unless code moves.
 * External packages orbit outside the repo circle.
 */
export function mapLayout(index: GraphIndex, size = 1000): MapLayout {
  const lines = (id: string): number => {
    const loc = index.node(id)?.location;
    return loc ? Math.max(1, (loc.endLine ?? loc.line) - loc.line + 1) : 1;
  };
  const build = (id: string, seen: Set<string>): Tree => {
    seen.add(id);
    const children = index
      .children(id)
      .filter((child) => !seen.has(child))
      .sort()
      .map((child) => build(child, seen));
    return { id, lines: lines(id), children };
  };
  const placements = new Map<string, Placement>();
  const rootId = index.node(REPO_ID) ? REPO_ID : undefined;
  const externals = index
    .byKind("external")
    .map((n) => n.id)
    .sort();
  const seen = new Set<string>();
  const root: Tree = rootId
    ? build(rootId, seen)
    : { id: REPO_ID, lines: 1, children: index.byKind("module").map((m) => build(m.id, seen)) };

  const inner = externals.length > 0 ? size * 0.86 : size;
  const packed = pack<Tree>()
    .size([inner, inner])
    .padding((node) => (node.depth === 0 ? 8 : 3))(
    hierarchy(root, (d) => d.children)
      // A container's own body (lines outside its children) still takes space.
      .sum((d) =>
        d.children.length === 0
          ? d.lines
          : Math.max(0, d.lines - d.children.reduce((s, c) => s + c.lines, 0)) * 0.2,
      )
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || compareStrings(a.data.id, b.data.id)),
  );
  const offset = (size - inner) / 2;
  for (const node of packed.descendants()) {
    placements.set(node.data.id, {
      x: node.x + offset,
      y: node.y + offset,
      r: node.r,
      depth: node.depth,
    });
  }

  if (externals.length > 0) {
    const center = size / 2;
    const orbit = inner / 2 + (size - inner) / 4;
    const r = Math.min((size - inner) / 9, (Math.PI * orbit * 0.6) / externals.length);
    externals.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / externals.length - Math.PI / 2;
      placements.set(id, {
        x: center + orbit * Math.cos(angle),
        y: center + orbit * Math.sin(angle),
        r,
        depth: 1,
      });
    });
  }
  return { size, placements };
}

const AREA_KINDS: ReadonlySet<string> = new Set([
  "repo",
  "package",
  "directory",
  "module",
  "external",
]);

export type Road = {
  source: string;
  target: string;
  weight: number;
  kinds: Partial<Record<string, number>>;
};

/**
 * Dependency edges lifted to the containers visible at a zoom level: every edge between two
 * symbols counts toward the edge between their ancestors at `depth` (in the layout's terms).
 * These are the "roads" drawn when zoomed out.
 */
export function roads(index: GraphIndex, layout: MapLayout, depth: number): Road[] {
  // Roads join areas (directories, packages, files), never individual symbols: symbol-level
  // relations are shown for a selection instead.
  const isArea = (id: string): boolean => AREA_KINDS.has(index.node(id)?.kind ?? "function");
  const lift = (id: string): string | undefined => {
    const own = layout.placements.get(id);
    if (!own) return undefined;
    if (own.depth <= depth && isArea(id)) return id;
    return index
      .ancestors(id)
      .find(
        (a) => isArea(a) && (layout.placements.get(a)?.depth ?? Number.POSITIVE_INFINITY) <= depth,
      );
  };
  const roadMap = new Map<string, Road>();
  for (const edge of index.edges) {
    if (!DEPENDENCY_KINDS.includes(edge.kind)) continue;
    const a = lift(edge.source);
    const b = lift(edge.target);
    if (!a || !b || a === b) continue;
    const key = `${a}\u0000${b}`;
    const road = roadMap.get(key) ?? { source: a, target: b, weight: 0, kinds: {} };
    road.weight++;
    road.kinds[edge.kind] = (road.kinds[edge.kind] ?? 0) + 1;
    roadMap.set(key, road);
  }
  return [...roadMap.values()].sort(
    (x, y) =>
      y.weight - x.weight ||
      compareStrings(x.source, y.source) ||
      compareStrings(x.target, y.target),
  );
}
