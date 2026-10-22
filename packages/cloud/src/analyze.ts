import { rmSync } from "node:fs";
import { Workspace } from "@xray/server/workspace";
import { snapshotData } from "@xray/service";
import { checkout } from "./clone.js";
import { githubUrl } from "./github.js";
import { ResultStore } from "./results.js";

/** What one analysis worker does, passed in its environment. */
export type AnalyzeJob = {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  /** The clone URL. */
  remote: string;
  protocols: string;
  /** The results database. */
  dbPath: string;
  /** A fresh directory for the checkout; deleted afterwards. */
  dir: string;
  /** Commits of history to read for churn and co-change (0 = none). */
  historyDepth: number;
  maxBytes: number;
  maxFiles: number;
  cloneTimeoutMs: number;
};

export const ANALYZE_JOB_ENV = "XRAY_ANALYZE_JOB";

export type AnalyzeProgress =
  | { type: "progress"; state: "cloning"; bytes?: number }
  | { type: "progress"; state: "scanning" }
  | { type: "progress"; state: "saving"; files: number };

export type AnalyzeMessage =
  | AnalyzeProgress
  | { type: "done"; files: number; symbols: number; ms: number }
  | { type: "error"; message: string };

/** Clones one commit, maps it and stores the map. Reports progress through `report`. */
export async function analyze(
  job: AnalyzeJob,
  report: (message: AnalyzeProgress) => void,
): Promise<{ files: number; symbols: number; ms: number }> {
  const started = performance.now();
  try {
    report({ type: "progress", state: "cloning" });
    let lastReported = 0;
    await checkout({
      remote: job.remote,
      sha: job.sha,
      dir: job.dir,
      protocols: job.protocols,
      // One extra commit, so the oldest commit read (whose diff would be "everything") is left out.
      depth: job.historyDepth > 0 ? job.historyDepth + 1 : 1,
      maxBytes: job.maxBytes,
      timeoutMs: job.cloneTimeoutMs,
      onProgress: (bytes) => {
        if (bytes - lastReported < 256 * 1024) return;
        lastReported = bytes;
        report({ type: "progress", state: "cloning", bytes });
      },
    });

    report({ type: "progress", state: "scanning" });
    const workspace = new Workspace({
      root: job.dir,
      indexPath: ":memory:",
      git: job.historyDepth > 0,
      gitMaxCommits: job.historyDepth,
      maxFiles: job.maxFiles,
    });
    try {
      const scan = await workspace.scan();
      const service = await workspace.service();
      const meta = service.meta();
      report({ type: "progress", state: "saving", files: scan.files });

      const data = snapshotData(service.snapshot, true);
      data.name = `${job.owner}/${job.repo}`;
      data.root = githubUrl(job.owner, job.repo, job.sha);
      const ms = performance.now() - started;
      const store = ResultStore.open(job.dbPath);
      try {
        store.save({ owner: job.owner, repo: job.repo, sha: job.sha, ref: job.ref, ms }, data, {
          files: meta.stats.files,
          symbols: meta.stats.symbols,
          edges: meta.stats.edges,
          languages: meta.stats.languages,
        });
      } finally {
        store.close();
      }
      return { files: meta.stats.files, symbols: meta.stats.symbols, ms };
    } finally {
      workspace.close();
    }
  } finally {
    rmSync(job.dir, { recursive: true, force: true });
  }
}

// Run as a worker process: the job comes in the environment, messages go to the parent.
if (process.send && process.env[ANALYZE_JOB_ENV]) {
  const job = JSON.parse(process.env[ANALYZE_JOB_ENV] as string) as AnalyzeJob;
  const send = (message: AnalyzeMessage) => process.send?.(message);
  analyze(job, send).then(
    (result) => {
      send({ type: "done", ...result });
      process.disconnect?.();
    },
    (error: unknown) => {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      process.disconnect?.();
    },
  );
}
