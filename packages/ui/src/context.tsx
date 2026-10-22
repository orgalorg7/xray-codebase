import type { MapData, Meta } from "@xray/service";
import { createContext, useContext } from "react";
import type { Backend } from "./backend";
import type { Theme } from "./map/colors";
import type { EdgeLine, Highlight } from "./map/draw";
import type { Scene } from "./map/scene";
import type { Store } from "./state";

/** What a panel shows on the map besides the base layers. */
export type Overlay = { highlight?: Highlight; edges?: EdgeLine[] };

export type AppContext = {
  backend: Backend;
  store: Store;
  meta: Meta;
  map: MapData;
  scene: Scene;
  theme: Theme;
  /** Selects a node and flies the map to it. */
  open: (id: string) => void;
  /** Frames several nodes on the map. */
  frame: (ids: string[]) => void;
  /** Replaces the map overlay (pass undefined to clear). */
  setOverlay: (overlay: Overlay | undefined) => void;
  /** Link to a file position: GitHub for hosted maps, `vscode://` for local repositories. */
  editorLink: (file: string, line?: number) => string | undefined;
  /** What following `editorLink` does ("Open in editor", "View on GitHub"). */
  editorLabel: string;
  /** Opens a file in the host editor (inside VS Code); preferred over `editorLink`. */
  openInEditor?: (file: string, line?: number) => void;
};

export const Context = createContext<AppContext | undefined>(undefined);

export function useApp(): AppContext {
  const value = useContext(Context);
  if (!value) throw new Error("useApp outside the app");
  return value;
}
