import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "@xray/testkit";

const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=xray",
      "-c",
      "user.email=xray@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/**
 * Local stand-ins for GitHub repositories, served over `file://` at `<root>/<owner>/<repo>`.
 * Use `remote` as the clone URL template and `"file"` as the protocol.
 */
export class Remotes {
  readonly root = mkdtempSync(join(tmpdir(), "xray-remotes-"));
  readonly remote = `file://${this.root}/{owner}/{repo}`;

  /** A repository with the fixture's files committed on `main`; returns the commit. */
  create(owner: string, repo: string, fixture: string): string {
    const dir = join(this.root, owner, repo);
    mkdirSync(dir, { recursive: true });
    cpSync(loadFixture(fixture).dir, dir, { recursive: true });
    rmSync(join(dir, "expected.json"), { force: true });
    run(dir, "init", "--quiet");
    // GitHub serves any commit by SHA; a local repository must be told to.
    run(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    run(dir, "add", ".");
    run(dir, "commit", "--quiet", "-m", "initial");
    return run(dir, "rev-parse", "HEAD");
  }

  /** Commits a file change (or a symbolic link) on the current branch; returns the commit. */
  commit(owner: string, repo: string, files: Record<string, string | { link: string }>): string {
    const dir = join(this.root, owner, repo);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      if (typeof content === "string") writeFileSync(join(dir, path), content);
      else symlinkSync(content.link, join(dir, path));
    }
    run(dir, "add", ".");
    run(dir, "commit", "--quiet", "-m", `change ${Object.keys(files).join(", ")}`);
    return run(dir, "rev-parse", "HEAD");
  }

  git(owner: string, repo: string, ...args: string[]): string {
    return run(join(this.root, owner, repo), ...args);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
