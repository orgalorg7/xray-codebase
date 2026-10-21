import type { Summary } from "@xray/service";
import { useMemo } from "react";
import { useApp } from "../context";
import { kindColor } from "../map/colors";
import { EDGE_COLORS, palette } from "../map/draw";
import { type FocusEdge, layeredLayout } from "./focus-layout";

/** A small left-to-right diagram of a few nodes and their edges (cycles, call chains). */
export function FocusGraph({
  nodes,
  edges,
  cut = [],
}: {
  nodes: Summary[];
  edges: (FocusEdge & { kind?: string })[];
  /** Edges drawn dashed red: suggested cuts. */
  cut?: FocusEdge[];
}) {
  const { theme, open } = useApp();
  const layout = useMemo(
    () =>
      layeredLayout(
        nodes.map((n) => n.id),
        edges,
        { layerGap: 170, nodeGap: 48 },
      ),
    [nodes, edges],
  );
  const colors = palette(theme);
  const pad = 70;
  const width = layout.width + pad * 2 + 60;
  const height = layout.height + pad * 2;
  const isCut = (e: FocusEdge) => cut.some((c) => c.source === e.source && c.target === e.target);
  return (
    <div className="focus-graph-scroll">
      <svg
        className="focus-graph"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Diagram of the selected nodes and their dependencies"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.muted} />
          </marker>
          <marker
            id="arrow-cut"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.cycle} />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = layout.positions.get(e.source);
          const b = layout.positions.get(e.target);
          if (!a || !b) return null;
          const ax = a.x + pad;
          const ay = a.y + pad;
          const bx = b.x + pad;
          const by = b.y + pad;
          const back = b.x <= a.x;
          // Back edges arc below the layers so they do not hide forward edges.
          const c = back
            ? `${(ax + bx) / 2} ${Math.max(ay, by) + 60}`
            : `${(ax + bx) / 2} ${(ay + by) / 2}`;
          const cutEdge = isCut(e);
          return (
            <path
              key={`${e.source}->${e.target}`}
              d={`M ${ax + (back ? 0 : 10)} ${ay} Q ${c} ${bx - (back ? 0 : 10)} ${by}`}
              fill="none"
              stroke={
                cutEdge
                  ? colors.cycle
                  : (EDGE_COLORS[theme][e.kind as keyof (typeof EDGE_COLORS)["light"]] ??
                    colors.muted)
              }
              strokeWidth={cutEdge ? 2.2 : 1.4}
              strokeDasharray={cutEdge ? "6 4" : undefined}
              markerEnd={cutEdge ? "url(#arrow-cut)" : "url(#arrow)"}
              opacity={0.85}
            >
              <title>
                {cutEdge
                  ? "Suggested cut: removing this breaks the cycle"
                  : (e.kind ?? "depends on")}
              </title>
            </path>
          );
        })}
        {nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
            <g
              key={n.id}
              transform={`translate(${p.x + pad} ${p.y + pad})`}
              className="focus-node"
              onClick={() => open(n.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && open(n.id)}
            >
              <circle r={9} fill={kindColor(n.kind, theme)} />
              <text y={-14} textAnchor="middle" fill={colors.text} fontSize={12}>
                {n.name}
              </text>
              <title>{n.label}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
