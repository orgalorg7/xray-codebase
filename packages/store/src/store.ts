import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  type EdgeKind,
  GRAPH_FORMAT_VERSION,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Language,
  parseId,
  type SourceLocation,
  splitIdentifier,
} from "@xray/schema";

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  digest TEXT
);

-- owner: the file whose analysis produced the row, or NULL for shared rows (repo,
-- directories, packages, externals). Rescanning a file replaces exactly what it owns.
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  language TEXT,
  file TEXT, line INTEGER, col INTEGER, end_line INTEGER, end_col INTEGER,
  signature TEXT,
  doc TEXT,
  exported INTEGER,
  meta TEXT,
  owner TEXT
);
CREATE INDEX IF NOT EXISTS nodes_owner ON nodes(owner);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  file TEXT, line INTEGER, col INTEGER, end_line INTEGER, end_col INTEGER,
  detail TEXT,
  owner TEXT
);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source, kind);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target, kind);
CREATE INDEX IF NOT EXISTS edges_owner ON edges(owner);

-- Full-text rows share their node's rowid, so they are found and deleted by key.
CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
  name, words, path, doc, tokenize = 'unicode61'
);
`;

export type FileRecord = {
  path: string;
  language?: Language;
  /** Content hash; a file whose hash is unchanged does not need re-parsing. */
  hash: string;
  size: number;
  /**
   * Digest of the file's analysis output. It can change while `hash` does not, when a
   * dependency changes how this file's references resolve.
   */
  digest?: string;
};

export type Direction = "out" | "in" | "both";

export type TraversalOptions = {
  direction?: Direction;
  /** Restrict to these edge kinds. All kinds when omitted. */
  kinds?: readonly EdgeKind[];
};

export type SearchHit = { node: GraphNode; score: number };

export type StoreStats = { files: number; nodes: number; edges: number };

type Row = Record<string, SQLInputValue>;

const nullable = (value: string | number | undefined): string | number | null => value ?? null;

function rowToLocation(row: Row): SourceLocation | undefined {
  if (row.file === null || row.line === null || row.col === null) return undefined;
  const location: SourceLocation = {
    file: String(row.file),
    line: Number(row.line),
    column: Number(row.col),
  };
  if (row.end_line !== null) location.endLine = Number(row.end_line);
  if (row.end_col !== null) location.endColumn = Number(row.end_col);
  return location;
}

function rowToNode(row: Row): GraphNode {
  const node: GraphNode = {
    id: String(row.id),
    kind: row.kind as GraphNode["kind"],
    name: String(row.name),
    qualifiedName: String(row.qualified_name),
  };
  if (row.language !== null) node.language = row.language as Language;
  const location = rowToLocation(row);
  if (location) node.location = location;
  if (row.signature !== null) node.signature = String(row.signature);
  if (row.doc !== null) node.doc = String(row.doc);
  if (row.exported !== null) node.exported = row.exported === 1;
  if (row.meta !== null) node.meta = JSON.parse(String(row.meta)) as Record<string, unknown>;
  return node;
}

function rowToEdge(row: Row): GraphEdge {
  const edge: GraphEdge = {
    source: String(row.source),
    target: String(row.target),
    kind: row.kind as EdgeKind,
    confidence: row.confidence as GraphEdge["confidence"],
  };
  const location = rowToLocation(row);
  if (location) edge.location = location;
  if (row.detail !== null) edge.detail = String(row.detail);
  return edge;
}

/** Turns free text into an FTS5 query that ORs prefix matches of every word. */
function toFtsQuery(query: string): string | undefined {
  const words = splitIdentifier(query);
  if (words.length === 0) return undefined;
  return words.map((word) => `"${word}"*`).join(" OR ");
}

/**
 * The persistent code graph behind every xray shell. Rows are owned by the file that
 * produced them, which makes incremental rescans a matter of replacing one file's rows.
 */
export class GraphStore {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens (creating if needed) a store at `path`, or an in-memory one for `":memory:"`. */
  static open(path: string): GraphStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;");
    db.exec(DDL);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (version === undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      );
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `Index schema version ${String(version.value)} is not supported (expected ${SCHEMA_VERSION}). Delete the index and rescan.`,
      );
    }
    return new GraphStore(db);
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  /** Prepared statements are compiled once per SQL string. */
  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs `fn` atomically. Nested calls become savepoints inside the outer transaction. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp${this.#depth}`;
    this.#db.exec(this.#depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth--;
      this.#db.exec(
        this.#depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
      throw error;
    }
  }

  // ---- files -------------------------------------------------------------------------

  getFile(path: string): FileRecord | undefined {
    const row = this.#prepare("SELECT * FROM files WHERE path = ?").get(path);
    return row === undefined ? undefined : this.#rowToFile(row);
  }

  listFiles(): FileRecord[] {
    return this.#prepare("SELECT * FROM files ORDER BY path")
      .all()
      .map((row) => this.#rowToFile(row));
  }

  /** Replaces everything `file` owns with the given nodes and edges. */
  replaceFile(file: FileRecord, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
    this.transaction(() => {
      this.#deleteOwned(file.path);
      this.#prepare(
        "INSERT OR REPLACE INTO files (path, language, hash, size, digest) VALUES (?, ?, ?, ?, ?)",
      ).run(file.path, nullable(file.language), file.hash, file.size, nullable(file.digest));
      this.#insert(nodes, edges, file.path);
    });
  }

  removeFile(path: string): void {
    this.transaction(() => {
      this.#deleteOwned(path);
      this.#prepare("DELETE FROM files WHERE path = ?").run(path);
    });
  }

  /** Replaces all shared rows (repo, directories, packages, externals). */
  replaceShared(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
    this.transaction(() => {
      this.#deleteOwned(null);
      this.#insert(nodes, edges, null);
    });
  }

  // ---- nodes and edges ---------------------------------------------------------------

  getNode(id: string): GraphNode | undefined {
    const row = this.#prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row === undefined ? undefined : rowToNode(row);
  }

  findNodes(filter: { kind?: GraphNode["kind"]; file?: string; name?: string } = {}): GraphNode[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.file !== undefined) {
      clauses.push("file = ?");
      params.push(filter.file);
    }
    if (filter.name !== undefined) {
      clauses.push("name = ?");
      params.push(filter.name);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.#prepare(`SELECT * FROM nodes ${where} ORDER BY id`)
      .all(...params)
      .map(rowToNode);
  }

  /** Edges incident to `id`, in the given direction (default: outgoing). */
  edges(id: string, options: TraversalOptions = {}): GraphEdge[] {
    const direction = options.direction ?? "out";
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (direction !== "in") {
      clauses.push("source = ?");
      params.push(id);
    }
    if (direction !== "out") {
      clauses.push("target = ?");
      params.push(id);
    }
    let sql = `SELECT * FROM edges WHERE (${clauses.join(" OR ")})`;
    if (options.kinds !== undefined) {
      if (options.kinds.length === 0) return [];
      sql += ` AND kind IN (${options.kinds.map(() => "?").join(", ")})`;
      params.push(...options.kinds);
    }
    return this.#prepare(`${sql} ORDER BY id`)
      .all(...params)
      .map(rowToEdge);
  }

  /** IDs of nodes adjacent to `id`, deduplicated, in first-seen order. */
  neighbors(id: string, options: TraversalOptions = {}): string[] {
    const seen = new Set<string>();
    for (const edge of this.edges(id, options)) {
      const other = edge.source === id ? edge.target : edge.source;
      if (other !== id || edge.source === edge.target) seen.add(other);
    }
    return [...seen];
  }

  /**
   * Breadth-first expansion from `roots` up to `depth` hops. Returns the induced subgraph:
   * the reached nodes plus every edge between them.
   */
  subgraph(roots: readonly string[], options: TraversalOptions & { depth?: number } = {}): Graph {
    const depth = options.depth ?? 1;
    const reached = new Set(roots.filter((id) => this.getNode(id) !== undefined));
    let frontier = [...reached];
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of this.neighbors(id, options)) {
          if (!reached.has(other) && this.getNode(other) !== undefined) {
            reached.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const nodes = [...reached].flatMap((id) => this.getNode(id) ?? []);
    const outgoing: TraversalOptions = options.kinds ? { kinds: options.kinds } : {};
    const edges = nodes.flatMap((node) =>
      this.edges(node.id, outgoing).filter((edge) => reached.has(edge.target)),
    );
    return { version: GRAPH_FORMAT_VERSION, nodes, edges };
  }

  /**
   * Shortest path of node IDs from `from` to `to` following edges in `direction`
   * (default: outgoing), or undefined when unreachable.
   */
  shortestPath(from: string, to: string, options: TraversalOptions = {}): string[] | undefined {
    if (from === to) return this.getNode(from) ? [from] : undefined;
    const previous = new Map<string, string>([[from, from]]);
    let frontier = [from];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of this.neighbors(id, options)) {
          if (previous.has(other)) continue;
          previous.set(other, id);
          if (other === to) {
            const path = [to];
            let step = to;
            while (step !== from) {
              step = previous.get(step) as string;
              path.push(step);
            }
            return path.reverse();
          }
          next.push(other);
        }
      }
      frontier = next;
    }
    return undefined;
  }

  // ---- search ------------------------------------------------------------------------

  /** Full-text search over names, identifier words, paths and docs, best match first. */
  search(query: string, limit = 20): SearchHit[] {
    const fts = toFtsQuery(query);
    if (fts === undefined) return [];
    // bm25 weights follow column order: name, words, path, doc. Lower is better.
    const rows = this.#prepare(
      `SELECT nodes.*, bm25(symbol_fts, 10, 6, 2, 1) AS rank
         FROM symbol_fts JOIN nodes ON nodes.rowid = symbol_fts.rowid
         WHERE symbol_fts MATCH ?
         ORDER BY rank, nodes.id
         LIMIT ?`,
    ).all(fts, limit);
    return rows.map((row) => ({ node: rowToNode(row), score: -Number(row.rank) }));
  }

  // ---- whole-graph -------------------------------------------------------------------

  exportGraph(root?: string): Graph {
    const graph: Graph = {
      version: GRAPH_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      nodes: this.#prepare("SELECT * FROM nodes ORDER BY id").all().map(rowToNode),
      edges: this.#prepare("SELECT * FROM edges ORDER BY id").all().map(rowToEdge),
    };
    if (root !== undefined) graph.root = root;
    return graph;
  }

  /**
   * Loads a graph, replacing the current contents. Nodes are owned by their module's file
   * (taken from the ID) and edges by their source's file, so later rescans stay incremental.
   */
  importGraph(graph: Graph): void {
    const ownerOf = (id: string): string | null => {
      const parsed = parseId(id);
      return parsed?.type === "module" || parsed?.type === "symbol" ? parsed.path : null;
    };
    this.transaction(() => {
      this.#db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM symbol_fts;");
      for (const node of graph.nodes) this.#insertNode(node, ownerOf(node.id));
      for (const edge of graph.edges) this.#insertEdge(edge, ownerOf(edge.source));
    });
  }

  stats(): StoreStats {
    const count = (table: string): number =>
      Number(this.#prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
    return { files: count("files"), nodes: count("nodes"), edges: count("edges") };
  }

  // ---- internals ---------------------------------------------------------------------

  #rowToFile(row: Row): FileRecord {
    const file: FileRecord = {
      path: String(row.path),
      hash: String(row.hash),
      size: Number(row.size),
    };
    if (row.language !== null) file.language = row.language as Language;
    if (row.digest !== null) file.digest = String(row.digest);
    return file;
  }

  #deleteOwned(owner: string | null): void {
    const match = owner === null ? "owner IS NULL" : "owner = ?";
    const params = owner === null ? [] : [owner];
    this.#prepare(
      `DELETE FROM symbol_fts WHERE rowid IN (SELECT rowid FROM nodes WHERE ${match})`,
    ).run(...params);
    this.#prepare(`DELETE FROM nodes WHERE ${match}`).run(...params);
    this.#prepare(`DELETE FROM edges WHERE ${match}`).run(...params);
  }

  #insert(nodes: readonly GraphNode[], edges: readonly GraphEdge[], owner: string | null): void {
    for (const node of nodes) this.#insertNode(node, owner);
    for (const edge of edges) this.#insertEdge(edge, owner);
  }

  #insertNode(node: GraphNode, owner: string | null): void {
    const loc = node.location;
    const existing = this.#prepare("SELECT rowid FROM nodes WHERE id = ?").get(node.id);
    if (existing !== undefined) {
      this.#prepare("DELETE FROM symbol_fts WHERE rowid = ?").run(Number(existing.rowid));
      this.#prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
    }
    this.#prepare(
      `INSERT INTO nodes
         (id, kind, name, qualified_name, language, file, line, col, end_line, end_col,
          signature, doc, exported, meta, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      node.id,
      node.kind,
      node.name,
      node.qualifiedName,
      nullable(node.language),
      nullable(loc?.file),
      nullable(loc?.line),
      nullable(loc?.column),
      nullable(loc?.endLine),
      nullable(loc?.endColumn),
      nullable(node.signature),
      nullable(node.doc),
      node.exported === undefined ? null : node.exported ? 1 : 0,
      node.meta === undefined ? null : JSON.stringify(node.meta),
      owner,
    );
    const { rowid } = this.#prepare("SELECT last_insert_rowid() AS rowid").get() as {
      rowid: number;
    };
    this.#prepare(
      "INSERT INTO symbol_fts (rowid, name, words, path, doc) VALUES (?, ?, ?, ?, ?)",
    ).run(
      rowid,
      node.name,
      splitIdentifier(node.qualifiedName).join(" "),
      splitIdentifier(loc?.file ?? "").join(" "),
      node.doc ?? "",
    );
  }

  #insertEdge(edge: GraphEdge, owner: string | null): void {
    const loc = edge.location;
    this.#prepare(
      `INSERT INTO edges
         (source, target, kind, confidence, file, line, col, end_line, end_col, detail, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      edge.source,
      edge.target,
      edge.kind,
      edge.confidence,
      nullable(loc?.file),
      nullable(loc?.line),
      nullable(loc?.column),
      nullable(loc?.endLine),
      nullable(loc?.endColumn),
      nullable(edge.detail),
      owner,
    );
  }
}
