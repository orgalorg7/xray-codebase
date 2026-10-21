import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/dist/index.js";
import { createServer, Workspace } from "../packages/server/dist/index.js";

/**
 * Serves a small repository made of three golden fixtures on port 4499, and writes an HTML
 * export of it, for the end-to-end tests. Requires `pnpm build` first.
 */
export default async function setup() {
  const root = mkdtempSync(join(tmpdir(), "xray-e2e-"));
  for (const name of ["ts-classes", "ts-cycles", "py-packages"]) {
    cpSync(join(import.meta.dirname, "..", "fixtures", name), join(root, name), {
      recursive: true,
    });
  }
  const workspace = new Workspace({ root, git: false });
  await workspace.scan();
  const app = await createServer({
    workspace,
    uiDir: join(import.meta.dirname, "..", "packages", "ui", "dist"),
  });
  await app.listen({ port: 4499, host: "127.0.0.1" });

  const exported = join(root, "map.html");
  const code = await main(
    ["export", "--format", "html", "--output", exported, "--dir", root, "--no-git"],
    {
      cwd: root,
      out: () => {},
      err: () => {},
      color: false,
    },
  );
  if (code !== 0) throw new Error("export failed");
  writeFileSync(join(import.meta.dirname, ".export-path"), exported);

  return async () => {
    await app.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(import.meta.dirname, ".export-path"), { force: true });
  };
}
