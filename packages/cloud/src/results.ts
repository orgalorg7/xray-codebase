import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Snapshot, SnapshotData } from "@xray/service";

/** A mapped commit, as listed and linked. */
export type MapRecord = {
  owner: string;
  repo: string;
  sha: string;
  /** The branch or tag it was mapped from. */
  ref: string;
  files: number;
  symbols: number;
  edges: number;
  /** Files per language. */
  languages: Record<string, number>;
  /** How long cloning and mapping took, in milliseconds. */
  ms: number;
  /** Stored size (compressed), in bytes. */
  bytes: number;
  createdAt: number;
  viewedAt: number;
  views: number;
};

export type MapKey = { owner: string; repo: string; sha: string };

export const mapSlug = ({ owner, repo, sha }: MapKey): string => `${owner}/${repo}@${sha}`;

type Row = {
  slug: string;
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  files: number;
  symbols: number;
  edges: number;
  languages: string;
  ms: number;
  bytes: number;
  created_at: number;
  viewed_at: number;
  views: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maps (
  slug TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  files INTEGER NOT NULL,
  symbols INTEGER NOT NULL,
  edges INTEGER NOT NULL,
  languages TEXT NOT NULL,
  ms INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  snapshot BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS maps_repo ON maps (owner, repo, created_at);
CREATE INDEX IF NOT EXISTS maps_viewed ON maps (viewed_at);
CREATE TABLE IF NOT EXISTS sources (
  slug TEXT NOT NULL,
  path TEXT NOT NULL,
  text BLOB NOT NULL,
  PRIMARY KEY (slug, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS failures (
  slug TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
`;

const toRecord = (row: Row): MapRecord => ({
  owner: row.owner,
  repo: row.repo,
  sha: row.sha,
  ref: row.ref,
  files: row.files,
  symbols: row.symbols,
  edges: row.edges,
  languages: JSON.parse(row.languages) as Record<string, number>,
  ms: row.ms,
  bytes: row.bytes,
  createdAt: row.created_at,
  viewedAt: row.viewed_at,
  views: row.views,
});

const COLUMNS =
  "slug, owner, repo, sha, ref, files, symbols, edges, languages, ms, bytes, created_at, viewed_at, views";

/**
 * Every mapped commit: its graph (gzip JSON) and each file's source (gzip), in one SQLite
 * database shared by the server and its analysis workers (WAL, so they never block readers).
 */
export class ResultStore {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(path: string): ResultStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 15000");
    // Must come before the first table: lets prune hand freed pages back to the disk.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(SCHEMA);
    return new ResultStore(db);
  }

  #sql(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  get(key: MapKey): MapRecord | undefined {
    const row = this.#sql(`SELECT ${COLUMNS} FROM maps WHERE slug = ?`).get(mapSlug(key)) as
      | Row
      | undefined;
    return row && toRecord(row);
  }

  /** The newest mapped commit of a repository. */
  latest(owner: string, repo: string): MapRecord | undefined {
    const row = this.#sql(
      `SELECT ${COLUMNS} FROM maps WHERE owner = ? AND repo = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(owner, repo) as Row | undefined;
    return row && toRecord(row);
  }

  /** Recently mapped repositories, one entry (the newest commit) per repository. */
  recent(limit: number): MapRecord[] {
    const rows = this.#sql(
      `SELECT ${COLUMNS} FROM maps m WHERE created_at = (
         SELECT MAX(created_at) FROM maps WHERE owner = m.owner AND repo = m.repo
       ) ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Row[];
    return rows.map(toRecord);
  }

  count(): { maps: number; bytes: number } {
    const row = this.#sql(
      "SELECT COUNT(*) AS maps, COALESCE(SUM(bytes), 0) AS bytes FROM maps",
    ).get() as {
      maps: number;
      bytes: number;
    };
    return { maps: row.maps, bytes: row.bytes };
  }

  /** Stores a mapped commit, replacing an earlier map of it. */
  save(
    key: MapKey & { ref: string; ms: number },
    data: SnapshotData,
    stats: { files: number; symbols: number; edges: number; languages: Record<string, number> },
  ): MapRecord {
    const slug = mapSlug(key);
    const { sources = {}, ...rest } = data;
    const snapshot = gzipSync(JSON.stringify(rest));
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#sql("DELETE FROM sources WHERE slug = ?").run(slug);
      let bytes = snapshot.length;
      const insert = this.#sql("INSERT INTO sources (slug, path, text) VALUES (?, ?, ?)");
      for (const [path, text] of Object.entries(sources)) {
        const compressed = gzipSync(text);
        bytes += compressed.length;
        insert.run(slug, path, compressed);
      }
      this.#sql(
        `INSERT OR REPLACE INTO maps (${COLUMNS}, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        slug,
        key.owner,
        key.repo,
        key.sha,
        key.ref,
        stats.files,
        stats.symbols,
        stats.edges,
        JSON.stringify(stats.languages),
        Math.round(key.ms),
        bytes,
        now,
        now,
        snapshot,
      );
      this.#sql("DELETE FROM failures WHERE slug = ?").run(slug);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.get(key) as MapRecord;
  }

  /** The stored snapshot, reading sources from the database as they are asked for. */
  snapshot(key: MapKey): Snapshot | undefined {
    const slug = mapSlug(key);
    const row = this.#sql("SELECT snapshot FROM maps WHERE slug = ?").get(slug) as
      | { snapshot: Uint8Array }
      | undefined;
    if (!row) return undefined;
    const data = JSON.parse(gunzipSync(row.snapshot).toString("utf8")) as SnapshotData;
    const read = this.#sql("SELECT text FROM sources WHERE slug = ? AND path = ?");
    return {
      ...data,
      sources: (path) => {
        const source = read.get(slug, path) as { text: Uint8Array } | undefined;
        return source && gunzipSync(source.text).toString("utf8");
      },
    };
  }

  /** Counts a view; recently viewed maps are the last to be pruned. */
  touch(key: MapKey): void {
    this.#sql("UPDATE maps SET viewed_at = ?, views = views + 1 WHERE slug = ?").run(
      Date.now(),
      mapSlug(key),
    );
  }

  /**
   * Deletes the least recently viewed maps until the total stored size fits `maxBytes`, keeping
   * `keep`. Returns the slugs it removed.
   */
  prune(maxBytes: number, keep?: MapKey): string[] {
    const kept = keep && mapSlug(keep);
    let { bytes } = this.count();
    const removed: string[] = [];
    if (bytes <= maxBytes) return removed;
    const rows = this.#sql("SELECT slug, bytes FROM maps ORDER BY viewed_at ASC").all() as {
      slug: string;
      bytes: number;
    }[];
    for (const row of rows) {
      if (bytes <= maxBytes) break;
      if (row.slug === kept) continue;
      this.#db.exec("BEGIN IMMEDIATE");
      this.#sql("DELETE FROM sources WHERE slug = ?").run(row.slug);
      this.#sql("DELETE FROM maps WHERE slug = ?").run(row.slug);
      this.#db.exec("COMMIT");
      bytes -= row.bytes;
      removed.push(row.slug);
    }
    this.#db.exec("PRAGMA incremental_vacuum");
    return removed;
  }

  /** Remembers that mapping a commit failed, so repeated requests fail fast for a while. */
  fail(key: MapKey, error: string): void {
    this.#sql("INSERT OR REPLACE INTO failures (slug, error, failed_at) VALUES (?, ?, ?)").run(
      mapSlug(key),
      error,
      Date.now(),
    );
  }

  /** Why mapping a commit failed within the last `withinMs`, if it did. */
  failure(key: MapKey, withinMs: number): string | undefined {
    const row = this.#sql("SELECT error, failed_at FROM failures WHERE slug = ?").get(
      mapSlug(key),
    ) as { error: string; failed_at: number } | undefined;
    return row && Date.now() - row.failed_at < withinMs ? row.error : undefined;
  }

  close(): void {
    this.#db.close();
  }
}
