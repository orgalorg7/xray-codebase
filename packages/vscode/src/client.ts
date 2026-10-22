import { type ChildProcess, fork } from "node:child_process";
import { totalmem } from "node:os";
import type { MapEvent, Request, WorkerEvent, WorkerMessage, WorkerOptions } from "./protocol.js";
import { WORKER_OPTIONS_ENV } from "./protocol.js";

export type ClientOptions = WorkerOptions & {
  workerPath: string;
  /** Heap limit for the worker; 0 picks half the machine's memory (2–8 GB). */
  maxMemoryMB: number;
  /** The runtime to fork with: VS Code's own (as Node) unless told otherwise. */
  execPath?: string;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * One analysis worker for one workspace folder. Starts it on first use, matches responses to
 * requests, forwards events, and restarts it after a crash on the next request.
 */
export class WorkerClient {
  readonly #options: ClientOptions;
  readonly #listeners = new Set<(event: WorkerEvent | MapEvent) => void>();
  readonly #fatalListeners = new Set<(message: string) => void>();
  readonly #pending = new Map<number, Pending>();
  #process: ChildProcess | undefined;
  #next = 1;
  #fatal: string | undefined;
  #disposed = false;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#process !== undefined;
  }

  /** The worker's process ID while it runs. */
  get pid(): number | undefined {
    return this.#process?.pid;
  }

  /** Why the worker cannot run at all, once it has said so. */
  get fatal(): string | undefined {
    return this.#fatal;
  }

  onEvent(listener: (event: WorkerEvent | MapEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFatal(listener: (message: string) => void): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  #start(): ChildProcess {
    if (this.#process) return this.#process;
    const { workerPath, maxMemoryMB, execPath, ...workerOptions } = this.#options;
    const megabytes =
      maxMemoryMB > 0
        ? maxMemoryMB
        : Math.max(2048, Math.min(8192, Math.floor(totalmem() / 2 ** 21)));
    const child = fork(workerPath, [], {
      execPath: execPath ?? process.execPath,
      execArgv: [`--max-old-space-size=${megabytes}`],
      env: {
        ...process.env,
        // Inside VS Code, process.execPath is Electron: make it behave as plain Node.
        ELECTRON_RUN_AS_NODE: "1",
        [WORKER_OPTIONS_ENV]: JSON.stringify(workerOptions satisfies WorkerOptions),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("message", (message: WorkerMessage) => this.#receive(message));
    child.on("exit", (code, signal) => {
      if (this.#process !== child) return;
      this.#process = undefined;
      const reason =
        this.#fatal ??
        `the xray worker stopped (${signal ?? `exit code ${code}`})${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`;
      for (const pending of this.#pending.values()) pending.reject(new Error(reason));
      this.#pending.clear();
    });
    this.#process = child;
    return child;
  }

  #receive(message: WorkerMessage): void {
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    } else if (message.type === "event") {
      for (const listener of this.#listeners) listener(message.event);
    } else if (message.type === "fatal") {
      this.#fatal = message.message;
      for (const listener of this.#fatalListeners) listener(message.message);
    }
  }

  /** Calls a worker method. Starts (or restarts) the worker if needed. */
  request<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error("xray has been shut down"));
    if (this.#fatal) return Promise.reject(new Error(this.#fatal));
    const child = this.#start();
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.send({ type: "request", id, method, args } satisfies Request);
    });
  }

  /** Lets map listeners know the editor asked to show a node. */
  emit(event: MapEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  dispose(): void {
    this.#disposed = true;
    const child = this.#process;
    this.#process = undefined;
    for (const pending of this.#pending.values())
      pending.reject(new Error("xray has been shut down"));
    this.#pending.clear();
    if (child) {
      child.disconnect?.();
      child.kill();
    }
  }
}
