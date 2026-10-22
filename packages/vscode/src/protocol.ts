/**
 * Messages between the extension, its analysis worker and the map webview. The worker and the
 * webview speak the same request/response shape, so the extension can relay map requests to
 * the worker unchanged.
 */

export type Request = { type: "request"; id: number; method: string; args: unknown[] };

export type Response = { type: "response"; id: number; result?: unknown; error?: string };

/** Pushed without a request: scan progress, and map navigation from the editor. */
export type WorkerEvent =
  | { type: "scanning" }
  | { type: "scanned"; files: number; ms: number; changed: number }
  | { type: "error"; message: string };

export type Event = { type: "event"; event: WorkerEvent | MapEvent };

/** Puts the map into a state, given as the map's own URL-hash parameters (as in shared links). */
export type MapEvent = { type: "navigate"; hash: string };

/** Sent by the worker when it cannot run at all (for example, no SQLite in this Node). */
export type Fatal = { type: "fatal"; message: string };

export type WorkerMessage = Response | Event | Fatal;

/** What the webview sends besides requests. */
export type WebviewMessage =
  | Request
  | { type: "ready" }
  | { type: "openFile"; file: string; line?: number };

/** Settings the worker is started with (passed as JSON in an environment variable). */
export type WorkerOptions = {
  root: string;
  indexPath: string;
  watch: boolean;
  ignore: string[];
};

export const WORKER_OPTIONS_ENV = "XRAY_WORKER_OPTIONS";
