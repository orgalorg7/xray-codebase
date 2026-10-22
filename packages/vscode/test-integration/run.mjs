// Runs the integration suite inside a real VS Code with only this extension enabled, against a
// small workspace made from the golden fixtures. Uses an installed VS Code when found (set
// XRAY_VSCODE_PATH to choose one); otherwise downloads one.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
// XRAY_EXTENSION_PATH tests an unpacked .vsix instead of the development folder.
const extensionPath = process.env.XRAY_EXTENSION_PATH ?? join(here, "..");
const out = join(here, "out");
await build({
  entryPoints: [join(here, "suite", "index.ts")],
  outfile: join(out, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  conditions: ["development"],
  external: ["vscode", "mocha"],
  logLevel: "warning",
});

const workspace = mkdtempSync(join(tmpdir(), "xray-vscode-it-"));
for (const name of ["ts-classes", "py-packages"]) {
  cpSync(join(here, "..", "..", "..", "fixtures", name), join(workspace, name), {
    recursive: true,
  });
}
const installed = [
  "/usr/share/code/code",
  "/usr/bin/code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
];
const vscodeExecutablePath = process.env.XRAY_VSCODE_PATH ?? installed.find((p) => existsSync(p));
try {
  await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: join(out, "index.cjs"),
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "xray-vscode-user-"))}`,
    ],
    extensionTestsEnv: { XRAY_TEST_WORKSPACE: workspace },
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
