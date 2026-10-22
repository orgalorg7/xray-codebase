import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzeJob, AnalyzeMessage, AnalyzeProgress } from "./analyze.js";
import { ANALYZE_JOB_ENV } from "./analyze.js";
import type { ResolvedRepo } from "./github.js";

export type JobState = "queued" | "cloning" | "scanning" | "saving" | "done" | "failed";

/** A job as clients see it. */
export type JobStatus = {
  id: string;
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  state: JobState;
  /** Jobs ahead of this one, while queued. */
  position?: number;
  /** Bytes downloaded, while cloning. */
  bytes?: number;
  /** Files found, once scanned. */
  files?: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
};

/** Runs one job to completion, reporting progress; rejects with a message people can read. */
export type Runner = (
  job: ResolvedRepo,
  progress: (update: AnalyzeProgress) => void,
  signal: AbortSignal,
) => Promise<{ files: number }>;

export type QueueOptions = {
  runner: Runner;
  /** Jobs running at once. */
  concurrency: number;
  /** Jobs waiting, beyond which new ones are refused. */
  maxQueued: number;
  /** Unfinished jobs one client may have. */
  maxPerClient: number;
  timeoutMs: number;
  /** How long finished jobs stay readable. */
  retainMs?: number;
};

export class QueueError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

type Job = { status: JobStatus; client: string; controller: AbortController };

const TERMINAL = new Set<JobState>(["done", "failed"]);

export type QueueEvents = { update: [JobStatus]; finished: [JobStatus] };

/**
 * Mapping jobs, run a few at a time in arrival order. A commit that is already queued or running
 * is not queued twice: the request joins the existing job.
 */
export class JobQueue extends EventEmitter<QueueEvents> {
  readonly #options: QueueOptions;
  readonly #jobs = new Map<string, Job>();
  readonly #waiting: Job[] = [];
  #running = 0;

  constructor(options: QueueOptions) {
    super();
    this.#options = options;
  }

  get stats(): { running: number; queued: number } {
    return { running: this.#running, queued: this.#waiting.length };
  }

  get(id: string): JobStatus | undefined {
    return this.#jobs.get(id)?.status;
  }

  /** Queues a commit for mapping, or returns the job already mapping it. */
  submit(repo: ResolvedRepo, client: string): JobStatus {
    for (const job of this.#jobs.values()) {
      if (
        !TERMINAL.has(job.status.state) &&
        job.status.owner === repo.owner &&
        job.status.repo === repo.repo &&
        job.status.sha === repo.sha
      )
        return job.status;
    }
    const mine = [...this.#jobs.values()].filter(
      (job) => job.client === client && !TERMINAL.has(job.status.state),
    ).length;
    if (mine >= this.#options.maxPerClient) {
      throw new QueueError(
        `you already have ${mine} maps in progress; wait for one to finish`,
        429,
      );
    }
    if (this.#waiting.length >= this.#options.maxQueued) {
      throw new QueueError("xray is busy right now; try again in a few minutes", 503);
    }
    const job: Job = {
      client,
      controller: new AbortController(),
      status: {
        id: randomBytes(9).toString("base64url"),
        owner: repo.owner,
        repo: repo.repo,
        sha: repo.sha,
        ref: repo.ref,
        state: "queued",
        position: this.#waiting.length,
        createdAt: Date.now(),
      },
    };
    this.#jobs.set(job.status.id, job);
    this.#waiting.push(job);
    this.#pump();
    return job.status;
  }

  #update(job: Job, changes: Partial<JobStatus>): void {
    const status = { ...job.status, ...changes };
    if (status.state !== "queued") delete status.position;
    job.status = status;
    this.emit("update", status);
    if (TERMINAL.has(status.state)) {
      this.emit("finished", status);
      const retain = setTimeout(
        () => this.#jobs.delete(status.id),
        this.#options.retainMs ?? 60 * 60_000,
      );
      retain.unref();
    }
  }

  #pump(): void {
    while (this.#running < this.#options.concurrency && this.#waiting.length > 0) {
      const job = this.#waiting.shift() as Job;
      this.#running++;
      void this.#run(job).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
    this.#waiting.forEach((job, position) => {
      if (job.status.position !== position) this.#update(job, { position });
    });
  }

  async #run(job: Job): Promise<void> {
    const { status, controller } = job;
    this.#update(job, { state: "cloning", startedAt: Date.now() });
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    try {
      const result = await this.#options.runner(
        { owner: status.owner, repo: status.repo, sha: status.sha, ref: status.ref },
        (progress) => {
          if (controller.signal.aborted) return;
          const { type: _, ...changes } = progress;
          this.#update(job, changes);
        },
        controller.signal,
      );
      this.#update(job, { state: "done", files: result.files, finishedAt: Date.now() });
    } catch (error) {
      const message = controller.signal.aborted
        ? `mapping took longer than ${Math.round(this.#options.timeoutMs / 60_000)} minutes`
        : error instanceof Error
          ? error.message
          : String(error);
      this.#update(job, { state: "failed", error: message, finishedAt: Date.now() });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stops every job. */
  close(): void {
    for (const job of this.#jobs.values()) job.controller.abort();
    this.#waiting.length = 0;
  }
}

export type WorkerRunnerOptions = Omit<
  AnalyzeJob,
  "owner" | "repo" | "sha" | "ref" | "remote" | "dir"
> & {
  /** The built worker script (`dist/analyze.js`). */
  workerPath: string;
  remote: (owner: string, repo: string) => string;
  /** A directory for checkouts; each job gets its own, deleted afterwards. */
  workDir: string;
  /** Heap limit of each worker. */
  heapMB: number;
};

/**
 * Runs each job in its own process with a heap limit and a clean environment (none of the
 * server's variables), killed when the job is cancelled or times out.
 */
export function workerRunner(options: WorkerRunnerOptions): Runner {
  const { workerPath, remote, workDir, heapMB, ...limits } = options;
  return (repo, progress, signal) =>
    new Promise((resolve, reject) => {
      const job: AnalyzeJob = {
        ...limits,
        ...repo,
        remote: remote(repo.owner, repo.repo),
        dir: join(
          workDir,
          `${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}-${randomBytes(4).toString("hex")}`,
        ),
      };
      const child = fork(workerPath, [], {
        execArgv: [`--max-old-space-size=${heapMB}`],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          NODE_ENV: "production",
          [ANALYZE_JOB_ENV]: JSON.stringify(job),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        signal,
        killSignal: "SIGKILL",
      });
      let stderr = "";
      let settled = false;
      const settle = (error: Error | undefined, files = 0) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve({ files });
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("message", (message: AnalyzeMessage) => {
        if (message.type === "progress") progress(message);
        else if (message.type === "done") settle(undefined, message.files);
        else if (message.type === "error") settle(new Error(message.message));
      });
      child.on("error", (error) => settle(error));
      child.on("exit", (code, signalName) => {
        // The worker deletes its checkout, unless it was killed first.
        rmSync(job.dir, { recursive: true, force: true });
        const outOfMemory = /heap out of memory|Allocation failed/i.test(stderr);
        settle(
          new Error(
            outOfMemory
              ? "the repository needs more memory than one map may use"
              : `the mapping process stopped (${signalName ?? `exit code ${code}`})`,
          ),
        );
      });
    });
}
