import { useSyncExternalStore } from "react";
import type { Theme } from "./map/colors";

export type Mode = "explore" | "directions" | "impact" | "cycles" | "insights" | "matrix";

export type LayerKey = "roads" | "cycles" | "churn" | "dead" | "coverage" | "districts";

export const LAYERS: { key: LayerKey; label: string; hint: string }[] = [
  { key: "roads", label: "Dependencies", hint: "Roads between areas, bundled by zoom level" },
  {
    key: "districts",
    label: "Districts",
    hint: "Tint areas by the module communities they belong to",
  },
  {
    key: "cycles",
    label: "Import cycles",
    hint: "Outline files that are part of a circular import",
  },
  {
    key: "churn",
    label: "Churn heatmap",
    hint: "Color files by how often git history changed them",
  },
  { key: "dead", label: "Dead code", hint: "Hollow out symbols nothing reachable uses" },
  { key: "coverage", label: "Untested code", hint: "Ring functions no test reaches" },
];

export type AppState = {
  mode: Mode;
  selected?: string | undefined;
  hovered?: string | undefined;
  /** The text in the search box. */
  query: string;
  /** The last submitted feature query (shown as a territory). */
  territory?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  route: number;
  impactTarget?: string | undefined;
  impactDepth?: number | undefined;
  impactHeuristic: boolean;
  cycle?: number | undefined;
  ignoreTypeOnly: boolean;
  matrixLevel: "module" | "directory";
  tree?: { id: string; direction: "in" | "out" } | undefined;
  layers: ReadonlySet<LayerKey>;
  theme: Theme;
  help: boolean;
};

type Listener = () => void;

export class Store {
  #state: AppState;
  readonly #listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.#state = initial;
  }

  get = (): AppState => this.#state;

  set = (patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void => {
    const next = typeof patch === "function" ? patch(this.#state) : patch;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export function useStore<T>(store: Store, select: (state: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

// ---- URL ------------------------------------------------------------------------------

const MODES: Mode[] = ["explore", "directions", "impact", "cycles", "insights", "matrix"];

/** The shareable part of the state, as a URL hash. */
export function toHash(state: AppState): string {
  const params = new URLSearchParams();
  if (state.mode !== "explore") params.set("mode", state.mode);
  if (state.selected) params.set("node", state.selected);
  if (state.territory) params.set("q", state.territory);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.route > 0) params.set("route", String(state.route));
  if (state.impactTarget) params.set("impact", state.impactTarget);
  if (state.impactDepth !== undefined) params.set("depth", String(state.impactDepth));
  if (!state.impactHeuristic) params.set("guesses", "off");
  if (state.cycle !== undefined) params.set("cycle", String(state.cycle));
  if (state.ignoreTypeOnly) params.set("types", "off");
  if (state.matrixLevel !== "module") params.set("level", state.matrixLevel);
  if (state.tree) params.set("tree", `${state.tree.direction}:${state.tree.id}`);
  const layers = [...state.layers].sort().join(",");
  if (layers !== DEFAULT_LAYERS.join(",")) params.set("layers", layers || "none");
  return params.toString();
}

export const DEFAULT_LAYERS: LayerKey[] = ["districts", "roads"];

export function fromHash(hash: string, base: AppState): AppState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const mode = params.get("mode") as Mode | null;
  const number = (key: string): number | undefined => {
    const value = params.get(key);
    return value !== null && Number.isFinite(Number(value)) ? Number(value) : undefined;
  };
  const tree = params.get("tree");
  const layers = params.get("layers");
  const state: AppState = {
    ...base,
    mode: mode && MODES.includes(mode) ? mode : "explore",
    route: number("route") ?? 0,
    impactHeuristic: params.get("guesses") !== "off",
    ignoreTypeOnly: params.get("types") === "off",
    matrixLevel: params.get("level") === "directory" ? "directory" : "module",
    layers: new Set(
      layers === null
        ? DEFAULT_LAYERS
        : layers === "none"
          ? []
          : (layers.split(",").filter((l) => LAYERS.some((x) => x.key === l)) as LayerKey[]),
    ),
  };
  const set = <K extends keyof AppState>(key: K, value: AppState[K] | undefined | null) => {
    if (value !== undefined && value !== null) state[key] = value;
  };
  set("selected", params.get("node"));
  set("territory", params.get("q"));
  if (state.territory) state.query = state.territory;
  set("from", params.get("from"));
  set("to", params.get("to"));
  set("impactTarget", params.get("impact"));
  set("impactDepth", number("depth"));
  set("cycle", number("cycle"));
  if (tree) {
    const [direction, ...rest] = tree.split(":");
    if ((direction === "in" || direction === "out") && rest.length > 0)
      state.tree = { direction, id: rest.join(":") };
  }
  return state;
}

export function initialState(theme: Theme): AppState {
  return {
    mode: "explore",
    query: "",
    route: 0,
    impactHeuristic: true,
    ignoreTypeOnly: false,
    matrixLevel: "module",
    layers: new Set(DEFAULT_LAYERS),
    theme,
    help: false,
  };
}

// ---- preferences (per viewer, best effort) ---------------------------------------------

export function savedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem("xray.theme");
    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem("xray.theme", theme);
  } catch {
    // Storage can be unavailable (private windows); the preference just does not persist.
  }
}
