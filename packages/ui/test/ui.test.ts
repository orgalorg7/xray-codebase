import type { MapData, MapNode } from "@xray/service";
import { describe, expect, it } from "vitest";
import { formatCount, shortPath, timeAgo } from "../src/format";
import { frameCircle, interpolate, toMap, toScreen, zoomAt } from "../src/map/camera";
import { buildScene, hitTest, lineage, lodDepth, visibleNodes } from "../src/map/scene";
import { layeredLayout } from "../src/panels/focus-layout";
import { fromHash, initialState, toHash } from "../src/state";

const node = (
  id: string,
  x: number,
  y: number,
  r: number,
  depth: number,
  parent?: string,
): MapNode => ({
  id,
  kind: depth === 0 ? "repo" : depth === 1 ? "directory" : "function",
  name: id,
  label: id,
  x,
  y,
  r,
  depth,
  lines: 1,
  fanIn: 0,
  fanOut: 0,
  ...(parent ? { parent } : {}),
});

const map: MapData = {
  size: 1000,
  districts: [],
  nodes: [
    node("repo:", 500, 500, 500, 0),
    node("dir:a", 300, 500, 200, 1, "repo:"),
    node("dir:b", 750, 500, 150, 1, "repo:"),
    node("a#f", 300, 450, 20, 2, "dir:a"),
    node("a#g", 300, 560, 2, 2, "dir:a"),
    node("b#h", 750, 500, 30, 2, "dir:b"),
  ],
};

describe("camera", () => {
  const vp = { width: 800, height: 600 };

  it("round-trips screen and map coordinates", () => {
    const cam = { x: 120, y: 80, scale: 2.5 };
    const [sx, sy] = toScreen(cam, vp, 300, 200);
    const [mx, my] = toMap(cam, vp, sx, sy);
    expect(mx).toBeCloseTo(300);
    expect(my).toBeCloseTo(200);
  });

  it("zooms around the cursor", () => {
    const cam = { x: 500, y: 500, scale: 1 };
    const before = toMap(cam, vp, 100, 100);
    const after = toMap(zoomAt(cam, vp, 100, 100, 3), vp, 100, 100);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("frames circles and flies between cameras", () => {
    expect(frameCircle(10, 20, 50, vp, 1)).toEqual({ x: 10, y: 20, scale: 6 });
    const a = { x: 0, y: 0, scale: 10 };
    const b = { x: 1000, y: 0, scale: 10 };
    expect(interpolate(a, b, 0)).toEqual(a);
    expect(interpolate(a, b, 1)).toEqual(b);
    // Long flights zoom out mid-way.
    expect(interpolate(a, b, 0.5).scale).toBeLessThan(10);
  });
});

describe("scene", () => {
  const scene = buildScene(map);
  const vp = { width: 1000, height: 1000 };

  it("indexes parents and children", () => {
    expect(scene.roots).toEqual([0]);
    expect(scene.children[1]).toEqual([3, 4]);
    expect(lineage(scene, "a#f")).toEqual(["a#f", "dir:a", "repo:"]);
  });

  it("culls tiny and off-screen subtrees", () => {
    const all = visibleNodes(scene, { x: 500, y: 500, scale: 1 }, vp).map(
      (i) => scene.nodes[i]?.id,
    );
    expect(all).toEqual(["repo:", "dir:a", "a#f", "a#g", "dir:b", "b#h"]);
    // Zoomed into dir:b, dir:a's subtree is off screen.
    const zoomed = visibleNodes(scene, { x: 750, y: 500, scale: 6 }, vp).map(
      (i) => scene.nodes[i]?.id,
    );
    expect(zoomed).toEqual(["repo:", "dir:b", "b#h"]);
    // Zoomed far out, nothing smaller than a pixel is drawn.
    const far = visibleNodes(scene, { x: 500, y: 500, scale: 0.01 }, vp).map(
      (i) => scene.nodes[i]?.id,
    );
    expect(far).toEqual(["repo:", "dir:a", "dir:b"]);
  });

  it("hit-tests the deepest node big enough to click", () => {
    const cam = { x: 500, y: 500, scale: 1 };
    expect(scene.nodes[hitTest(scene, cam, vp, 300, 450) ?? -1]?.id).toBe("a#f");
    expect(scene.nodes[hitTest(scene, cam, vp, 300, 560) ?? -1]?.id).toBe("dir:a"); // a#g is 2px
    expect(scene.nodes[hitTest(scene, cam, vp, 10, 10) ?? -1]?.id).toBeUndefined();
  });

  it("picks the level of detail from the zoom", () => {
    expect(lodDepth(scene, 1)).toBe(1); // median symbol is 20px: too small to read
    expect(lodDepth(scene, 2)).toBe(2);
    expect(lodDepth(scene, 0.1)).toBe(1);
  });
});

describe("layeredLayout", () => {
  it("layers a chain left to right and breaks cycles", () => {
    const layout = layeredLayout(
      ["a", "b", "c"],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "a" },
      ],
    );
    const layers = ["a", "b", "c"].map((id) => layout.positions.get(id)?.layer);
    expect(new Set(layers).size).toBe(3);
    expect(layout.reversed.size).toBe(1);
  });

  it("stacks siblings in one layer", () => {
    const layout = layeredLayout(
      ["r", "x", "y"],
      [
        { source: "r", target: "x" },
        { source: "r", target: "y" },
      ],
    );
    expect(layout.positions.get("x")?.x).toBe(layout.positions.get("y")?.x);
    expect(layout.positions.get("x")?.y).not.toBe(layout.positions.get("y")?.y);
  });
});

describe("URL state", () => {
  it("round-trips the shareable state", () => {
    const base = initialState("light");
    const state = {
      ...base,
      mode: "impact" as const,
      selected: "ts:a.ts#f",
      impactTarget: "ts:a.ts#f",
      impactDepth: 2,
      impactHeuristic: false,
      territory: "login flow",
      tree: { id: "ts:a.ts#f", direction: "in" as const },
      layers: new Set(["cycles" as const, "dead" as const]),
    };
    const restored = fromHash(`#${toHash(state)}`, base);
    expect(restored).toMatchObject({
      mode: "impact",
      selected: "ts:a.ts#f",
      impactTarget: "ts:a.ts#f",
      impactDepth: 2,
      impactHeuristic: false,
      territory: "login flow",
      query: "login flow",
      tree: { id: "ts:a.ts#f", direction: "in" },
    });
    expect([...restored.layers].sort()).toEqual(["cycles", "dead"]);
    expect(toHash(base)).toBe("");
    expect(fromHash("#mode=bogus&layers=none", base)).toMatchObject({ mode: "explore" });
  });
});

describe("format", () => {
  it("formats counts, paths and times", () => {
    expect([999, 1200, 25000, 3_400_000].map(formatCount)).toEqual(["999", "1.2k", "25k", "3.4M"]);
    expect(shortPath("a/very/long/path/to/some/file.ts", 20)).toBe("…/to/some/file.ts");
    expect(timeAgo("2026-01-01T00:00:00Z", Date.parse("2026-01-03T00:00:00Z"))).toBe("2 days ago");
  });
});
