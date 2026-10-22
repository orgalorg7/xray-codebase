import { strict as assert } from "node:assert";
import { join } from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";
import type { XrayApi } from "../../src/extension.js";

/** Entry point VS Code calls: runs the suite with mocha inside the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 120_000, color: true });
  mocha.suite.emit("pre-require", globalThis, "suite", mocha);
  defineSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} tests failed`)) : resolve(),
    );
  });
}

const until = async <T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  ms = 60_000,
): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function defineSuite(): void {
  const root = process.env.XRAY_TEST_WORKSPACE as string;
  const file = (path: string) => vscode.Uri.file(join(root, path));
  let api: XrayApi;
  let folder: vscode.WorkspaceFolder;

  describe("xray in VS Code", () => {
    before(async () => {
      const extension = vscode.extensions.getExtension<XrayApi>("xray-codebase.xray-vscode");
      assert.ok(extension, "extension is installed");
      api = await extension.activate();
      folder = vscode.workspace.workspaceFolders?.[0] as vscode.WorkspaceFolder;
      assert.ok(folder, "a workspace folder is open");
    });

    it("maps the workspace in its worker", async () => {
      const meta = await api.workspaces
        .client(folder)
        .request<{ stats: { files: number; languages: object } }>("meta");
      assert.equal(meta.stats.files, 10);
      assert.deepEqual(Object.keys(meta.stats.languages).sort(), ["py", "ts"]);
    });

    it("shows callers and blast radius above declarations", async () => {
      const uri = file("ts-classes/src/user-repo.ts");
      await vscode.window.showTextDocument(uri);
      const lenses = await until(async () => {
        const result = await vscode.commands.executeCommand<vscode.CodeLens[]>(
          "vscode.executeCodeLensProvider",
          uri,
        );
        return result?.some((l) => l.command?.title === "blast radius") ? result : undefined;
      }, "code lenses");
      const titles = lenses.map((l) => `${l.range.start.line + 1}: ${l.command?.title}`);
      assert.ok(titles.includes("6: 1 caller"), titles.join("\n"));
      assert.ok(titles.includes("10: no known callers"), titles.join("\n"));
    });

    it("adds xray to hovers on declarations and calls", async () => {
      const declaration = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        file("ts-classes/src/user-repo.ts"),
        new vscode.Position(5, 3), // `find` in `find(id: string)`
      );
      const text = (hovers: vscode.Hover[]) =>
        hovers
          .flatMap((h) =>
            h.contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : "")),
          )
          .join("\n");
      assert.match(text(declaration), /\*\*xray\*\* · method `UserRepo.find`/);
      assert.match(text(declaration), /called by `AdminRepo.find`/);

      const call = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        file("py-packages/app/main.py"),
        new vscode.Position(6, 12), // `create_user` in `user = create_user("ada")`
      );
      assert.match(text(call), /function `create_user`/);
    });

    it("opens the map, and the map loads its data", async () => {
      await vscode.commands.executeCommand("xray.openMap");
      const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
      await until(
        () => labels().includes(`xray: ${folder.name}`),
        `the map tab (tabs: ${labels().join(", ")})`,
        10_000,
      ).catch((error: Error) => {
        throw new Error(
          `${error.message}; tabs now: ${labels().join(", ")}; folder: ${folder.name}`,
        );
      });
      const state = await until(() => {
        const s = api.mapState(folder.uri.toString());
        return s?.ready && s.requests.includes("map") ? s : undefined;
      }, "the map page to start and request its data");
      assert.ok(state.requests.includes("meta"));
    });

    it("reveals symbols in the same map tab", async () => {
      await vscode.commands.executeCommand(
        "xray.revealInMap",
        "ts:ts-classes/src/service.ts#lookup",
        folder.uri.toString(),
      );
      await vscode.commands.executeCommand(
        "xray.blastRadius",
        "ts:ts-classes/src/service.ts#lookup",
        folder.uri.toString(),
      );
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.label === `xray: ${folder.name}`);
      assert.equal(tabs.length, 1);
      await until(
        () => api.mapState(folder.uri.toString())?.requests.includes("impact"),
        "the map to compute the blast radius",
      );
    });

    it("reveals the symbol under the cursor", async () => {
      const editor = await vscode.window.showTextDocument(file("ts-classes/src/admin-repo.ts"));
      editor.selection = new vscode.Selection(6, 10, 6, 10);
      await vscode.commands.executeCommand("xray.revealInMap");
      await until(
        () => api.mapState(folder.uri.toString())?.requests.includes("resolve"),
        "the map to resolve the revealed node",
      );
    });

    it("lists insights in the sidebar", async () => {
      const top = await api.insights.getChildren();
      const labels = top.map((item) => api.insights.getTreeItem(item).label);
      assert.ok(labels.includes("Import cycles"), String(labels));
      assert.ok(labels.includes("10 files"), String(labels));
    });

    it("shows callers in the peek view", async () => {
      await vscode.commands.executeCommand(
        "xray.showCallers",
        folder.uri.toString(),
        "ts:ts-classes/src/service.ts#lookup",
      );
    });
  });
}
