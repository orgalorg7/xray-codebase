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
  /** `vscode://` link to a file position, when the repository is local. */
  editorLink: (file: string, line?: number) => string | undefined;
};

export const Context = createContext<AppContext | undefined>(undefined);

export function useApp(): AppContext {
  const value = useContext(Context);
  if (!value) throw new Error("useApp outside the app");
  return value;
}
