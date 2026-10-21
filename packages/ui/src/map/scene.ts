import type { MapData, MapNode } from "@xray/service";
import { type Camera, toScreen, type Viewport } from "./camera";

/** MapData reorganized for fast drawing and hit testing. */
export type Scene = {
  size: number;
  nodes: MapNode[];
  indexOf: Map<string, number>;
  children: number[][];
  roots: number[];
  /** Median radius of the nodes at each depth (for choosing the level of detail). */
  medianRadius: number[];
  maxDepth: number;
};

export function buildScene(map: MapData): Scene {
  const nodes = map.nodes;
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const children: number[][] = nodes.map(() => []);
  const roots: number[] = [];
  nodes.forEach((node, i) => {
    const parent = node.parent === undefined ? undefined : indexOf.get(node.parent);
    if (parent === undefined) roots.push(i);
    else children[parent]?.push(i);
  });
  const byDepth: number[][] = [];
  let maxDepth = 0;
  for (const node of nodes) {
    byDepth[node.depth] ??= [];
    byDepth[node.depth]?.push(node.r);
    maxDepth = Math.max(maxDepth, node.depth);
  }
  const medianRadius = byDepth.map((radii) => {
    const sorted = [...(radii ?? [])].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  });
  return { size: map.size, nodes, indexOf, children, roots, medianRadius, maxDepth };
}

/**
 * Indices of nodes worth drawing, parents before children. A subtree is skipped when its
 * container is off screen or too small to show detail, which keeps frames cheap at any zoom.
 */
export function visibleNodes(
  scene: Scene,
  camera: Camera,
  viewport: Viewport,
  minPixels = 0.8,
): number[] {
  const out: number[] = [];
  const margin = 2;
  const stack = [...scene.roots].reverse();
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const node = scene.nodes[i] as MapNode;
    const r = node.r * camera.scale;
    if (r < minPixels) continue;
    const [sx, sy] = toScreen(camera, viewport, node.x, node.y);
    if (
      sx + r < -margin ||
      sy + r < -margin ||
      sx - r > viewport.width + margin ||
      sy - r > viewport.height + margin
    ) {
      continue;
    }
    out.push(i);
    // Children of a container smaller than a few pixels would be invisible specks.
    if (r < 3) continue;
    const kids = scene.children[i] as number[];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k] as number);
  }
  return out;
}

/**
 * The deepest node under a screen point that is at least `minPixels` across. Pack layouts
 * nest children inside parents without overlap, so a single descent finds it.
 */
export function hitTest(
  scene: Scene,
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number,
  minPixels = 3,
): number | undefined {
  const contains = (i: number): boolean => {
    const node = scene.nodes[i] as MapNode;
    const [cx, cy] = toScreen(camera, viewport, node.x, node.y);
    const r = node.r * camera.scale;
    return r >= minPixels && (sx - cx) ** 2 + (sy - cy) ** 2 <= r * r;
  };
  let found: number | undefined;
  let candidates = scene.roots;
  while (true) {
    const next = candidates.find(contains);
    if (next === undefined) return found;
    found = next;
    candidates = scene.children[next] as number[];
  }
}

/**
 * The deepest containment level whose typical circle is big enough on screen to read: roads
 * between containers at this depth are the ones drawn.
 */
export function lodDepth(scene: Scene, scale: number, minPixels = 36): number {
  let depth = 1;
  for (let d = 1; d <= scene.maxDepth; d++) {
    if ((scene.medianRadius[d] ?? 0) * scale >= minPixels) depth = d;
  }
  return depth;
}

/** `id` and the IDs of all its ancestors in the scene. */
export function lineage(scene: Scene, id: string): string[] {
  const out: string[] = [];
  let current: string | undefined = id;
  while (current !== undefined && scene.indexOf.has(current)) {
    out.push(current);
    current = scene.nodes[scene.indexOf.get(current) as number]?.parent;
  }
  return out;
}

/** The node itself, or its nearest ancestor present at depth ≤ `depth`. */
export function ancestorAtDepth(scene: Scene, id: string, depth: number): string | undefined {
  return lineage(scene, id).find(
    (a) => (scene.nodes[scene.indexOf.get(a) as number]?.depth ?? 99) <= depth,
  );
}
