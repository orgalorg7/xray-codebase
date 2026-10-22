import { createHash } from "node:crypto";
import { posix, relative, sep } from "node:path";
import * as vscode from "vscode";
import { WorkerClient } from "./client.js";
import type { MapEvent, WorkerEvent } from "./protocol.js";

export type Located = { folder: vscode.WorkspaceFolder; client: WorkerClient; path: string };

/** Keeps one analysis worker per workspace folder, started when first needed. */
export class Workspaces implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #clients = new Map<string, WorkerClient>();
  readonly #listeners = new Set<
    (folder: vscode.WorkspaceFolder, event: WorkerEvent | MapEvent) => void
  >();
  readonly #fatal = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
  }

  onEvent(
    listener: (folder: vscode.WorkspaceFolder, event: WorkerEvent | MapEvent) => void,
  ): vscode.Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  client(folder: vscode.WorkspaceFolder): WorkerClient {
    const key = folder.uri.toString();
    let client = this.#clients.get(key);
    if (client) return client;
    const config = vscode.workspace.getConfiguration("xray", folder);
    // The index lives in VS Code's storage for this workspace, not inside the repository.
    const storage = this.#context.storageUri ?? this.#context.globalStorageUri;
    const slug = createHash("sha1").update(key).digest("hex").slice(0, 12);
    client = new WorkerClient({
      workerPath: this.#context.asAbsolutePath("dist/worker.cjs"),
      root: folder.uri.fsPath,
      indexPath: vscode.Uri.joinPath(storage, `index-${slug}.db`).fsPath,
      watch: config.get<boolean>("watch", true),
      ignore: config.get<string[]>("exclude", []),
      maxMemoryMB: config.get<number>("maxMemoryMB", 0),
    });
    client.onEvent((event) => {
      for (const listener of this.#listeners) listener(folder, event);
    });
    client.onFatal((message) => {
      if (this.#fatal.has(key)) return;
      this.#fatal.add(key);
      void vscode.window.showErrorMessage(`xray: ${message}`);
    });
    this.#clients.set(key, client);
    return client;
  }

  /** The folder, worker and repo-relative path for a file, if it is in an open folder. */
  locate(uri: vscode.Uri): Located | undefined {
    if (uri.scheme !== "file") return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const path = relative(folder.uri.fsPath, uri.fsPath).split(sep).join(posix.sep);
    if (path.startsWith("..")) return undefined;
    return { folder, client: this.client(folder), path };
  }

  /** The folder a command applies to: the given one, the active editor's, or the first. */
  folder(folderUri?: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folderUri) return folders.find((f) => f.uri.toString() === folderUri);
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active && vscode.workspace.getWorkspaceFolder(active)) ?? folders[0];
  }

  /** Stops every worker; they start again with fresh settings on next use. */
  restart(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
    this.#fatal.clear();
  }

  dispose(): void {
    this.restart();
  }
}
