/** Where the map is looked at from: the map point at the screen center and the zoom. */
export type Camera = {
  x: number;
  y: number;
  /** Screen pixels per map unit. */
  scale: number;
};

export type Viewport = { width: number; height: number };

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4000;

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export function toScreen(
  camera: Camera,
  viewport: Viewport,
  x: number,
  y: number,
): [number, number] {
  return [
    (x - camera.x) * camera.scale + viewport.width / 2,
    (y - camera.y) * camera.scale + viewport.height / 2,
  ];
}

export function toMap(
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number,
): [number, number] {
  return [
    (sx - viewport.width / 2) / camera.scale + camera.x,
    (sy - viewport.height / 2) / camera.scale + camera.y,
  ];
}

/** A camera showing the circle (x, y, r) so its diameter takes `fill` of the shorter side. */
export function frameCircle(
  x: number,
  y: number,
  r: number,
  viewport: Viewport,
  fill = 0.85,
): Camera {
  const side = Math.max(1, Math.min(viewport.width, viewport.height));
  return { x, y, scale: clampScale((side * fill) / Math.max(r * 2, 1e-6)) };
}

/** Zooms by `factor` keeping the map point under the screen point (sx, sy) in place. */
export function zoomAt(
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number,
  factor: number,
): Camera {
  const scale = clampScale(camera.scale * factor);
  const [mx, my] = toMap(camera, viewport, sx, sy);
  return {
    scale,
    x: mx - (sx - viewport.width / 2) / scale,
    y: my - (sy - viewport.height / 2) / scale,
  };
}

export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale };
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The camera at time t (0..1) of a flight from a to b. Zoom moves in log space and the
 * position follows the zoom, so long flights zoom out, travel, then zoom in, like map apps.
 */
export function interpolate(a: Camera, b: Camera, t: number): Camera {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const e = ease(Math.min(1, Math.max(0, t)));
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const travelScale = Math.min(
    a.scale,
    b.scale,
    distance > 0 ? 800 / distance : Number.POSITIVE_INFINITY,
  );
  const logA = Math.log(a.scale);
  const logB = Math.log(b.scale);
  const logMid = Math.log(Math.max(MIN_SCALE, travelScale));
  // Dip toward the travel zoom in the middle of the flight.
  const dip = Math.sin(Math.PI * e) * Math.max(0, Math.min(logA, logB) - logMid);
  const scale = Math.exp(logA + (logB - logA) * e - dip);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, scale };
}
