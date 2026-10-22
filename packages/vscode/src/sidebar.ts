import type { CyclesView, InsightsView, Meta, Summary } from "@xray/service";
import * as vscode from "vscode";
import type { Workspaces } from "./workspaces.js";

type Item =
  | { kind: "status"; label: string; description?: string; tooltip?: string; icon: string }
  | {
      kind: "group";
      id: "cycles" | "hotspots" | "state" | "dead";
      label: string;
      count: number;
      icon: string;
    }
  | { kind: "cycle"; index: number; members: Summary[] }
  | { kind: "node"; node: Summary; description?: string };

/**
 * The xray sidebar: what the map knows at a glance (import cycles, hotspot files, possibly dead
 * code), each entry opening its file.
 */
export class InsightsTree implements vscode.TreeDataProvider<Item> {
  readonly #workspaces: Workspaces;
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  #cache: Promise<{ meta: Meta; insights: InsightsView; cycles: CyclesView } | string> | undefined;

  constructor(workspaces: Workspaces) {
    this.#workspaces = workspaces;
  }

  refresh(): void {
    this.#cache = undefined;
    this.#changed.fire();
  }

  #load() {
    this.#cache ??= (async () => {
      const folder = this.#workspaces.folder();
      if (!folder) return "Open a folder to map it.";
      const client = this.#workspaces.client(folder);
      try {
        const [meta, insights, cycles] = await Promise.all([
          client.request<Meta>("meta"),
          client.request<InsightsView>("insights"),
          client.request<CyclesView>("cycles", false),
        ]);
        return { meta, insights, cycles };
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    return this.#cache;
  }

  async getChildren(item?: Item): Promise<Item[]> {
    const data = await this.#load();
    if (typeof data === "string")
      return item ? [] : [{ kind: "status", label: data, icon: "warning" }];
    if (!item) {
      const { stats } = data.meta;
      return [
        {
          kind: "status",
          label: `${stats.files.toLocaleString()} files`,
          description: `${stats.symbols.toLocaleString()} symbols · ${stats.edges.toLocaleString()} links`,
          tooltip: `Scanned ${new Date(data.meta.scannedAt).toLocaleString()}`,
          icon: "type-hierarchy",
        },
        {
          kind: "group",
          id: "cycles",
          label: "Import cycles",
          count: data.cycles.imports.length,
          icon: "sync",
        },
        {
          kind: "group",
          id: "hotspots",
          label: "Hotspot files",
          count: data.insights.hotspots.modules.length,
          icon: "flame",
        },
        {
          kind: "group",
          id: "state",
          label: "Shared mutable state",
          count: data.insights.state.length,
          icon: "database",
        },
        {
          kind: "group",
          id: "dead",
          label: "Possibly dead code",
          count: data.insights.deadCode.length,
          icon: "circle-slash",
        },
      ];
    }
    if (item.kind === "group") {
      if (item.id === "cycles")
        return data.cycles.imports.map((c, index) => ({
          kind: "cycle",
          index,
          members: c.members,
        }));
      if (item.id === "hotspots") {
        return data.insights.hotspots.modules.map((m) => ({
          kind: "node",
          node: m.node,
          description: `${m.lines.toLocaleString()} lines · ${m.fanIn} in`,
        }));
      }
      if (item.id === "state") {
        return data.insights.state.map((v) => ({
          kind: "node",
          node: v.node,
          description: `${v.writers.length} writing · ${v.readers.length} reading`,
        }));
      }
      return data.insights.deadCode.map((d) => ({
        kind: "node",
        node: d,
        description: `${d.lines} lines`,
      }));
    }
    if (item.kind === "cycle") return item.members.map((node) => ({ kind: "node", node }));
    return [];
  }

  getTreeItem(item: Item): vscode.TreeItem {
    const folder = this.#workspaces.folder();
    switch (item.kind) {
      case "status": {
        const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        if (item.description) tree.description = item.description;
        if (item.tooltip) tree.tooltip = item.tooltip;
        tree.iconPath = new vscode.ThemeIcon(item.icon);
        tree.command = { command: "xray.openMap", title: "Open Map" };
        return tree;
      }
      case "group": {
        const tree = new vscode.TreeItem(
          item.label,
          item.count > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        tree.description = String(item.count);
        tree.iconPath = new vscode.ThemeIcon(item.icon);
        return tree;
      }
      case "cycle": {
        const tree = new vscode.TreeItem(
          item.members.map((m) => m.label.split("/").at(-1)).join(" → "),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        tree.description = `${item.members.length} files`;
        tree.iconPath = new vscode.ThemeIcon(
          "sync",
          new vscode.ThemeColor("problemsErrorIcon.foreground"),
        );
        tree.contextValue = "cycle";
        return tree;
      }
      case "node": {
        const tree = new vscode.TreeItem(item.node.label, vscode.TreeItemCollapsibleState.None);
        if (item.description) tree.description = item.description;
        tree.tooltip = item.node.file
          ? `${item.node.file}${item.node.line ? `:${item.node.line}` : ""}`
          : item.node.id;
        tree.iconPath = vscode.ThemeIcon.File;
        if (folder && item.node.file) {
          const uri = vscode.Uri.joinPath(folder.uri, item.node.file);
          tree.resourceUri = uri;
          const line = Math.max(0, (item.node.line ?? 1) - 1);
          tree.command = {
            command: "vscode.open",
            title: "Open",
            arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }],
          };
        }
        return tree;
      }
    }
  }
}
