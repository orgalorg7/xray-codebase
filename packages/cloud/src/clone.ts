import { mkdirSync } from "node:fs";
import { git } from "./git.js";

export type CheckoutOptions = {
  /** The clone URL. */
  remote: string;
  sha: string;
  /** An empty directory to check out into. */
  dir: string;
  protocols: string;
  /** Commits of history to fetch (1 = just the commit). */
  depth: number;
  /** Stop downloading past this many bytes. */
  maxBytes: number;
  timeoutMs: number;
  /** Bytes received so far, as git reports them. */
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
};

export class TooLargeError extends Error {}

const UNITS: Record<string, number> = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** The largest "Receiving objects: …, 12.34 MiB" amount in git's progress output. */
export function receivedBytes(progress: string): number | undefined {
  let bytes: number | undefined;
  for (const match of progress.matchAll(
    /Receiving objects:[^\r\n]*?([\d.]+) (bytes|KiB|MiB|GiB)/g,
  )) {
    const value = Number(match[1]) * (UNITS[match[2] as string] ?? 1);
    if (bytes === undefined || value > bytes) bytes = value;
  }
  return bytes;
}

/**
 * Downloads one commit (shallow, no tags, no submodules, no LFS) and checks it out with the
 * safe git settings. Nothing in the repository runs: no hooks, no filters, no install scripts.
 * The download is cut off once it passes `maxBytes`.
 */
export async function checkout(options: CheckoutOptions): Promise<void> {
  const { dir, protocols, signal } = options;
  mkdirSync(dir, { recursive: true });
  const base = { cwd: dir, protocols, ...(signal ? { signal } : {}) };
  // An empty template: no sample hooks or other files from the system's git installation.
  await git(["init", "--quiet", "--template="], { ...base, timeoutMs: 10_000 });

  const download = new AbortController();
  let tooLarge = false;
  let tail = "";
  const fetchSignal = signal ? AbortSignal.any([signal, download.signal]) : download.signal;
  try {
    await git(
      [
        "fetch",
        "--progress",
        `--depth=${Math.max(1, options.depth)}`,
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        options.remote,
        options.sha,
      ],
      {
        ...base,
        signal: fetchSignal,
        timeoutMs: options.timeoutMs,
        onStderr: (text) => {
          tail = (tail + text).slice(-400);
          const bytes = receivedBytes(tail);
          if (bytes === undefined) return;
          options.onProgress?.(bytes);
          if (bytes > options.maxBytes && !tooLarge) {
            tooLarge = true;
            download.abort();
          }
        },
      },
    );
  } catch (error) {
    if (tooLarge) {
      throw new TooLargeError(
        `the repository is larger than ${Math.round(options.maxBytes / 1024 ** 2)} MB`,
      );
    }
    throw error;
  }
  await git(["checkout", "--quiet", "--no-recurse-submodules", "FETCH_HEAD"], {
    ...base,
    timeoutMs: options.timeoutMs,
  });
}
