import type { FileSymbol, NodeDetails, Summary } from "@xray/service";
import * as vscode from "vscode";
import type { Workspaces } from "./workspaces.js";

export const SELECTOR: vscode.DocumentSelector = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
].map((language) => ({ language, scheme: "file" }));

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 callers · 5 dependents" and "blast radius" above functions, methods and classes. */
export class XrayCodeLensProvider implements vscode.CodeLensProvider {
  readonly #workspaces: Workspaces;
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.#changed.event;

  constructor(workspaces: Workspaces) {
    this.#workspaces = workspaces;
  }

  /** Asks VS Code to ask again, after a rescan. */
  refresh(): void {
    this.#changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration("xray").get<boolean>("codeLens.enabled", true))
      return [];
    const target = this.#workspaces.locate(document.uri);
    // Line numbers come from the last scan; an unsaved document may have moved them.
    if (!target || document.isDirty) return [];
    let symbols: FileSymbol[];
    try {
      symbols = await target.client.request<FileSymbol[]>("fileSymbols", target.path);
    } catch {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const symbol of symbols) {
      const line = symbol.line - 1;
      if (line < 0 || line >= document.lineCount) continue;
      const range = document.lineAt(line).range;
      const usage =
        symbol.dependents === 0
          ? "no known callers"
          : symbol.callers === symbol.dependents
            ? plural(symbol.callers, "caller")
            : `${plural(symbol.callers, "caller")} · ${plural(symbol.dependents, "dependent")}`;
      lenses.push(
        new vscode.CodeLens(range, {
          title: usage,
          tooltip: "Show what calls and depends on this",
          command: "xray.showCallers",
          arguments: [target.folder.uri.toString(), symbol.id],
        }),
        new vscode.CodeLens(range, {
          title: "blast radius",
          tooltip: "Show everything a change here could affect, on the xray map",
          command: "xray.blastRadius",
          arguments: [symbol.id, target.folder.uri.toString()],
        }),
      );
    }
    return lenses;
  }
}

/**
 * Adds xray's view to hovers: on a declaration name, its usage; on a call, the callee's.
 * Elsewhere it stays silent so the language's own hover is not cluttered.
 */
export class XrayHoverProvider implements vscode.HoverProvider {
  readonly #workspaces: Workspaces;

  constructor(workspaces: Workspaces) {
    this.#workspaces = workspaces;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    if (!vscode.workspace.getConfiguration("xray").get<boolean>("hover.enabled", true))
      return undefined;
    const target = this.#workspaces.locate(document.uri);
    const word = document.getWordRangeAtPosition(position);
    if (!target || !word || document.isDirty) return undefined;
    try {
      const owner = await target.client.request<Summary | undefined>(
        "symbolAt",
        target.path,
        position.line + 1,
      );
      if (!owner) return undefined;
      const details = await target.client.request<NodeDetails | undefined>("node", owner.id);
      if (!details) return undefined;
      // Hovering the declaration's own name.
      const ownLocation = details.node.location;
      if (
        ownLocation &&
        ownLocation.line === position.line + 1 &&
        document.getText(word) === details.node.name
      ) {
        return new vscode.Hover(card(details, target.folder.uri.toString()), word);
      }
      // Hovering a call or use inside it: find the edge that starts at this word.
      const edge = details.outgoing.find(
        (e) =>
          e.location &&
          e.location.line === position.line + 1 &&
          (e.kind === "calls" || e.kind === "instantiates" || e.kind === "references") &&
          document.getText(word) === e.other.name,
      );
      if (!edge) return undefined;
      const callee = await target.client.request<NodeDetails | undefined>("node", edge.other.id);
      return callee
        ? new vscode.Hover(card(callee, target.folder.uri.toString(), edge.confidence), word)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function card(details: NodeDetails, folder: string, confidence?: string): vscode.MarkdownString {
  const node = details.node;
  const callers = details.incoming.filter(
    (e) => e.kind === "calls" || e.kind === "instantiates" || e.kind === "handles",
  );
  const distinctCallers = [...new Map(callers.map((e) => [e.other.id, e.other])).values()];
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ["xray.revealInMap", "xray.blastRadius", "xray.showCallers"] };
  const args = (value: unknown[]) => encodeURIComponent(JSON.stringify(value));
  md.appendMarkdown(`**xray** · ${node.kind} \`${node.qualifiedName}\``);
  if (confidence === "inferred") md.appendMarkdown(" · _link inferred from types_");
  if (confidence === "heuristic") md.appendMarkdown(" · _link guessed by name_");
  md.appendMarkdown("\n\n");
  md.appendMarkdown(
    `${plural(distinctCallers.length, "caller")} · ${plural(details.metrics.fanIn, "dependent")} · depends on ${details.metrics.fanOut}`,
  );
  if (details.metrics.rank !== undefined)
    md.appendMarkdown(` · centrality #${details.metrics.rank}`);
  md.appendMarkdown("\n\n");
  for (const caller of distinctCallers.slice(0, 5)) {
    md.appendMarkdown(
      `- called by \`${caller.label}\`${caller.file ? ` _(${caller.file}:${caller.line ?? 1})_` : ""}\n`,
    );
  }
  if (distinctCallers.length > 5) md.appendMarkdown(`- …and ${distinctCallers.length - 5} more\n`);
  md.appendMarkdown(
    `\n[$(type-hierarchy) Show in map](command:xray.revealInMap?${args([node.id, folder])}) · ` +
      `[$(flame) Blast radius](command:xray.blastRadius?${args([node.id, folder])})`,
  );
  return md;
}
