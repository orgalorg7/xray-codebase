import { GitError, git } from "./git.js";

/** A repository on GitHub and, optionally, what to map in it. */
export type RepoTarget = {
  owner: string;
  repo: string;
  /**
   * The path after `tree/` or `blob/` in a GitHub URL: a branch or tag, possibly followed by a
   * directory (`main/src/app`), or a commit SHA.
   */
  path?: string;
  /** A full commit SHA, from `commit/<sha>` or a SHA in the path. */
  sha?: string;
};

/** A repository pinned to one commit. */
export type ResolvedRepo = {
  owner: string;
  repo: string;
  sha: string;
  /** The branch or tag the commit was found through, or the SHA itself. */
  ref: string;
};

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
// Refs never start with "-" (so they cannot be read as options) and never contain "..".
const REF_PATH = /^(?!-)(?!.*\.\.)[\w.\-/]{1,250}$/;

export const isSha = (value: string): boolean => SHA.test(value);

/**
 * Reads a GitHub repository from what people paste: `owner/repo`, `github.com/owner/repo`, full
 * URLs (with `.git`, `tree/<ref>`, `blob/<ref>/file` or `commit/<sha>`) and SSH remotes. Owner
 * and repository names are lowercased, as GitHub treats them case-insensitively.
 */
export function parseRepo(input: string): RepoTarget | undefined {
  let text = input.trim().replace(/[?#].*$/, "");
  text = text.replace(/^git@github\.com:/i, "github.com/");
  text = text.replace(/^(?:https?|git|ssh):\/\/(?:git@)?/i, "");
  text = text.replace(/^www\./i, "");
  if (/^github\.com\//i.test(text)) text = text.slice("github.com/".length);
  else if (/^[^/]*\.[^/]*\//.test(text) || text.includes(":")) return undefined; // another host

  const [owner = "", rawRepo = "", kind, ...rest] = text.split("/").filter(Boolean);
  const repo = rawRepo.replace(/\.git$/i, "");
  const target: RepoTarget = { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  if (!OWNER.test(target.owner) || !REPO.test(target.repo) || /^\.+$/.test(target.repo))
    return undefined;

  if (kind === "commit" && rest[0] && isSha(rest[0].toLowerCase())) {
    target.sha = rest[0].toLowerCase();
  } else if ((kind === "tree" || kind === "blob") && rest.length > 0) {
    const path = rest.join("/");
    if (!REF_PATH.test(path)) return undefined;
    if (isSha(rest[0]?.toLowerCase() ?? "")) target.sha = (rest[0] as string).toLowerCase();
    else target.path = path;
  }
  return target;
}

/** The canonical GitHub URL of a repository, at a commit when given. */
export const githubUrl = (owner: string, repo: string, sha?: string): string =>
  `https://github.com/${owner}/${repo}${sha ? `/tree/${sha}` : ""}`;

export type ResolveOptions = {
  /** The clone URL of a repository. */
  remote: (owner: string, repo: string) => string;
  protocols: string;
  timeoutMs?: number;
};

export class NotFoundError extends Error {}

/**
 * Pins a target to a commit with `git ls-remote` (no API token or rate limit): the default branch,
 * or the longest branch or tag that the URL path starts with.
 */
export async function resolveRepo(
  target: RepoTarget,
  options: ResolveOptions,
): Promise<ResolvedRepo> {
  const { owner, repo } = target;
  if (target.sha) return { owner, repo, sha: target.sha, ref: target.sha };
  const remote = options.remote(owner, repo);
  const run = (args: string[]) =>
    git(["ls-remote", ...args, "--", remote, ...(target.path ? [] : ["HEAD"])], {
      protocols: options.protocols,
      timeoutMs: options.timeoutMs ?? 30_000,
    }).catch((error: Error) => {
      // GitHub asks for credentials for repositories that are missing or private.
      const stderr = error instanceof GitError ? error.stderr : error.message;
      throw /not found|could not read|terminal prompts disabled|does not appear|authentication/i.test(
        stderr,
      )
        ? new NotFoundError(`github.com/${owner}/${repo} was not found, or it is private`)
        : error;
    });

  if (!target.path) {
    const output = await run(["--symref"]);
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(output)?.[1];
    const sha = /^([0-9a-f]{40})\tHEAD$/m.exec(output)?.[1];
    if (!sha) throw new NotFoundError(`github.com/${owner}/${repo} has no commits`);
    return { owner, repo, sha, ref: branch ?? "HEAD" };
  }

  // Branch and tag names may contain slashes, so match the longest one the path starts with.
  const refs = new Map<string, string>();
  for (const line of (await run(["--heads", "--tags"])).split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/(?:heads|tags)\/(.+?)(\^\{\})?$/.exec(line);
    if (!match) continue;
    const [, sha, name, peeled] = match as unknown as [string, string, string, string?];
    // Annotated tags list the tag object, then the commit it points to (`^{}`): keep the commit.
    if (peeled || !refs.has(name)) refs.set(name, sha);
  }
  const segments = (target.path as string).split("/");
  for (let n = segments.length; n > 0; n--) {
    const name = segments.slice(0, n).join("/");
    const sha = refs.get(name);
    if (sha) return { owner, repo, sha, ref: name };
  }
  throw new NotFoundError(`github.com/${owner}/${repo} has no branch or tag "${segments[0]}"`);
}
