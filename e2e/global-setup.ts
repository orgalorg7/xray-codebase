import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/dist/index.js";
import { createCloud, loadConfig } from "../packages/cloud/dist/index.js";
import { createServer, Workspace } from "../packages/server/dist/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

/** Git repositories standing in for GitHub ones, served to the hosted xray over file://. */
function createRemotes(root: string): void {
  for (const [owner, repo, fixture] of [
    ["acme", "shop", "ts-classes"],
    ["acme", "tools", "py-packages"],
  ] as const) {
    const dir = join(root, owner, repo);
    mkdirSync(dir, { recursive: true });
    cpSync(join(fixtures, fixture), dir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=xray", "-c", "user.email=xray@example.com", ...args], {
        cwd: dir,
        stdio: "ignore",
      });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "uploadpack.allowAnySHA1InWant", "true");
    git("add", ".");
    git("commit", "--quiet", "-m", "initial");
  }
}

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
  // Two commits, the second adding the Python package: the Changes view compares them.
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=xray", "-c", "user.email=xray@example.com", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "--quiet", "--initial-branch=main");
  git("add", "ts-classes", "ts-cycles");
  git("commit", "--quiet", "-m", "typescript");
  git("add", "py-packages");
  git("commit", "--quiet", "-m", "python");
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

  // The hosted xray on port 4498, mapping the local stand-ins for GitHub repositories.
  const remotes = join(root, "remotes");
  createRemotes(remotes);
  const cloud = await createCloud({
    ...loadConfig({}),
    dataDir: join(root, "cloud"),
    uiDir: join(import.meta.dirname, "..", "packages", "ui", "dist"),
    remote: `file://${remotes}/{owner}/{repo}`,
    protocols: "file",
    refCacheMs: 0,
  });
  await cloud.app.listen({ port: 4498, host: "127.0.0.1" });

  return async () => {
    await cloud.close();
    await app.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(import.meta.dirname, ".export-path"), { force: true });
  };
}
