import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHtml } from "@xray/cli";
import { checkout, githubUrl, parseRepo, resolveRepo } from "@xray/cloud";
import { Workspace } from "@xray/server/workspace";
import { snapshotData } from "@xray/service";
import { renderIndex, renderNotFound } from "./page.js";

/** A repository in the gallery, optionally at a branch or tag. */
export type RepoEntry = { repo: string; ref?: string };

/** A published map. */
export type MapEntry = {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  files: number;
  symbols: number;
  edges: number;
  languages: Record<string, number>;
  /** Size of the map page in bytes. */
  bytes: number;
  /** Path of the map page within the site. */
  path: string;
  mappedAt: string;
};

export type SiteOptions = {
  repos: RepoEntry[];
  outDir: string;
  /** The built map UI. */
  uiDir: string;
  /** Scratch space for checkouts. */
  workDir: string;
  /** The GitHub repository that publishes the site (`owner/name`), for its links. */
  home?: string;
  /** Clone URL of a repository (GitHub by default). */
  remote?: (owner: string, repo: string) => string;
  protocols?: string;
  /** Download limit per repository. */
  maxBytes?: number;
  maxFiles?: number;
  /** Map pages larger than this are left out (GitHub Pages serves files up to 100 MB). */
  maxPageBytes?: number;
  log?: (line: string) => void;
};

export type SiteResult = { maps: MapEntry[]; failed: { repo: string; error: string }[] };

/** Reads the gallery's list of repositories. */
export function readRepos(path: string): RepoEntry[] {
  const repos = JSON.parse(readFileSync(path, "utf8")) as RepoEntry[];
  if (!Array.isArray(repos)) throw new Error(`${path} must hold a list of repositories`);
  return repos;
}

/**
 * Adds a repository to the gallery's list (given as people paste it: owner/repo or a GitHub
 * link, which may name a branch or tag). `added` is false when it was listed already.
 */
export function addRepo(path: string, input: string): { entry: RepoEntry; added: boolean } {
  const target = parseRepo(input);
  if (!target) throw new Error(`not a GitHub repository: ${input}`);
  const entry: RepoEntry = { repo: `${target.owner}/${target.repo}` };
  if (target.path) entry.ref = target.path.split("/")[0] as string;
  const repos = readRepos(path);
  const listed = repos.find((r) => r.repo.toLowerCase() === entry.repo);
  if (listed) return { entry: listed, added: false };
  repos.push(entry);
  writeFileSync(path, `${JSON.stringify(repos, null, 2)}\n`);
  return { entry, added: true };
}

/**
 * Maps every repository and writes the static site: a start page listing the maps, one
 * self-contained map page per repository (`maps/<owner>/<repo>/`) and `maps.json`. A repository
 * that cannot be mapped is reported and left out; the rest are published.
 */
export async function buildSite(options: SiteOptions): Promise<SiteResult> {
  const log = options.log ?? (() => {});
  const remote =
    options.remote ?? ((owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`);
  const protocols = options.protocols ?? "https";
  const maxPageBytes = options.maxPageBytes ?? 95 * 1024 ** 2;
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });
  const result: SiteResult = { maps: [], failed: [] };

  for (const entry of options.repos) {
    const started = performance.now();
    const target = parseRepo(entry.ref ? `${entry.repo}/tree/${entry.ref}` : entry.repo);
    if (!target) {
      result.failed.push({ repo: entry.repo, error: "not a GitHub repository" });
      continue;
    }
    const name = `${target.owner}/${target.repo}`;
    const dir = join(options.workDir, `${target.owner}-${target.repo}`);
    try {
      const repo = await resolveRepo(target, { remote, protocols });
      rmSync(dir, { recursive: true, force: true });
      await checkout({
        remote: remote(repo.owner, repo.repo),
        sha: repo.sha,
        dir,
        protocols,
        depth: 1,
        maxBytes: options.maxBytes ?? 500 * 1024 ** 2,
        timeoutMs: 5 * 60_000,
      });
      const workspace = new Workspace({
        root: dir,
        indexPath: ":memory:",
        git: false,
        maxFiles: options.maxFiles ?? 25_000,
      });
      let page: string;
      let meta: ReturnType<Awaited<ReturnType<Workspace["service"]>>["meta"]>;
      try {
        const service = await workspace.service();
        meta = service.meta();
        const data = snapshotData(service.snapshot, true);
        data.name = name;
        data.root = githubUrl(repo.owner, repo.repo, repo.sha);
        page = buildHtml(options.uiDir, data);
      } finally {
        workspace.close();
      }
      const bytes = Buffer.byteLength(page);
      if (bytes > maxPageBytes) {
        throw new Error(`the map is ${Math.round(bytes / 1024 ** 2)} MB, over the page limit`);
      }
      const path = `maps/${repo.owner}/${repo.repo}/`;
      mkdirSync(join(options.outDir, path), { recursive: true });
      writeFileSync(join(options.outDir, path, "index.html"), page);
      result.maps.push({
        owner: repo.owner,
        repo: repo.repo,
        sha: repo.sha,
        ref: repo.ref,
        files: meta.stats.files,
        symbols: meta.stats.symbols,
        edges: meta.stats.edges,
        languages: meta.stats.languages,
        bytes,
        path,
        mappedAt: new Date().toISOString(),
      });
      log(
        `mapped ${name} (${meta.stats.files} files, ${(bytes / 1024 ** 2).toFixed(1)} MB) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ repo: name, error: message });
      log(`failed ${name}: ${message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const site = options.home ? { home: options.home } : {};
  writeFileSync(join(options.outDir, "index.html"), renderIndex(result.maps, site));
  writeFileSync(join(options.outDir, "404.html"), renderNotFound(site));
  writeFileSync(join(options.outDir, "maps.json"), `${JSON.stringify(result.maps, null, 2)}\n`);
  // Serve files as they are (no Jekyll processing).
  writeFileSync(join(options.outDir, ".nojekyll"), "");
  return result;
}
