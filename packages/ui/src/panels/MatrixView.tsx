import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNote, Loading, useAsync } from "../components/common";
import { useApp } from "../context";
import { palette } from "../map/draw";
import { useStore } from "../state";

const LABEL_WIDTH = 220;

/**
 * Dependency structure matrix: row i depends on column j. Items are ordered by district, so
 * well-layered code is mostly on one side of the diagonal; mirrored cells (red) are cycles.
 */
export function MatrixView() {
  const { backend, store, theme, open } = useApp();
  const level = useStore(store, (s) => s.matrixLevel);
  const dsm = useAsync(() => backend.dsm(level), [backend, level]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<
    { i: number; j: number; count: number; x: number; y: number } | undefined
  >();
  const items = dsm.data?.items ?? [];
  const n = items.length;
  const cell = Math.max(3, Math.min(18, Math.floor((width - LABEL_WIDTH - 20) / Math.max(1, n))));
  const counts = useMemo(
    () => new Map((dsm.data?.cells ?? []).map(([i, j, c]) => [i * 100000 + j, c])),
    [dsm.data],
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !dsm.data) return;
    const colors = palette(theme);
    const dpr = window.devicePixelRatio || 1;
    const w = LABEL_WIDTH + n * cell + 2;
    const h = n * cell + 2;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    const max = Math.max(1, ...dsm.data.cells.map(([, , c]) => c));
    // Grid and diagonal.
    ctx.strokeStyle = theme === "dark" ? "#21262d" : "#e6e9ed";
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, i * cell + 0.5);
      ctx.lineTo(LABEL_WIDTH + n * cell, i * cell + 0.5);
      ctx.moveTo(LABEL_WIDTH + i * cell + 0.5, 0);
      ctx.lineTo(LABEL_WIDTH + i * cell + 0.5, n * cell);
      ctx.stroke();
    }
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = theme === "dark" ? "#30363d" : "#d0d7de";
      ctx.fillRect(LABEL_WIDTH + i * cell, i * cell, cell, cell);
    }
    for (const [i, j, c] of dsm.data.cells) {
      const mutual = counts.has(j * 100000 + i);
      const t = Math.log1p(c) / Math.log1p(max);
      ctx.fillStyle = mutual
        ? `rgba(224, 49, 49, ${0.35 + t * 0.65})`
        : theme === "dark"
          ? `rgba(88, 166, 255, ${0.25 + t * 0.75})`
          : `rgba(9, 105, 218, ${0.2 + t * 0.8})`;
      ctx.fillRect(LABEL_WIDTH + j * cell + 1, i * cell + 1, cell - 1, cell - 1);
    }
    if (cell >= 9) {
      ctx.font = `${Math.min(12, cell - 2)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillStyle = colors.muted;
      items.forEach((item, i) => {
        let label = item.label;
        while (label.length > 4 && ctx.measureText(label).width > LABEL_WIDTH - 10)
          label = `…${label.slice(2)}`;
        ctx.fillText(label, LABEL_WIDTH - 6, i * cell + cell / 2);
      });
    }
  }, [dsm.data, theme, cell, n, items, counts]);

  const at = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const i = Math.floor(y / cell);
    const j = Math.floor((x - LABEL_WIDTH) / cell);
    return { i, j, x, y };
  };

  return (
    <div className="matrix" ref={wrapRef}>
      <div className="matrix-head">
        <h2>Dependency matrix</h2>
        <p className="muted">
          Row depends on column. Blue cells are dependencies; red cells depend on each other (a
          cycle). Grouped by district.
        </p>
        <div className="segmented">
          {(["module", "directory"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={level === l}
              className={level === l ? "active" : ""}
              onClick={() => store.set({ matrixLevel: l })}
            >
              {l === "module" ? "Files" : "Directories"}
            </button>
          ))}
        </div>
      </div>
      {dsm.loading && <Loading />}
      {dsm.error && <ErrorNote error={dsm.error} />}
      {dsm.data && n === 0 && (
        <p className="muted">
          No dependencies between {level === "module" ? "files" : "directories"}.
        </p>
      )}
      {dsm.data && n > 0 && (
        <div className="matrix-scroll">
          <canvas
            ref={canvasRef}
            onMouseMove={(e) => {
              const { i, j, x, y } = at(e);
              if (i < 0 || j < 0 || i >= n || j >= n) return setHover(undefined);
              setHover({ i, j, count: counts.get(i * 100000 + j) ?? 0, x, y });
            }}
            onMouseLeave={() => setHover(undefined)}
            onClick={(e) => {
              const { i } = at(e);
              const target = items[i];
              if (target) open(target.id);
            }}
            aria-label="Dependency structure matrix"
          />
          {hover && (
            <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <div className="tooltip-title">{items[hover.i]?.label}</div>
              <div className="tooltip-meta">
                {hover.count > 0
                  ? `uses ${items[hover.j]?.label} (${hover.count}×)`
                  : `does not use ${items[hover.j]?.label}`}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
