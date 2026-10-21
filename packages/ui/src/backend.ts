import type {
  CyclesView,
  DsmView,
  ImpactView,
  InsightsView,
  MapData,
  Meta,
  NodeDetails,
  RoadsView,
  SearchView,
  Snapshot,
  SourceView,
  Summary,
  TraceView,
  TreeView,
} from "@xray/service";
import { XrayService } from "@xray/service";

export type ImpactRequest = { ids: string[]; depth?: number; heuristic?: boolean };

export type LiveEvent =
  | { type: "scanning" }
  | { type: "scanned"; files: number; ms: number; changed: number };

/** Where the map's data comes from: a live `xray open` server or a snapshot in the page. */
export interface Backend {
  readonly live: boolean;
  meta(): Promise<Meta>;
  map(): Promise<MapData>;
  roads(depth: number): Promise<RoadsView>;
  node(id: string): Promise<NodeDetails | undefined>;
  source(file: string, start?: number, end?: number): Promise<SourceView | undefined>;
  search(query: string, limit?: number): Promise<SearchView>;
  resolve(reference: string): Promise<Summary[]>;
  impact(request: ImpactRequest): Promise<ImpactView>;
  trace(from: string, to: string, k?: number): Promise<TraceView>;
  tree(id: string, direction: "in" | "out", depth?: number): Promise<TreeView>;
  cycles(ignoreTypeOnly?: boolean): Promise<CyclesView>;
  insights(): Promise<InsightsView>;
  dsm(level: "module" | "directory"): Promise<DsmView>;
  /** Live servers push rescans; returns an unsubscribe function. */
  subscribe(listener: (event: LiveEvent) => void): () => void;
}

class HttpBackend implements Backend {
  readonly live = true;
  readonly #base: string;

  constructor(base = "") {
    this.#base = base;
  }

  async #get<T>(
    path: string,
    params: Record<string, string | number | boolean | string[] | undefined> = {},
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) query.append(key, String(v));
    }
    const qs = query.toString();
    const response = await fetch(`${this.#base}/api/${path}${qs ? `?${qs}` : ""}`);
    if (response.status === 404) return undefined as T;
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  meta = () => this.#get<Meta>("meta");
  map = () => this.#get<MapData>("map");
  roads = (depth: number) => this.#get<RoadsView>("roads", { depth });
  node = (id: string) => this.#get<NodeDetails | undefined>("node", { id });
  source = (file: string, start?: number, end?: number) =>
    this.#get<SourceView | undefined>("source", { file, start, end });
  search = (q: string, limit?: number) => this.#get<SearchView>("search", { q, limit });
  resolve = (q: string) => this.#get<Summary[]>("resolve", { q });
  impact = (r: ImpactRequest) =>
    this.#get<ImpactView>("impact", { id: r.ids, depth: r.depth, heuristic: r.heuristic });
  trace = (from: string, to: string, k?: number) => this.#get<TraceView>("trace", { from, to, k });
  tree = (id: string, direction: "in" | "out", depth?: number) =>
    this.#get<TreeView>("tree", { id, direction, depth });
  cycles = (ignoreTypeOnly?: boolean) => this.#get<CyclesView>("cycles", { ignoreTypeOnly });
  insights = () => this.#get<InsightsView>("insights");
  dsm = (level: "module" | "directory") => this.#get<DsmView>("dsm", { level });

  subscribe(listener: (event: LiveEvent) => void): () => void {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const url = new URL(`${this.#base}/api/events`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (message) => listener(JSON.parse(String(message.data)) as LiveEvent);
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }
}

/** Runs the service in the page over an embedded snapshot: the self-contained HTML export. */
class LocalBackend implements Backend {
  readonly live = false;
  readonly #service: XrayService;

  constructor(snapshot: Snapshot) {
    this.#service = new XrayService(snapshot);
  }

  meta = async () => this.#service.meta();
  map = async () => this.#service.map();
  roads = async (depth: number) => this.#service.roads(depth);
  node = async (id: string) => this.#service.node(id);
  source = async (file: string, start?: number, end?: number) =>
    this.#service.source(file, start, end);
  search = async (q: string, limit?: number) => this.#service.search(q, limit);
  resolve = async (q: string) => this.#service.resolve(q);
  impact = async (r: ImpactRequest) =>
    this.#service.impact(r.ids, {
      ...(r.depth === undefined ? {} : { maxDepth: r.depth }),
      ...(r.heuristic === undefined ? {} : { includeHeuristic: r.heuristic }),
    });
  trace = async (from: string, to: string, k?: number) =>
    this.#service.trace(from, to, k === undefined ? {} : { k });
  tree = async (id: string, direction: "in" | "out", depth?: number) =>
    this.#service.tree(id, direction, depth);
  cycles = async (ignoreTypeOnly?: boolean) =>
    this.#service.cycles({ ignoreTypeOnly: ignoreTypeOnly ?? false });
  insights = async () => this.#service.insights();
  dsm = async (level: "module" | "directory") => this.#service.dsm(level);
  subscribe = () => () => {};
}

/** ID of the script element that carries an exported snapshot (gzip, base64). */
export const SNAPSHOT_ELEMENT_ID = "xray-snapshot";

async function decodeSnapshot(base64: string): Promise<Snapshot> {
  const bytes = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as Snapshot;
}

/** The embedded snapshot when the page is an export, else the server that served the page. */
export async function connectBackend(): Promise<Backend> {
  const embedded = document.getElementById(SNAPSHOT_ELEMENT_ID);
  if (embedded?.textContent) return new LocalBackend(await decodeSnapshot(embedded.textContent));
  return new HttpBackend();
}
