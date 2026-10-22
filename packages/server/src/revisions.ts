import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RevisionsView, XrayService } from "@xray/service";
import { Workspace } from "./workspace.js";

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** The commit a revision (branch, tag, `HEAD~2`, SHA) names, or an error saying it does not. */
export function commitOf(root: string, revision: string): string {
  if (revision.startsWith("-")) throw new Error(`not a git revision: ${revision}`);
  try {
    return git(root, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`);
  } catch {
    throw new Error(`"${revision}" is not a commit, branch or tag in ${root}`);
  }
}

/**
 * Maps the repository as it was at a revision. The revision is checked out into a temporary
 * worktree, so the working copy (and its index) are untouched; the worktree is removed after.
 */
export async function serviceAt(
  root: string,
  revision: string,
): Promise<{ service: XrayService; commit: string }> {
  const commit = commitOf(root, revision);
  const dir = mkdtempSync(join(tmpdir(), "xray-revision-"));
  const tree = join(dir, "tree");
  try {
    git(root, "worktree", "add", "--detach", "--force", "--quiet", tree, commit);
    const workspace = new Workspace({ root: tree, indexPath: ":memory:", git: false });
    try {
      const { snapshot } = await workspace.service();
      // The worktree goes away: keep the graph, not a way to read its files.
      const { sources: _sources, ...rest } = snapshot;
      return { service: new XrayService({ ...rest, root }), commit };
    } finally {
      workspace.close();
    }
  } finally {
    try {
      git(root, "worktree", "remove", "--force", tree);
    } catch {
      // Already gone; prune below forgets it.
    }
    try {
      git(root, "worktree", "prune");
    } catch {
      // Not fatal: git prunes stale worktrees by itself.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Branches and recent commits of the repository, newest first; empty outside git. */
export function revisionsOf(root: string): RevisionsView {
  try {
    const current = git(root, "rev-parse", "--abbrev-ref", "HEAD");
    const branches = git(
      root,
      "for-each-ref",
      "--sort=-committerdate",
      "--count=30",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    )
      .split("\n")
      .filter((b) => b && !b.endsWith("/HEAD"));
    const commits = git(root, "log", "-n", "20", "--format=%H%x1f%s%x1f%cI")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", subject = "", date = ""] = line.split("\u001f");
        return { sha, subject, date };
      });
    return { current, branches, commits };
  } catch {
    return { current: "", branches: [], commits: [] };
  }
}
