import type { Road } from "@xray/analysis";
import type { MapNode } from "@xray/service";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { kindLabel, plural } from "../format";
import type { LayerKey } from "../state";
import { type Camera, frameCircle, interpolate, pan, type Viewport, zoomAt } from "./camera";
import type { Theme } from "./colors";
import { draw, type EdgeLine, type Highlight } from "./draw";
import { Minimap } from "./Minimap";
import { hitTest, lodDepth, type Scene, visibleNodes } from "./scene";

export type MapHandle = {
  /** Animates the camera to frame a node. */
  flyTo(id: string, fill?: number): void;
  /** Frames several nodes at once. */
  frame(ids: string[]): void;
  fit(): void;
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  camera(): Camera;
};

type Props = {
  scene: Scene;
  theme: Theme;
  layers: ReadonlySet<LayerKey>;
  selected?: string | undefined;
  hovered?: string | undefined;
  highlight?: Highlight | undefined;
  edges?: EdgeLine[] | undefined;
  /** Roads for a containment depth; the map asks for the depth matching its zoom. */
  roadsFor: (depth: number) => Road[] | undefined;
  onRoadsNeeded: (depth: number) => void;
  onSelect: (id: string | undefined) => void;
  onHover: (id: string | undefined) => void;
  /** Camera from the URL, applied once the viewport is known. */
  initialCamera?: Camera | undefined;
  onCameraChange?: (camera: Camera) => void;
};

/** The zoomable map: draws the scene on a canvas and turns pointer input into camera moves. */
export const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>({
    x: props.scene.size / 2,
    y: props.scene.size / 2,
    scale: 1,
  });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const animation = useRef<number | undefined>(undefined);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: MapNode } | undefined>();
  const fitted = useRef(false);

  const fitCamera = useCallback(
    (vp: Viewport): Camera => {
      const size = props.scene.size;
      return vp.width > 0
        ? frameCircle(size / 2, size / 2, size / 2, vp, 0.94)
        : { x: size / 2, y: size / 2, scale: 1 };
    },
    [props.scene],
  );

  // Track the element size; fit the map the first time it is known.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const vp = { width: entry.contentRect.width, height: entry.contentRect.height };
      setViewport(vp);
      if (!fitted.current && vp.width > 0) {
        fitted.current = true;
        setCamera(props.initialCamera ?? fitCamera(vp));
      }
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [fitCamera, props.initialCamera]);

  const animateTo = useCallback((target: Camera, duration = 650) => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    const start = cameraRef.current;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      setCamera(interpolate(start, target, t));
      animation.current = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    animation.current = requestAnimationFrame(step);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(id, fill) {
        const index = props.scene.indexOf.get(id) ?? -1;
        const node = props.scene.nodes[index];
        if (!node || viewport.width === 0) return;
        // Areas fill much of the view; a leaf symbol is shown with its neighbourhood around it.
        const leaf = (props.scene.children[index]?.length ?? 0) === 0;
        const r = Math.max(node.r, props.scene.size / 400);
        animateTo(frameCircle(node.x, node.y, r, viewport, fill ?? (leaf ? 0.14 : 0.6)));
      },
      frame(ids) {
        const nodes = ids.flatMap(
          (id) => props.scene.nodes[props.scene.indexOf.get(id) ?? -1] ?? [],
        );
        if (nodes.length === 0 || viewport.width === 0) return;
        const x0 = Math.min(...nodes.map((n) => n.x - n.r));
        const x1 = Math.max(...nodes.map((n) => n.x + n.r));
        const y0 = Math.min(...nodes.map((n) => n.y - n.r));
        const y1 = Math.max(...nodes.map((n) => n.y + n.r));
        const r = Math.max(x1 - x0, y1 - y0, props.scene.size / 200) / 2;
        animateTo(frameCircle((x0 + x1) / 2, (y0 + y1) / 2, r, viewport, 0.8));
      },
      fit: () => animateTo(fitCamera(viewport)),
      zoomBy: (factor) =>
        animateTo(
          zoomAt(cameraRef.current, viewport, viewport.width / 2, viewport.height / 2, factor),
          250,
        ),
      panBy: (dx, dy) => animateTo(pan(cameraRef.current, dx, dy), 200),
      camera: () => cameraRef.current,
    }),
    [props.scene, viewport, animateTo, fitCamera],
  );

  const depth = lodDepth(props.scene, camera.scale);
  const { onRoadsNeeded, roadsFor } = props;
  useEffect(() => {
    if (props.layers.has("roads")) onRoadsNeeded(depth);
  }, [depth, onRoadsNeeded, props.layers]);

  const visible = useMemo(
    () => (viewport.width > 0 ? visibleNodes(props.scene, camera, viewport) : []),
    [props.scene, camera, viewport],
  );
  const maxChurn = useMemo(
    () => Math.max(0, ...props.scene.nodes.map((n) => n.churn ?? 0)),
    [props.scene],
  );

  // Draw whenever anything visible changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw({
      ctx,
      scene: props.scene,
      camera,
      viewport,
      theme: props.theme,
      visible,
      layers: props.layers,
      selected: props.selected,
      hovered: props.hovered,
      highlight: props.highlight,
      roads: roadsFor(depth),
      edges: props.edges,
      maxChurn,
    });
  }, [
    props.scene,
    props.theme,
    props.layers,
    props.selected,
    props.hovered,
    props.highlight,
    props.edges,
    camera,
    viewport,
    visible,
    roadsFor,
    depth,
    maxChurn,
  ]);

  useEffect(() => {
    const id = setTimeout(() => props.onCameraChange?.(camera), 400);
    return () => clearTimeout(id);
  }, [camera, props.onCameraChange]);

  // ---- input ----------------------------------------------------------------------------

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: boolean; startX: number; startY: number } | undefined>(undefined);
  const pinch = useRef<number | undefined>(undefined);

  const local = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [0, 0];
  };

  const stopAnimation = () => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
  };

  const onWheel = (event: React.WheelEvent) => {
    stopAnimation();
    const [sx, sy] = local(event);
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
    setCamera((c) => zoomAt(c, viewport, sx, sy, factor));
  };

  const onPointerDown = (event: React.PointerEvent) => {
    stopAnimation();
    canvasRef.current?.setPointerCapture(event.pointerId);
    const [x, y] = local(event);
    pointers.current.set(event.pointerId, { x, y });
    if (pointers.current.size === 1) drag.current = { moved: false, startX: x, startY: y };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const [x, y] = local(event);
    const previous = pointers.current.get(event.pointerId);
    if (previous) {
      pointers.current.set(event.pointerId, { x, y });
      if (pointers.current.size === 2 && pinch.current !== undefined) {
        const [a, b] = [...pointers.current.values()] as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const factor = distance / pinch.current;
        pinch.current = distance;
        setCamera((c) => zoomAt(c, viewport, (a.x + b.x) / 2, (a.y + b.y) / 2, factor));
        return;
      }
      if (drag.current) {
        if (Math.hypot(x - drag.current.startX, y - drag.current.startY) > 3)
          drag.current.moved = true;
        if (drag.current.moved) setCamera((c) => pan(c, x - previous.x, y - previous.y));
      }
      return;
    }
    const hit = hitTest(props.scene, camera, viewport, x, y);
    const node = hit === undefined ? undefined : props.scene.nodes[hit];
    if (node?.id !== props.hovered) props.onHover(node?.id);
    setTooltip(node && node.kind !== "repo" ? { x, y, node } : undefined);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const wasClick = pointers.current.size === 1 && drag.current && !drag.current.moved;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = undefined;
    if (pointers.current.size === 0) {
      if (wasClick) {
        const [x, y] = local(event);
        const hit = hitTest(props.scene, camera, viewport, x, y);
        const node = hit === undefined ? undefined : props.scene.nodes[hit];
        props.onSelect(node && node.kind !== "repo" ? node.id : undefined);
      }
      drag.current = undefined;
    }
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const [x, y] = local(event);
    animateTo(zoomAt(camera, viewport, x, y, 2.5), 350);
  };

  return (
    <div className="map" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas"
        style={{ width: viewport.width, height: viewport.height }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          setTooltip(undefined);
          props.onHover(undefined);
        }}
        onDoubleClick={onDoubleClick}
        role="img"
        aria-label="Map of the codebase. Use the search box or the side panel to navigate with the keyboard."
      />
      {tooltip && <Tooltip {...tooltip} viewport={viewport} />}
      <div className="map-controls">
        <button
          type="button"
          title="Zoom in (+)"
          onClick={() =>
            animateTo(zoomAt(camera, viewport, viewport.width / 2, viewport.height / 2, 1.8), 250)
          }
        >
          +
        </button>
        <button
          type="button"
          title="Zoom out (−)"
          onClick={() =>
            animateTo(
              zoomAt(camera, viewport, viewport.width / 2, viewport.height / 2, 1 / 1.8),
              250,
            )
          }
        >
          −
        </button>
        <button
          type="button"
          title="Show everything (F)"
          onClick={() => animateTo(fitCamera(viewport))}
        >
          ⤢
        </button>
      </div>
      {viewport.width > 500 && (
        <Minimap
          scene={props.scene}
          theme={props.theme}
          camera={camera}
          viewport={viewport}
          onJump={(x, y) => setCamera((c) => ({ ...c, x, y }))}
        />
      )}
    </div>
  );
});

function Tooltip({
  x,
  y,
  node,
  viewport,
}: {
  x: number;
  y: number;
  node: MapNode;
  viewport: Viewport;
}) {
  const flip = x > viewport.width - 280;
  const facts = [
    kindLabel(node.kind),
    node.lines > 0 ? plural(node.lines, "line") : undefined,
    node.fanIn > 0 ? `${node.fanIn} in` : undefined,
    node.fanOut > 0 ? `${node.fanOut} out` : undefined,
  ].filter(Boolean);
  return (
    <div
      className="tooltip"
      style={{
        left: flip ? undefined : x + 14,
        right: flip ? viewport.width - x + 14 : undefined,
        top: y + 14,
      }}
    >
      <div className="tooltip-title">{node.label}</div>
      <div className="tooltip-meta">{facts.join(" · ")}</div>
      {node.file && node.kind !== "module" && <div className="tooltip-meta">{node.file}</div>}
    </div>
  );
}
