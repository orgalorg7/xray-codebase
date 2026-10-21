import type { Road } from "@xray/analysis";
import type { Confidence, EdgeKind } from "@xray/schema";
import type { MapNode } from "@xray/service";
import type { LayerKey } from "../state";
import { type Camera, toScreen, type Viewport } from "./camera";
import { containerFill, containerStroke, heatColor, kindColor, type Theme } from "./colors";
import type { Scene } from "./scene";

/** An emphasized set of nodes (search hits, impact rings, a route, a cycle). */
export type Highlight = {
  /** Ring color per node ID. */
  colors: Map<string, string>;
  /** Fade everything that is not highlighted (or an ancestor of something highlighted). */
  dim: boolean;
};

/** A line drawn between two nodes: a selected node's relations, a route, a cycle. */
export type EdgeLine = {
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: Confidence;
  emphasis?: "route" | "cut" | "normal";
};

export type DrawInput = {
  ctx: CanvasRenderingContext2D;
  scene: Scene;
  camera: Camera;
  viewport: Viewport;
  theme: Theme;
  visible: number[];
  layers: ReadonlySet<LayerKey>;
  selected?: string | undefined;
  hovered?: string | undefined;
  highlight?: Highlight | undefined;
  roads?: Road[] | undefined;
  edges?: EdgeLine[] | undefined;
  maxChurn: number;
};

const CONTAINER_KINDS = new Set(["repo", "directory", "package", "module"]);

export const palette = (theme: Theme) =>
  theme === "dark"
    ? {
        bg: "#0d1117",
        text: "#e6edf3",
        muted: "#8b949e",
        outline: "#0d1117",
        road: "rgba(139,148,158,",
        select: "#58a6ff",
        cycle: "#ff6b70",
      }
    : {
        bg: "#f6f8fa",
        text: "#1f2328",
        muted: "#57606a",
        outline: "#ffffff",
        road: "rgba(87,96,106,",
        select: "#0969da",
        cycle: "#d1242f",
      };

export const EDGE_COLORS: Record<Theme, Partial<Record<EdgeKind, string>>> = {
  light: {
    calls: "#2f6fdb",
    instantiates: "#8250df",
    references: "#6e7781",
    imports: "#9a6700",
    extends: "#bf3989",
    implements: "#bf3989",
    overrides: "#bf3989",
    handles: "#e5484d",
    "re-exports": "#9a6700",
  },
  dark: {
    calls: "#6ea8ff",
    instantiates: "#b392f0",
    references: "#8b949e",
    imports: "#e3b341",
    extends: "#f47ec1",
    implements: "#f47ec1",
    overrides: "#f47ec1",
    handles: "#ff6b70",
    "re-exports": "#e3b341",
  },
};

const isContainer = (node: MapNode, scene: Scene, i: number): boolean =>
  CONTAINER_KINDS.has(node.kind) || (scene.children[i]?.length ?? 0) > 0;

/** IDs of highlighted nodes and all their ancestors: these stay bright when dimming. */
function litSet(
  scene: Scene,
  highlight: Highlight | undefined,
  selected: string | undefined,
): Set<string> {
  const lit = new Set<string>();
  const add = (id: string) => {
    let current: string | undefined = id;
    while (current !== undefined && !lit.has(current)) {
      lit.add(current);
      const index = scene.indexOf.get(current);
      current = index === undefined ? undefined : scene.nodes[index]?.parent;
    }
  };
  for (const id of highlight?.colors.keys() ?? []) add(id);
  if (selected) add(selected);
  return lit;
}

function curve(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bend = 0.18,
): { cx: number; cy: number } {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  // Bend to the left of the direction of travel, so A→B and B→A do not overlap.
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  return { cx, cy };
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fromX: number,
  fromY: number,
  size: number,
): void {
  const angle = Math.atan2(y - fromY, x - fromX);
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - 0.45), y - size * Math.sin(angle - 0.45));
  ctx.lineTo(x - size * Math.cos(angle + 0.45), y - size * Math.sin(angle + 0.45));
  ctx.closePath();
}

export function draw(input: DrawInput): void {
  const { ctx, scene, camera, viewport, theme, visible, layers, highlight } = input;
  const colors = palette(theme);
  const lit = litSet(scene, highlight, input.selected);
  const dimming = highlight?.dim === true;
  const screen = (node: MapNode) => toScreen(camera, viewport, node.x, node.y);

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  // 1. Territories and symbols, parents first.
  for (const i of visible) {
    const node = scene.nodes[i] as MapNode;
    const [x, y] = screen(node);
    const r = node.r * camera.scale;
    const faded = dimming && !lit.has(node.id);
    ctx.globalAlpha = faded ? 0.28 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (isContainer(node, scene, i)) {
      const district = layers.has("districts") ? node.district : undefined;
      let fill = containerFill(theme, district, node.depth, node.kind === "module");
      if (layers.has("churn") && node.kind === "module" && node.churn !== undefined) {
        fill = heatColor(node.churn, input.maxChurn, theme);
      }
      ctx.fillStyle = fill;
      ctx.fill();
      if (r > 6) {
        ctx.lineWidth = node.kind === "module" ? 1.2 : 1;
        ctx.strokeStyle = containerStroke(theme, district);
        ctx.stroke();
      }
    } else {
      const color = kindColor(node.kind, theme);
      if (layers.has("dead") && node.dead) {
        ctx.setLineDash([Math.max(1, r / 3), Math.max(1, r / 4)]);
        ctx.lineWidth = Math.max(1, Math.min(2.5, r / 4));
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
      if (
        layers.has("coverage") &&
        !node.tested &&
        (node.kind === "function" || node.kind === "method") &&
        r > 2
      ) {
        ctx.beginPath();
        ctx.arc(x, y, r + Math.max(1.5, r * 0.25), 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, r * 0.18);
        ctx.strokeStyle = colors.cycle;
        ctx.stroke();
      }
    }
    if (layers.has("cycles") && node.inCycle && r > 2) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, Math.min(4, r / 12));
      ctx.strokeStyle = colors.cycle;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // 2. Roads between the areas visible at this zoom.
  if (input.roads && input.roads.length > 0 && layers.has("roads")) {
    const maxWeight = Math.max(...input.roads.map((r) => r.weight));
    for (const road of input.roads) {
      const a = scene.nodes[scene.indexOf.get(road.source) ?? -1];
      const b = scene.nodes[scene.indexOf.get(road.target) ?? -1];
      if (!a || !b) continue;
      const [ax, ay] = screen(a);
      const [bx, by] = screen(b);
      // A selection or highlight pushes the roads into the background.
      const faded =
        (dimming || input.selected !== undefined) &&
        !(lit.has(road.source) && lit.has(road.target));
      const t = Math.log1p(road.weight) / Math.log1p(maxWeight);
      ctx.beginPath();
      curve(ctx, ax, ay, bx, by, 0.12);
      ctx.lineWidth = 0.6 + t * 4;
      ctx.strokeStyle = `${colors.road}${faded ? 0.05 : 0.12 + t * 0.3})`;
      ctx.stroke();
    }
  }

  // 3. Explicit edges: the selection's relations, routes, cycles.
  for (const edge of input.edges ?? []) {
    const a = scene.nodes[scene.indexOf.get(edge.source) ?? -1];
    const b = scene.nodes[scene.indexOf.get(edge.target) ?? -1];
    if (!a || !b) continue;
    const [ax, ay] = screen(a);
    const [bx, by] = screen(b);
    const br = b.r * camera.scale;
    const color =
      edge.emphasis === "cut" ? colors.cycle : (EDGE_COLORS[theme][edge.kind] ?? colors.muted);
    const width = edge.emphasis === "route" ? 3.2 : 1.6;
    ctx.beginPath();
    const { cx, cy } = curve(ctx, ax, ay, bx, by);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.setLineDash(
      edge.confidence === "heuristic" || edge.emphasis === "cut"
        ? [6, 5]
        : edge.confidence === "inferred"
          ? [2, 3]
          : [],
    );
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.setLineDash([]);
    // Arrow at the target's rim.
    const angle = Math.atan2(by - cy, bx - cx);
    const tipX = bx - Math.cos(angle) * Math.min(br, 40);
    const tipY = by - Math.sin(angle) * Math.min(br, 40);
    ctx.beginPath();
    arrowHead(ctx, tipX, tipY, cx, cy, 6 + width * 1.5);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 4. Highlight rings.
  if (highlight) {
    for (const [id, color] of highlight.colors) {
      const node = scene.nodes[scene.indexOf.get(id) ?? -1];
      if (!node) continue;
      const [x, y] = screen(node);
      const r = Math.max(4, node.r * camera.scale);
      if (x + r < 0 || y + r < 0 || x - r > viewport.width || y - r > viewport.height) continue;
      ctx.beginPath();
      ctx.arc(x, y, r + 2, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  // 5. Labels, biggest first, never overlapping.
  drawLabels(input, lit, dimming);

  // 6. Selection and hover.
  for (const [id, style] of [
    [input.hovered, "hover"],
    [input.selected, "select"],
  ] as const) {
    if (!id) continue;
    const node = scene.nodes[scene.indexOf.get(id) ?? -1];
    if (!node) continue;
    const [x, y] = screen(node);
    const r = Math.max(5, node.r * camera.scale);
    ctx.beginPath();
    ctx.arc(x, y, r + (style === "select" ? 4 : 2), 0, Math.PI * 2);
    ctx.lineWidth = style === "select" ? 3 : 1.5;
    ctx.strokeStyle = style === "select" ? colors.select : colors.muted;
    ctx.stroke();
  }
}

type Box = { x0: number; y0: number; x1: number; y1: number };

function drawLabels(input: DrawInput, lit: Set<string>, dimming: boolean): void {
  const { ctx, scene, camera, viewport, theme, visible } = input;
  const colors = palette(theme);
  const placed: Box[] = [];
  const overlaps = (b: Box) =>
    placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const candidates = visible
    .map((i) => ({
      i,
      node: scene.nodes[i] as MapNode,
      r: (scene.nodes[i] as MapNode).r * camera.scale,
    }))
    .filter(
      ({ node, r, i }) =>
        (isContainer(node, scene, i) ? r > 30 : r > 9) ||
        node.id === input.selected ||
        input.highlight?.colors.has(node.id),
    )
    .sort((a, b) => {
      const pa = a.node.id === input.selected ? 1e9 : a.r;
      const pb = b.node.id === input.selected ? 1e9 : b.r;
      return pb - pa;
    })
    .slice(0, 400);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const { i, node, r } of candidates) {
    const container = isContainer(node, scene, i);
    const [x, y] = toScreen(camera, input.viewport, node.x, node.y);
    const size = container
      ? Math.min(18, Math.max(11, r / 9))
      : Math.min(14, Math.max(10, r / 2.2));
    const label = node.name;
    ctx.font = `${container ? 600 : 500} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    const width = ctx.measureText(label).width;
    // Containers label their top edge, inside; symbols label below the dot.
    const ly = container ? y - r + size * 1.3 : y + Math.max(r, 3) + size * 0.85;
    if (container && width > r * 1.8) continue;
    const box: Box = {
      x0: x - width / 2 - 3,
      y0: ly - size / 2 - 2,
      x1: x + width / 2 + 3,
      y1: ly + size / 2 + 2,
    };
    if (box.x1 < 0 || box.y1 < 0 || box.x0 > viewport.width || box.y0 > viewport.height) continue;
    if (overlaps(box)) continue;
    placed.push(box);
    ctx.globalAlpha = dimming && !lit.has(node.id) ? 0.35 : 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.outline;
    ctx.strokeText(label, x, ly);
    ctx.fillStyle = container ? colors.text : colors.muted;
    if (node.id === input.selected) ctx.fillStyle = colors.select;
    ctx.fillText(label, x, ly);
  }
  ctx.globalAlpha = 1;
}
