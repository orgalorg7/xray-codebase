import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CloudConfig = {
  port: number;
  host: string;
  /** The public address, for links in shared previews (`https://xray.example.com`). */
  publicUrl?: string;
  /** Holds the results database and checkouts in progress. */
  dataDir: string;
  /** The built map UI. */
  uiDir: string;
  /** The built analysis worker. */
  workerPath: string;
  /** Read client addresses from X-Forwarded-For (behind a load balancer). */
  trustProxy: boolean;

  /** Clone URL template with `{owner}` and `{repo}`. */
  remote: string;
  /** Protocols git may use. */
  protocols: string;

  /** Maps made at once. */
  concurrency: number;
  /** Jobs that may wait. */
  maxQueued: number;
  /** Unfinished jobs per client. */
  maxPerClient: number;
  jobTimeoutMs: number;
  workerHeapMB: number;
  /** Download limit per repository. */
  maxRepoMB: number;
  /** Source file limit per repository. */
  maxFiles: number;
  /** Commits of history read for churn and co-change (0 = none, fastest). */
  historyDepth: number;
  /** Stored maps beyond this are pruned, least recently viewed first. */
  maxStorageMB: number;
  /** Maps kept loaded in memory. */
  cachedMaps: number;
  /** How long a failed commit fails fast instead of being mapped again. */
  failureCacheMs: number;
  /** How long a branch's commit is reused before asking GitHub again. */
  refCacheMs: number;

  /** New maps per client per hour. */
  submitsPerHour: number;
  /** API requests per client per minute. */
  requestsPerMinute: number;
  /** Repository lookups (each asks GitHub for its branches) per client per minute. */
  lookupsPerMinute: number;
};

const here = fileURLToPath(new URL(".", import.meta.url));

/** The built UI: XRAY_UI_DIR, next to the server (container image), or in the monorepo. */
export function findUiDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.XRAY_UI_DIR, join(here, "ui"), resolve(here, "..", "..", "ui", "dist")];
  const found = candidates.find((dir) => dir && existsSync(join(dir, "index.html")));
  return found ?? resolve(here, "..", "..", "ui", "dist");
}

/** Reads the configuration from `XRAY_*` variables (and `PORT`, `HOST`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const number = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number, not "${value}"`);
    return n;
  };
  const config: CloudConfig = {
    port: number("PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    dataDir: resolve(env.XRAY_DATA_DIR ?? "data"),
    uiDir: findUiDir(env),
    workerPath:
      env.XRAY_WORKER_PATH ?? fileURLToPath(new URL("../dist/analyze.js", import.meta.url)),
    trustProxy: env.XRAY_TRUST_PROXY === "true" || env.XRAY_TRUST_PROXY === "1",
    remote: env.XRAY_GIT_REMOTE ?? "https://github.com/{owner}/{repo}.git",
    protocols: env.XRAY_GIT_PROTOCOLS ?? "https",
    concurrency: Math.max(1, number("XRAY_CONCURRENCY", 2)),
    maxQueued: number("XRAY_MAX_QUEUED", 50),
    maxPerClient: Math.max(1, number("XRAY_MAX_JOBS_PER_CLIENT", 3)),
    jobTimeoutMs: number("XRAY_JOB_TIMEOUT_SECONDS", 600) * 1000,
    workerHeapMB: number("XRAY_WORKER_HEAP_MB", 4096),
    maxRepoMB: number("XRAY_MAX_REPO_MB", 500),
    maxFiles: number("XRAY_MAX_FILES", 25_000),
    historyDepth: number("XRAY_HISTORY_DEPTH", 0),
    maxStorageMB: number("XRAY_MAX_STORAGE_MB", 10_000),
    cachedMaps: Math.max(1, number("XRAY_CACHED_MAPS", 12)),
    failureCacheMs: number("XRAY_FAILURE_CACHE_SECONDS", 600) * 1000,
    refCacheMs: number("XRAY_REF_CACHE_SECONDS", 60) * 1000,
    submitsPerHour: number("XRAY_SUBMITS_PER_HOUR", 30),
    requestsPerMinute: number("XRAY_REQUESTS_PER_MINUTE", 1200),
    lookupsPerMinute: number("XRAY_LOOKUPS_PER_MINUTE", 30),
  };
  if (env.XRAY_PUBLIC_URL) config.publicUrl = env.XRAY_PUBLIC_URL.replace(/\/+$/, "");
  return config;
}
