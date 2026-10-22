import type { SnapshotData } from "@xray/service";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedRepo } from "../src/github.js";
import { JobQueue, type JobStatus, QueueError, type Runner } from "../src/jobs.js";
import { RateLimiter } from "../src/limits.js";
import { ResultStore } from "../src/results.js";

const repo = (name: string, sha = "a".repeat(40)): ResolvedRepo => ({
  owner: "acme",
  repo: name,
  sha,
  ref: "main",
});

const snapshot = (files: string[]): SnapshotData => ({
  name: "acme/shop",
  root: "https://github.com/acme/shop",
  scannedAt: "2026-10-22T00:00:00.000Z",
  graph: {
    version: 1,
    root: "/repo",
    nodes: files.map((file) => ({
      id: `ts:${file}`,
      kind: "module",
      name: file,
      qualifiedName: file,
      language: "ts",
    })),
    edges: [],
  } as unknown as SnapshotData["graph"],
  sources: Object.fromEntries(files.map((file) => [file, `// ${file}\n`.repeat(200)])),
});

const stats = { files: 2, symbols: 5, edges: 3, languages: { ts: 2 } };

describe("ResultStore", () => {
  it("stores maps with lazily read sources, lists and prunes them", () => {
    const store = ResultStore.open(":memory:");
    const a = { owner: "acme", repo: "shop", sha: "a".repeat(40), ref: "main", ms: 1200 };
    const saved = store.save(a, snapshot(["src/a.ts", "src/b.ts"]), stats);
    expect(saved).toMatchObject({ owner: "acme", repo: "shop", ref: "main", files: 2, views: 0 });
    expect(saved.bytes).toBeGreaterThan(0);

    const loaded = store.snapshot(a);
    expect(loaded?.name).toBe("acme/shop");
    expect(loaded?.graph.nodes).toHaveLength(2);
    const sources = loaded?.sources as (path: string) => string | undefined;
    expect(sources("src/a.ts")).toContain("// src/a.ts");
    expect(sources("src/missing.ts")).toBeUndefined();
    expect(store.snapshot({ ...a, sha: "b".repeat(40) })).toBeUndefined();

    // A newer commit of the same repository replaces it in the recent list.
    vi.useFakeTimers({ now: Date.now() + 1000 });
    const b = { ...a, sha: "b".repeat(40) };
    store.save(b, snapshot(["src/a.ts"]), stats);
    vi.useFakeTimers({ now: Date.now() + 1000 });
    const other = { ...a, repo: "blog", sha: "c".repeat(40) };
    store.save(other, snapshot(["x.ts"]), stats);
    vi.useRealTimers();
    expect(store.recent(10).map((m) => `${m.repo}@${m.sha[0]}`)).toEqual(["blog@c", "shop@b"]);
    expect(store.latest("acme", "shop")?.sha).toBe(b.sha);

    // Pruning removes the least recently viewed first and never the one being kept.
    vi.useFakeTimers({ now: Date.now() + 5000 });
    store.touch(a);
    vi.useRealTimers();
    const total = store.count();
    expect(total.maps).toBe(3);
    const removed = store.prune(total.bytes - 1, other);
    expect(removed).toEqual([`acme/shop@${b.sha}`]);
    expect(store.get(b)).toBeUndefined();
    expect(store.get(a)?.views).toBe(1);
    store.close();
  });

  it("remembers failures for a while", () => {
    const store = ResultStore.open(":memory:");
    const key = { owner: "acme", repo: "huge", sha: "d".repeat(40) };
    store.fail(key, "the repository is larger than 500 MB");
    expect(store.failure(key, 60_000)).toBe("the repository is larger than 500 MB");
    expect(store.failure(key, 0)).toBeUndefined();
    store.close();
  });
});

describe("RateLimiter", () => {
  it("allows bursts up to capacity, then refills evenly", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 3, windowMs: 3000 }, () => now);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([0, 0, 0]);
    expect(limiter.take("a")).toBe(1);
    expect(limiter.take("b")).toBe(0);
    now = 1000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
  });
});

/** A runner whose jobs finish when the test says so. */
function controlledRunner() {
  const running = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const runner: Runner = (job, progress, signal) =>
    new Promise((resolve, reject) => {
      progress({ type: "progress", state: "scanning" });
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      running.set(job.repo, { resolve: () => resolve({ files: 7 }), reject });
    });
  return { runner, running };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("JobQueue", () => {
  it("runs jobs in order, a few at a time, and reports positions", async () => {
    const { runner, running } = controlledRunner();
    const queue = new JobQueue({
      runner,
      concurrency: 1,
      maxQueued: 10,
      maxPerClient: 5,
      timeoutMs: 60_000,
    });
    const updates: JobStatus[] = [];
    queue.on("update", (job) => updates.push(job));
    const first = queue.submit(repo("one"), "ip1");
    const second = queue.submit(repo("two"), "ip1");
    const third = queue.submit(repo("three"), "ip2");
    await settled();
    expect(queue.get(first.id)?.state).toBe("scanning");
    expect(queue.get(second.id)).toMatchObject({ state: "queued", position: 0 });
    expect(queue.get(third.id)).toMatchObject({ state: "queued", position: 1 });
    expect(queue.stats).toEqual({ running: 1, queued: 2 });

    running.get("one")?.resolve();
    await settled();
    expect(queue.get(first.id)).toMatchObject({ state: "done", files: 7 });
    expect(queue.get(second.id)?.state).toBe("scanning");
    expect(queue.get(third.id)).toMatchObject({ state: "queued", position: 0 });
    expect(updates.some((u) => u.id === third.id && u.position === 0)).toBe(true);

    running.get("two")?.reject(new Error("the repository is larger than 500 MB"));
    await settled();
    expect(queue.get(second.id)).toMatchObject({
      state: "failed",
      error: "the repository is larger than 500 MB",
    });
    queue.close();
  });

  it("joins requests for the same commit and limits clients and the queue", async () => {
    const { runner } = controlledRunner();
    const queue = new JobQueue({
      runner,
      concurrency: 1,
      maxQueued: 2,
      maxPerClient: 2,
      timeoutMs: 60_000,
    });
    const job = queue.submit(repo("one"), "ip1");
    expect(queue.submit(repo("one"), "ip2").id).toBe(job.id);
    queue.submit(repo("two"), "ip1");
    expect(() => queue.submit(repo("three"), "ip1")).toThrow(QueueError);
    queue.submit(repo("three"), "ip2");
    try {
      queue.submit(repo("four"), "ip3");
      expect.unreachable();
    } catch (error) {
      expect((error as QueueError).statusCode).toBe(503);
    }
    queue.close();
  });

  it("fails jobs that run too long", async () => {
    const { runner } = controlledRunner();
    const queue = new JobQueue({
      runner,
      concurrency: 1,
      maxQueued: 2,
      maxPerClient: 2,
      timeoutMs: 20,
    });
    const job = queue.submit(repo("slow"), "ip1");
    await new Promise((r) => setTimeout(r, 60));
    expect(queue.get(job.id)).toMatchObject({ state: "failed" });
    expect(queue.get(job.id)?.error).toMatch(/took longer than/);
    queue.close();
  });
});
