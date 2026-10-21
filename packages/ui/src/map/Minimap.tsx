import { useEffect, useRef } from "react";
import type { Camera, Viewport } from "./camera";
import { containerFill, type Theme } from "./colors";
import type { Scene } from "./scene";

const SIZE = 168;

/** An overview of the whole map with the current view outlined; click or drag to move. */
export function Minimap(props: {
  scene: Scene;
  theme: Theme;
  camera: Camera;
  viewport: Viewport;
  onJump: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { scene, theme, camera, viewport, onJump } = props;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = SIZE / scene.size;
    ctx.clearRect(0, 0, SIZE, SIZE);
    for (const node of scene.nodes) {
      if (node.depth > 2 || node.r * k < 0.7) continue;
      ctx.beginPath();
      ctx.arc(node.x * k, node.y * k, node.r * k, 0, Math.PI * 2);
      ctx.fillStyle = containerFill(theme, node.district, node.depth, node.kind === "module");
      ctx.fill();
    }
    const w = (viewport.width / camera.scale) * k;
    const h = (viewport.height / camera.scale) * k;
    ctx.strokeStyle = theme === "dark" ? "#58a6ff" : "#0969da";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(camera.x * k - w / 2, camera.y * k - h / 2, w, h);
  }, [scene, theme, camera, viewport]);

  const jump = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const k = scene.size / SIZE;
    onJump((event.clientX - rect.left) * k, (event.clientY - rect.top) * k);
  };

  return (
    <canvas
      ref={ref}
      className="minimap"
      style={{ width: SIZE, height: SIZE }}
      aria-label="Overview map"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) jump(e);
      }}
    />
  );
}
