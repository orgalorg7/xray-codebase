import type {
  CyclesView,
  DiffView,
  DsmView,
  ImpactView,
  InsightsView,
  MapData,
  Meta,
  NodeDetails,
  RevisionsView,
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
  | { type: "scanned"; files: number; ms: number; changed: number }
  /** The host editor puts the map in a state, given as the map's own URL-hash parameters. */
  | { type: "navigate"; hash: string }
  | { type: "theme"; theme: "light" | "dark" };

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
  /** Opens a file in the host editor, when the map runs inside one. */
  openFile?(file: string, line?: number): void;
  /** The host's theme, when it decides it (an editor), rather than the system. */
  readonly theme?: "light" | "dark";
  /** Where a file can be read online (hosted maps link to GitHub). */
  fileUrl?(file: string, line?: number): string;
  /** Where the mapped code comes from, when it is not a local folder. */
  readonly origin?: { label: string; href: string };
  /** How the architecture changed since a git revision (local repositories only). */
  diff?(base: string): Promise<DiffView>;
  /** Branches and recent commits to compare with. */
  revisions?(): Promise<RevisionsView>;
}

/** Links to files under a URL prefix such as `https://github.com/o/r/blob/<sha>/`. */
const githubFileUrl =
  (base: string) =>
  (file: string, line?: number): string =>
    `${base}${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;

type HttpOptions = {
  /** The API's path, `/api` for `xray open`. */
  api?: string;
  /** Whether the server pushes rescans (`xray open`) or serves a fixed map (hosted). */
  live?: boolean;
  /** URL prefix of the repository's files online; file paths are appended. */
  sourceUrl?: string;
  origin?: { label: string; href: string };
};

class HttpBackend implements Backend {
  readonly live: boolean;
  readonly origin?: { label: string; href: string };
  readonly fileUrl?: (file: string, line?: number) => string;
  readonly diff?: (base: string) => Promise<DiffView>;
  readonly revisions?: () => Promise<RevisionsView>;
  readonly #api: string;

  constructor(options: HttpOptions = {}) {
    this.#api = options.api ?? "/api";
    this.live = options.live ?? true;
    if (options.origin) this.origin = options.origin;
    // A live server maps the repository on this machine, so it can map older revisions too.
    if (this.live) {
      this.diff = (base: string) => this.#get<DiffView>("diff", { base });
      this.revisions = () => this.#get<RevisionsView>("revisions");
    }
    if (options.sourceUrl) this.fileUrl = githubFileUrl(options.sourceUrl);
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
    const response = await fetch(`${this.#api}/${path}${qs ? `?${qs}` : ""}`);
    if (response.status === 404) return undefined as T;
    if (!response.ok) {
      // The server explains errors as { error: "…" }.
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON: show the text as it is.
      }
      throw new Error(message || `${path}: ${response.status}`);
    }
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
    if (!this.live) return () => {};
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const url = new URL(`${this.#api}/events`, window.location.href);
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
  readonly origin?: { label: string; href: string };
  readonly fileUrl?: (file: string, line?: number) => string;
  readonly #service: XrayService;

  constructor(snapshot: Snapshot) {
    this.#service = new XrayService(snapshot);
    // Maps of a GitHub repository at a commit (the hosted site, the gallery) link back to it.
    const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([0-9a-f]{40})$/.exec(
      snapshot.root,
    );
    if (github) {
      const [, repo, sha] = github as unknown as [string, string, string];
      this.origin = { label: `github.com/${repo} @ ${sha.slice(0, 7)}`, href: snapshot.root };
      this.fileUrl = githubFileUrl(`https://github.com/${repo}/blob/${sha}/`);
    }
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

type VsCodeApi = { postMessage(message: unknown): void };
declare global {
  // Defined by VS Code inside webviews.
  var acquireVsCodeApi: (() => VsCodeApi) | undefined;
}

/**
 * Runs inside a VS Code webview: requests go to the extension as messages, which relays them to
 * its xray worker. Follows the editor's theme and opens files in the editor.
 */
class VsCodeBackend implements Backend {
  readonly live = true;
  readonly #api: VsCodeApi;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #listeners = new Set<(event: LiveEvent) => void>();
  #next = 1;

  constructor(api: VsCodeApi) {
    this.#api = api;
    window.addEventListener("message", (message: MessageEvent) => {
      const data = message.data as
        | { type: "response"; id: number; result?: unknown; error?: string }
        | { type: "event"; event: LiveEvent }
        | undefined;
      if (data?.type === "response") {
        const pending = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        if (data.error !== undefined) pending?.reject(new Error(data.error));
        else pending?.resolve(data.result);
      } else if (data?.type === "event") {
        for (const listener of this.#listeners) listener(data.event);
      }
    });
    // VS Code switches theme classes on <body>; follow them.
    new MutationObserver(() => {
      for (const listener of this.#listeners) listener({ type: "theme", theme: this.theme });
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    this.#api.postMessage({ type: "ready" });
  }

  get theme(): "light" | "dark" {
    const classes = document.body.classList;
    return classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")
      ? "dark"
      : "light";
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#api.postMessage({ type: "request", id, method, args });
    });
  }

  meta = () => this.#call<Meta>("meta");
  map = () => this.#call<MapData>("map");
  roads = (depth: number) => this.#call<RoadsView>("roads", depth);
  node = (id: string) => this.#call<NodeDetails | undefined>("node", id);
  source = (file: string, start?: number, end?: number) =>
    this.#call<SourceView | undefined>("source", file, start, end);
  search = (q: string, limit?: number) => this.#call<SearchView>("search", q, limit);
  resolve = (q: string) => this.#call<Summary[]>("resolve", q);
  impact = (r: ImpactRequest) => this.#call<ImpactView>("impact", r);
  trace = (from: string, to: string, k?: number) => this.#call<TraceView>("trace", from, to, k);
  tree = (id: string, direction: "in" | "out", depth?: number) =>
    this.#call<TreeView>("tree", id, direction, depth);
  cycles = (ignoreTypeOnly?: boolean) => this.#call<CyclesView>("cycles", ignoreTypeOnly);
  insights = () => this.#call<InsightsView>("insights");
  dsm = (level: "module" | "directory") => this.#call<DsmView>("dsm", level);
  diff = (base: string) => this.#call<DiffView>("diff", base);
  revisions = () => this.#call<RevisionsView>("revisions");

  openFile(file: string, line?: number): void {
    this.#api.postMessage({ type: "openFile", file, line });
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** ID of the script element that carries an exported snapshot (gzip, base64). */
export const SNAPSHOT_ELEMENT_ID = "xray-snapshot";

async function decodeSnapshot(base64: string): Promise<Snapshot> {
  const bytes = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as Snapshot;
}

/** A `<meta name="…">` value the server put in the page. */
export const pageMeta = (name: string): string | undefined =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;

/**
 * Where the map's data comes from: VS Code, the snapshot embedded in an export, a hosted map
 * (its API named in the page), or the `xray open` server that served the page.
 */
export async function connectBackend(): Promise<Backend> {
  if (typeof globalThis.acquireVsCodeApi === "function")
    return new VsCodeBackend(globalThis.acquireVsCodeApi());
  const embedded = document.getElementById(SNAPSHOT_ELEMENT_ID);
  if (embedded?.textContent) return new LocalBackend(await decodeSnapshot(embedded.textContent));
  const api = pageMeta("xray-api");
  if (api) {
    const repo = pageMeta("xray-repo") ?? "";
    const ref = pageMeta("xray-ref");
    const sourceUrl = pageMeta("xray-source");
    const sha = sourceUrl?.match(/\/blob\/([0-9a-f]{40})\//)?.[1];
    return new HttpBackend({
      api,
      live: false,
      ...(sourceUrl ? { sourceUrl } : {}),
      origin: {
        label: `github.com/${repo}${ref && ref !== sha ? ` · ${ref}` : ""}${sha ? ` @ ${sha.slice(0, 7)}` : ""}`,
        href: `https://github.com/${repo}${sha ? `/tree/${sha}` : ""}`,
      },
    });
  }
  return new HttpBackend();
}
