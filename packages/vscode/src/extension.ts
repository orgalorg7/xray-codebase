import type { NodeDetails, Summary } from "@xray/service";
import * as vscode from "vscode";
import { MapPanel, type Navigation } from "./panel.js";
import { SELECTOR, XrayCodeLensProvider, XrayHoverProvider } from "./providers.js";
import { InsightsTree } from "./sidebar.js";
import { Workspaces } from "./workspaces.js";

/** What tests (and other extensions) can reach. */
export type XrayApi = {
  workspaces: Workspaces;
  codeLens: XrayCodeLensProvider;
  insights: InsightsTree;
  /** What a folder's open map has done (whether its page started, which requests it made). */
  mapState: (folderUri: string) => { ready: boolean; requests: string[] } | undefined;
};

export function activate(context: vscode.ExtensionContext): XrayApi {
  const workspaces = new Workspaces(context);
  const codeLens = new XrayCodeLensProvider(workspaces);
  const insights = new InsightsTree(workspaces);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = "xray";
  status.command = "xray.openMap";
  context.subscriptions.push(workspaces, status);

  const showStatus = (text: string, tooltip: string) => {
    status.text = text;
    status.tooltip = tooltip;
    status.show();
  };
  showStatus("$(sync~spin) xray", "xray is mapping this workspace");

  // Keep the status bar, CodeLens and sidebar in step with the worker's scans.
  context.subscriptions.push(
    workspaces.onEvent((folder, event) => {
      if (event.type === "scanning") showStatus("$(sync~spin) xray", `Rescanning ${folder.name}…`);
      else if (event.type === "scanned") {
        showStatus(
          "$(type-hierarchy) xray",
          `${folder.name}: ${event.files.toLocaleString()} files mapped (${event.ms} ms). Click to open the map.`,
        );
        if (event.changed > 0) {
          codeLens.refresh();
          insights.refresh();
        }
      } else if (event.type === "error") showStatus("$(warning) xray", event.message);
    }),
  );

  /** The node under the cursor in the active editor. */
  const symbolAtCursor = async (): Promise<
    { folder: vscode.WorkspaceFolder; node: Summary } | undefined
  > => {
    const editor = vscode.window.activeTextEditor;
    const located = editor && workspaces.locate(editor.document.uri);
    if (!editor || !located) {
      void vscode.window.showInformationMessage(
        "xray: open a source file (TypeScript, JavaScript, Python, Go, Java, Kotlin, Rust, C#, PHP or Ruby) in this workspace first.",
      );
      return undefined;
    }
    const node = await located.client.request<Summary | undefined>(
      "symbolAt",
      located.path,
      editor.selection.active.line + 1,
    );
    if (!node) {
      void vscode.window.showInformationMessage(
        "xray: no mapped code at the cursor. Save the file and try again.",
      );
      return undefined;
    }
    return { folder: located.folder, node };
  };

  const showMap = (folderUri: string | undefined, navigation?: Navigation) => {
    const folder = workspaces.folder(folderUri);
    if (!folder) {
      void vscode.window.showInformationMessage("xray: open a folder to map it.");
      return;
    }
    MapPanel.show(context.extensionUri, folder, workspaces.client(folder), navigation);
  };

  /** Commands take (nodeId, folderUri) from CodeLens and hovers, or use the cursor. */
  const onNode = (mode: "explore" | "impact") => async (id?: string, folderUri?: string) => {
    if (id) return showMap(folderUri, { node: id, mode });
    const found = await symbolAtCursor();
    if (found) showMap(found.folder.uri.toString(), { node: found.node.id, mode });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("xray.openMap", (folderUri?: string) => showMap(folderUri)),
    vscode.commands.registerCommand("xray.revealInMap", onNode("explore")),
    vscode.commands.registerCommand("xray.blastRadius", onNode("impact")),
    vscode.commands.registerCommand("xray.showCycles", () =>
      showMap(undefined, { mode: "cycles" }),
    ),
    vscode.commands.registerCommand("xray.findFeature", async () => {
      const query = await vscode.window.showInputBox({
        title: "xray: Find where a feature lives",
        prompt: "Describe it in plain words, for example “where is login handled” or “send email”",
        placeHolder: "checkout payment",
      });
      if (query?.trim()) showMap(undefined, { search: query.trim() });
    }),
    vscode.commands.registerCommand("xray.rescan", async () => {
      const folder = workspaces.folder();
      if (!folder) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `xray: rescanning ${folder.name}`,
        },
        async () => {
          const result = await workspaces
            .client(folder)
            .request<{ files: number; ms: number }>("scan", true);
          void vscode.window.showInformationMessage(
            `xray: mapped ${result.files.toLocaleString()} files in ${result.ms} ms.`,
          );
        },
      );
      codeLens.refresh();
      insights.refresh();
    }),
    vscode.commands.registerCommand("xray.showCallers", async (folderUri: string, id: string) => {
      const folder = workspaces.folder(folderUri);
      if (!folder) return;
      const details = await workspaces.client(folder).request<NodeDetails | undefined>("node", id);
      const loc = details?.node.location;
      if (!details || !loc) return;
      // Every call site and use, in VS Code's own peek view.
      const locations = details.incoming
        .filter((e) => e.location)
        .map((e) => {
          const l = e.location as NonNullable<typeof e.location>;
          return new vscode.Location(
            vscode.Uri.joinPath(folder.uri, l.file),
            new vscode.Range(
              l.line - 1,
              l.column - 1,
              (l.endLine ?? l.line) - 1,
              (l.endColumn ?? l.column) - 1,
            ),
          );
        });
      if (locations.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          `xray: nothing in the workspace is known to use ${details.node.qualifiedName}.`,
          "Show in Map",
        );
        if (choice) showMap(folderUri, { node: id, mode: "explore" });
        return;
      }
      await vscode.commands.executeCommand(
        "editor.action.showReferences",
        vscode.Uri.joinPath(folder.uri, loc.file),
        new vscode.Position(loc.line - 1, loc.column - 1),
        locations,
      );
    }),
    vscode.languages.registerCodeLensProvider(SELECTOR, codeLens),
    vscode.languages.registerHoverProvider(SELECTOR, new XrayHoverProvider(workspaces)),
    vscode.window.registerTreeDataProvider("xray.insights", insights),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("xray.watch") ||
        event.affectsConfiguration("xray.exclude") ||
        event.affectsConfiguration("xray.maxMemoryMB")
      ) {
        workspaces.restart();
        insights.refresh();
      }
      if (event.affectsConfiguration("xray.codeLens")) codeLens.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(() => codeLens.refresh()),
    { dispose: () => MapPanel.disposeAll() },
  );

  // Start mapping the active folder in the background, so the first lens or map is quick.
  const first = workspaces.folder();
  if (first) {
    workspaces
      .client(first)
      .request<Summary>("meta")
      .then(
        () => {
          showStatus("$(type-hierarchy) xray", `${first.name} is mapped. Click to open the map.`);
          codeLens.refresh();
          insights.refresh();
        },
        (error: unknown) =>
          showStatus("$(warning) xray", error instanceof Error ? error.message : String(error)),
      );
  } else status.hide();

  return { workspaces, codeLens, insights, mapState: (folderUri) => MapPanel.state(folderUri) };
}

export function deactivate(): void {
  MapPanel.disposeAll();
}
