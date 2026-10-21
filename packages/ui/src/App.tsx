import type { Road } from "@xray/analysis";
import type { MapData, Meta } from "@xray/service";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "./backend";
import { ErrorNote, Loading } from "./components/common";
import { Help } from "./components/Help";
import { SearchBox } from "./components/SearchBox";
import { type AppContext, Context, type Overlay, useApp } from "./context";
import { kindLabel, plural, timeAgo } from "./format";
import type { Camera } from "./map/camera";
import { kindColor, type Theme } from "./map/colors";
import { type MapHandle, MapView } from "./map/MapView";
import { buildScene, type Scene } from "./map/scene";
import { CyclesPanel } from "./panels/CyclesPanel";
import { DirectionsPanel } from "./panels/DirectionsPanel";
import { ImpactPanel } from "./panels/ImpactPanel";
import { InsightsPanel } from "./panels/InsightsPanel";
import { MatrixView } from "./panels/MatrixView";
import { NodePanel } from "./panels/NodePanel";
import { Overview } from "./panels/Overview";
import { TerritoryPanel } from "./panels/TerritoryPanel";
import { TreePanel } from "./panels/TreePanel";
import {
  type AppState,
  fromHash,
  initialState,
  LAYERS,
  type Mode,
  Store,
  savedTheme,
  saveTheme,
  toHash,
  useStore,
} from "./state";

const MODES: { mode: Mode; label: string; key: string }[] = [
  { mode: "explore", label: "Explore", key: "e" },
  { mode: "directions", label: "Directions", key: "r" },
  { mode: "impact", label: "Blast radius", key: "i" },
  { mode: "cycles", label: "Cycles", key: "c" },
  { mode: "insights", label: "Insights", key: "n" },
  { mode: "matrix", label: "Matrix", key: "m" },
];

const LEGEND_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "variable",
  "route",
  "component",
  "test",
] as const;

function cameraFromHash(hash: string): Camera | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("cam");
  const [x, y, scale] = (value ?? "").split(",").map(Number);
  return value && [x, y, scale].every((n) => Number.isFinite(n))
    ? { x: x as number, y: y as number, scale: scale as number }
    : undefined;
}

type Loaded = { meta: Meta; map: MapData; scene: Scene };

export function App({ backend }: { backend: Backend }) {
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const store = useMemo(
    () =>
      new Store(
        fromHash(location.hash, initialState(savedTheme() ?? (prefersDark ? "dark" : "light"))),
      ),
    [prefersDark],
  );
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const [meta, map] = await Promise.all([backend.meta(), backend.map()]);
      setLoaded({ meta, map, scene: buildScene(map) });
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [backend]);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates from `xray open --watch` or a manual rescan.
  useEffect(
    () =>
      backend.subscribe((event) => {
        if (event.type === "scanning") setScanning(true);
        else {
          setScanning(false);
          if (event.changed > 0) {
            setNotice(`Updated: ${plural(event.changed, "file")} changed (${event.ms} ms)`);
            load();
          }
        }
      }),
    [backend, load],
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (error) {
    return (
      <div className="boot">
        <h1>xray could not load the map</h1>
        <ErrorNote error={error} />
        <button type="button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="boot">
        <Loading label="Mapping the codebase" />
      </div>
    );
  }
  return (
    <Shell backend={backend} store={store} loaded={loaded} scanning={scanning} notice={notice} />
  );
}

function Shell({
  backend,
  store,
  loaded,
  scanning,
  notice,
}: {
  backend: Backend;
  store: Store;
  loaded: Loaded;
  scanning: boolean;
  notice: string | undefined;
}) {
  const { meta, map, scene } = loaded;
  const mapRef = useRef<MapHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<Camera | undefined>(cameraFromHash(location.hash));
  const state = useStore(store, (s) => s);
  const [overlay, setOverlay] = useState<Overlay | undefined>();
  const [roads, setRoads] = useState<Map<number, Road[]>>(new Map());
  const pending = useRef(new Set<number>());
  const [layersOpen, setLayersOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  // Keep the URL in sync: selections are history entries, everything else replaces.
  const lastSelected = useRef(state.selected);
  useEffect(() => {
    const cam = cameraRef.current;
    const hash = `${toHash(state)}${cam ? `${toHash(state) ? "&" : ""}cam=${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.scale.toPrecision(4)}` : ""}`;
    const url = `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
    if (state.selected !== lastSelected.current && state.selected) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    lastSelected.current = state.selected;
  }, [state]);

  useEffect(() => {
    const onPop = () => {
      const previous = store.get().selected;
      store.set(fromHash(location.hash, store.get()));
      const next = store.get().selected;
      // Back/forward and edited links move the map to the selection, like a fresh load.
      if (next && next !== previous) mapRef.current?.flyTo(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [store]);

  // New data (rescan) invalidates the cached roads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the map changes
  useEffect(() => {
    setRoads(new Map());
    pending.current.clear();
  }, [map]);

  const onRoadsNeeded = useCallback(
    (depth: number) => {
      if (roads.has(depth) || pending.current.has(depth)) return;
      pending.current.add(depth);
      backend.roads(depth).then((view) => setRoads((r) => new Map(r).set(depth, view.roads)));
    },
    [backend, roads],
  );
  const roadsFor = useCallback((depth: number) => roads.get(depth), [roads]);

  const open = useCallback(
    (id: string) => {
      store.set((s) => ({
        selected: id,
        tree: undefined,
        mode: s.mode === "matrix" || s.mode === "explore" ? s.mode : "explore",
      }));
      mapRef.current?.flyTo(id);
    },
    [store],
  );
  const frame = useCallback((ids: string[]) => mapRef.current?.frame(ids), []);
  // Saved only when chosen, so viewers who never toggle keep following their system setting.
  const toggleTheme = useCallback(
    (current: Theme) => {
      const theme = current === "dark" ? "light" : "dark";
      saveTheme(theme);
      store.set({ theme });
    },
    [store],
  );

  const context: AppContext = useMemo(
    () => ({
      backend,
      store,
      meta,
      map,
      scene,
      theme: state.theme,
      open,
      frame,
      setOverlay,
      editorLink: (file, line) =>
        backend.live && meta.root.startsWith("/")
          ? `vscode://file${meta.root}/${file}${line ? `:${line}` : ""}`
          : undefined,
    }),
    [backend, store, meta, map, scene, state.theme, open, frame],
  );

  // Fly to the node in the URL on first load.
  const initialSelection = useRef(state.selected);
  useEffect(() => {
    const id = initialSelection.current;
    if (id && !cameraRef.current) setTimeout(() => mapRef.current?.flyTo(id), 50);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = store.get();
      // An open dialog handles its own keys (Escape closes it natively).
      if (s.help) return;
      const modeKey = MODES.find(
        (m) => m.key === e.key.toLowerCase() && e.key.toLowerCase() !== "i",
      );
      if (e.key === "Escape")
        store.set(
          s.tree
            ? { tree: undefined }
            : s.selected
              ? { selected: undefined }
              : { territory: undefined, query: "", mode: "explore" },
        );
      else if (e.key === "?") store.set({ help: true });
      else if (e.key === "f") mapRef.current?.fit();
      else if (e.key === "+" || e.key === "=") mapRef.current?.zoomBy(1.6);
      else if (e.key === "-") mapRef.current?.zoomBy(1 / 1.6);
      else if (e.key === "ArrowLeft") mapRef.current?.panBy(120, 0);
      else if (e.key === "ArrowRight") mapRef.current?.panBy(-120, 0);
      else if (e.key === "ArrowUp") mapRef.current?.panBy(0, 120);
      else if (e.key === "ArrowDown") mapRef.current?.panBy(0, -120);
      else if (e.key === "t") toggleTheme(s.theme);
      else if (e.key === "u" && s.selected) {
        const parent = scene.nodes[scene.indexOf.get(s.selected) ?? -1]?.parent;
        if (parent && parent !== "repo:") open(parent);
      } else if (e.key === "i")
        store.set(s.selected ? { mode: "impact", impactTarget: s.selected } : { mode: "impact" });
      else if (e.key === "d")
        store.set(
          s.selected ? { mode: "directions", from: s.selected, route: 0 } : { mode: "directions" },
        );
      else if (modeKey) store.set({ mode: modeKey.mode });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, scene, open, toggleTheme]);

  return (
    <Context.Provider value={context}>
      <div className="app">
        <header className="topbar">
          <div className="brand" title={meta.root}>
            <span className="logo" aria-hidden="true" />
            <span className="brand-name">{meta.name}</span>
          </div>
          <SearchBox ref={searchRef} />
          <nav className="modes" aria-label="Views">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={state.mode === m.mode ? "mode active" : "mode"}
                aria-current={state.mode === m.mode ? "page" : undefined}
                onClick={() => store.set({ mode: m.mode, tree: undefined })}
                title={`${m.label} (${m.key.toUpperCase()})`}
              >
                {m.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="icon-button"
            onClick={() => toggleTheme(state.theme)}
            title="Theme (T)"
            aria-label="Toggle theme"
          >
            {state.theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => store.set({ help: true })}
            title="Help (?)"
            aria-label="Help"
          >
            ?
          </button>
        </header>

        <main className="workspace">
          <section className="stage">
            {state.mode === "matrix" ? (
              <MatrixView />
            ) : (
              <>
                <MapView
                  ref={mapRef}
                  scene={scene}
                  theme={state.theme}
                  layers={state.layers}
                  selected={state.selected}
                  hovered={state.hovered}
                  highlight={overlay?.highlight}
                  edges={overlay?.edges}
                  roadsFor={roadsFor}
                  onRoadsNeeded={onRoadsNeeded}
                  onSelect={(id) => store.set({ selected: id, tree: undefined })}
                  onHover={(id) => store.set({ hovered: id })}
                  initialCamera={cameraRef.current}
                  onCameraChange={(c) => {
                    cameraRef.current = c;
                    store.set({});
                  }}
                />
                <div className="layers">
                  <button
                    type="button"
                    className="layers-toggle"
                    aria-expanded={layersOpen}
                    onClick={() => setLayersOpen(!layersOpen)}
                  >
                    Layers ▾
                  </button>
                  {layersOpen && (
                    <div className="layers-menu">
                      {LAYERS.map((layer) => (
                        <label key={layer.key} title={layer.hint}>
                          <input
                            type="checkbox"
                            checked={state.layers.has(layer.key)}
                            disabled={layer.key === "churn" && !meta.hasGit}
                            onChange={(e) => {
                              const next = new Set(state.layers);
                              if (e.target.checked) next.add(layer.key);
                              else next.delete(layer.key);
                              store.set({ layers: next });
                            }}
                          />
                          {layer.label}
                          {layer.key === "churn" && !meta.hasGit && (
                            <span className="muted"> (no git history)</span>
                          )}
                        </label>
                      ))}
                      <div className="legend">
                        {LEGEND_KINDS.map((k) => (
                          <span key={k}>
                            <span
                              className="swatch round"
                              style={{ background: kindColor(k, state.theme as Theme) }}
                            />
                            {kindLabel(k)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
          <aside className="panel" aria-label="Details">
            <SidePanel state={state} />
          </aside>
        </main>

        <footer className="statusbar">
          <span>
            {plural(meta.stats.files, "file")} · {plural(meta.stats.symbols, "symbol")} ·{" "}
            {plural(meta.stats.edges, "link")}
          </span>
          <span>{scanning ? "Rescanning…" : `scanned ${timeAgo(meta.scannedAt)}`}</span>
          <span className={backend.live ? "live" : "snapshot"}>
            {backend.live ? "● live" : "snapshot"}
          </span>
        </footer>
        {notice && (
          <div className="toast" role="status">
            {notice}
          </div>
        )}
        {state.help && <Help onClose={() => store.set({ help: false })} />}
      </div>
    </Context.Provider>
  );
}

function SidePanel({ state }: { state: AppState }) {
  const { store } = useApp();
  switch (state.mode) {
    case "directions":
      return <DirectionsPanel />;
    case "impact":
      return <ImpactPanel />;
    case "cycles":
      return <CyclesPanel />;
    case "insights":
      return <InsightsPanel />;
    default:
      if (state.tree)
        return (
          <TreePanel
            key={`${state.tree.direction}:${state.tree.id}`}
            id={state.tree.id}
            direction={state.tree.direction}
          />
        );
      if (state.selected) {
        return (
          <>
            {state.territory && (
              <button
                type="button"
                className="back-link"
                onClick={() => store.set({ selected: undefined })}
              >
                ← Results for “{state.territory}”
              </button>
            )}
            <NodePanel key={state.selected} id={state.selected} />
          </>
        );
      }
      if (state.territory) return <TerritoryPanel key={state.territory} query={state.territory} />;
      return <Overview />;
  }
}
