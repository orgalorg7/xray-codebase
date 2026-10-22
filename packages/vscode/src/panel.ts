import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import type { WorkerClient } from "./client.js";
import type { MapEvent, WebviewMessage } from "./protocol.js";

/** Where to take the map: a node (in explore or blast-radius mode), a view, or a search. */
export type Navigation = { node?: string; mode?: "explore" | "impact" | "cycles"; search?: string };

/** The map's URL-hash parameters for a navigation (the same ones shared links use). */
export function navigationHash(navigation: Navigation): string {
  const params = new URLSearchParams();
  if (navigation.mode === "impact" && navigation.node) {
    params.set("mode", "impact");
    params.set("impact", navigation.node);
  } else if (navigation.mode === "cycles") params.set("mode", "cycles");
  if (navigation.node) params.set("node", navigation.node);
  if (navigation.search) params.set("q", navigation.search);
  return params.toString();
}

/**
 * The map in an editor tab: the same UI as `xray open`, talking to the worker through webview
 * messages instead of HTTP. One panel per workspace folder.
 */
export class MapPanel {
  readonly #panel: vscode.WebviewPanel;
  readonly #client: WorkerClient;
  readonly #folder: vscode.WorkspaceFolder;
  readonly #disposables: vscode.Disposable[] = [];
  #ready = false;
  #queued: MapEvent[] = [];
  /** Requests the map made: proof (for diagnostics and tests) that its page really runs. */
  #requests: string[] = [];

  static #panels = new Map<string, MapPanel>();

  /** Shows the folder's map (creating it if needed), optionally on a node. */
  static show(
    extensionUri: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    client: WorkerClient,
    navigation?: Navigation,
  ): MapPanel {
    const existing = MapPanel.#panels.get(folder.uri.toString());
    if (existing) {
      existing.#panel.reveal(undefined, false);
      if (navigation) existing.navigate(navigation);
      return existing;
    }
    const panel = new MapPanel(extensionUri, folder, client, navigation);
    MapPanel.#panels.set(folder.uri.toString(), panel);
    return panel;
  }

  /** What the folder's map has done so far, if it is open. */
  static state(folderUri: string): { ready: boolean; requests: string[] } | undefined {
    const panel = MapPanel.#panels.get(folderUri);
    return panel && { ready: panel.#ready, requests: [...panel.#requests] };
  }

  static disposeAll(): void {
    for (const panel of MapPanel.#panels.values()) panel.#panel.dispose();
  }

  private constructor(
    extensionUri: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    client: WorkerClient,
    navigation?: Navigation,
  ) {
    this.#client = client;
    this.#folder = folder;
    const uiRoot = vscode.Uri.joinPath(extensionUri, "media", "ui");
    this.#panel = vscode.window.createWebviewPanel(
      "xray.map",
      `xray: ${folder.name}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [uiRoot] },
    );
    this.#panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    this.#panel.webview.html = renderHtml(this.#panel.webview, uiRoot, navigation);

    this.#disposables.push(
      this.#panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.#receive(message)),
      { dispose: client.onEvent((event) => this.#post({ type: "event", event })) },
    );
    this.#panel.onDidDispose(() => {
      MapPanel.#panels.delete(folder.uri.toString());
      for (const d of this.#disposables) d.dispose();
    });
  }

  /** Takes the open map to a node, view or search. */
  navigate(navigation: Navigation): void {
    const event: MapEvent = { type: "navigate", hash: navigationHash(navigation) };
    if (this.#ready) this.#post({ type: "event", event });
    else this.#queued.push(event);
  }

  #post(message: unknown): void {
    void this.#panel.webview.postMessage(message);
  }

  async #receive(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.#ready = true;
        for (const event of this.#queued.splice(0)) this.#post({ type: "event", event });
        return;
      case "request":
        this.#requests.push(message.method);
        try {
          const result = await this.#client.request(message.method, ...message.args);
          this.#post({ type: "response", id: message.id, result });
        } catch (error) {
          this.#post({
            type: "response",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      case "openFile": {
        const uri = vscode.Uri.joinPath(this.#folder.uri, message.file);
        const line = Math.max(0, (message.line ?? 1) - 1);
        const position = new vscode.Position(line, 0);
        // Open beside the map so it stays visible.
        const column =
          this.#panel.viewColumn === vscode.ViewColumn.One
            ? vscode.ViewColumn.Two
            : vscode.ViewColumn.One;
        await vscode.window.showTextDocument(uri, {
          viewColumn: column,
          selection: new vscode.Range(position, position),
        });
        return;
      }
    }
  }
}

/**
 * The built UI's index.html, with asset URLs mapped into the webview, a strict content security
 * policy, and the initial node (if any) put in the URL hash before the app starts.
 */
function renderHtml(webview: vscode.Webview, uiRoot: vscode.Uri, navigation?: Navigation): string {
  const nonce = randomBytes(16).toString("base64");
  let html = readFileSync(vscode.Uri.joinPath(uiRoot, "index.html").fsPath, "utf8");
  const base = webview.asWebviewUri(uiRoot).toString();
  html = html
    .replaceAll('src="./assets/', `src="${base}/assets/`)
    .replaceAll('href="./assets/', `href="${base}/assets/`)
    .replaceAll(" crossorigin", "")
    .replace('<script type="module"', `<script nonce="${nonce}" type="module"`);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const hash = navigation ? navigationHash(navigation) : "";
  const boot = hash
    ? `<script nonce="${nonce}">history.replaceState(null, "", "#${hash}");</script>`
    : "";
  return html.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    ${boot}`,
  );
}
