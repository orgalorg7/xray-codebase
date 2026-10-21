import { execFileSync } from "node:child_process";
import { compareStrings } from "./graph-index.js";

export type FileHistory = {
  commits: number;
  additions: number;
  deletions: number;
  /** Distinct authors, most commits first. */
  authors: string[];
  /** ISO date of the most recent commit touching the file. */
  lastChanged: string;
};

export type CoChange = {
  a: string;
  b: string;
  /** Commits touching both files. */
  count: number;
  /** count / commits of the less-changed file: how reliably they change together. */
  confidence: number;
};

export type GitHistory = { files: Map<string, FileHistory>; coChange: CoChange[]; commits: number };

export type GitHistoryOptions = {
  /** Most recent commits to read (default 2000). */
  maxCommits?: number;
  /** Commits touching more files than this are bulk changes and skipped for co-change (default 30). */
  maxFilesPerCommit?: number;
  /** Pairs seen fewer times are dropped (default 3). */
  minCoChange?: number;
};

const RECORD = "\u001e";
const FIELD = "\u001f";

/** `src/{old => new}/a.ts` and `old.ts => new.ts` numstat paths, as the new path. */
export function renamedPath(path: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braces) return `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, "/");
  const plain = /^(.*) => (.*)$/.exec(path);
  return plain ? (plain[2] as string) : path;
}

/** Parses `git log --numstat` output produced with the format used by gitHistory. */
export function parseGitLog(output: string, options: GitHistoryOptions = {}): GitHistory {
  const maxFiles = options.maxFilesPerCommit ?? 30;
  const minCoChange = options.minCoChange ?? 3;
  const files = new Map<string, FileHistory & { authorCounts: Map<string, number> }>();
  const pairs = new Map<string, number>();
  let commits = 0;
  for (const record of output.split(RECORD)) {
    const [header, ...lines] = record.split("\n");
    if (!header?.includes(FIELD)) continue;
    const [, author = "", date = ""] = header.split(FIELD);
    commits++;
    const touched: string[] = [];
    for (const line of lines) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      const path = renamedPath(match[3] as string);
      touched.push(path);
      let entry = files.get(path);
      if (!entry) {
        entry = {
          commits: 0,
          additions: 0,
          deletions: 0,
          authors: [],
          lastChanged: date,
          authorCounts: new Map(),
        };
        files.set(path, entry);
      }
      entry.commits++;
      entry.additions += match[1] === "-" ? 0 : Number(match[1]);
      entry.deletions += match[2] === "-" ? 0 : Number(match[2]);
      entry.authorCounts.set(author, (entry.authorCounts.get(author) ?? 0) + 1);
      if (date > entry.lastChanged) entry.lastChanged = date;
    }
    if (touched.length < 2 || touched.length > maxFiles) continue;
    const unique = [...new Set(touched)].sort();
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\u0000${unique[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const result = new Map<string, FileHistory>();
  for (const [path, { authorCounts, ...entry }] of files) {
    entry.authors = [...authorCounts]
      .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
      .map(([name]) => name);
    result.set(path, entry);
  }
  const coChange = [...pairs]
    .filter(([, count]) => count >= minCoChange)
    .map(([key, count]) => {
      const [a, b] = key.split("\u0000") as [string, string];
      const least = Math.min(result.get(a)?.commits ?? count, result.get(b)?.commits ?? count);
      return { a, b, count, confidence: count / least };
    })
    .sort((x, y) => y.count - x.count || y.confidence - x.confidence || compareStrings(x.a, y.a));
  return { files: result, coChange, commits };
}

/**
 * Churn, authorship and co-change from the repository's git history. Returns an empty history
 * when `root` is not a git repository or git is unavailable.
 */
export function gitHistory(root: string, options: GitHistoryOptions = {}): GitHistory {
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        root,
        "log",
        "--no-merges",
        `--max-count=${options.maxCommits ?? 2000}`,
        `--format=${RECORD}%H${FIELD}%aN${FIELD}%aI`,
        "--numstat",
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { files: new Map(), coChange: [], commits: 0 };
  }
  return parseGitLog(output, options);
}

/** The current commit of a repository, or undefined outside git. Cheap enough to poll. */
export function gitHead(root: string): string | undefined {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
