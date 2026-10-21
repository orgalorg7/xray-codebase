import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "@xray/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphStore, splitIdentifier } from "../src/index.js";

const mod = (path: string): GraphNode => ({
  id: `ts:${path}`,
  kind: "module",
  name: path.split("/").at(-1) ?? path,
  qualifiedName: path,
  language: "ts",
  location: { file: path, line: 1, column: 1 },
});

const fn = (path: string, name: string, doc?: string): GraphNode => ({
  id: `ts:${path}#${name}`,
  kind: "function",
  name: name.split(".").at(-1) ?? name,
  qualifiedName: name,
  language: "ts",
  location: { file: path, line: 3, column: 1, endLine: 5, endColumn: 2 },
  exported: true,
  ...(doc === undefined ? {} : { doc }),
});

const edge = (source: GraphNode, kind: GraphEdge["kind"], target: GraphNode): GraphEdge => ({
  source: source.id,
  target: target.id,
  kind,
  confidence: "exact",
});

// a.ts: login -> validatePassword (b.ts) -> hashPassword (c.ts)
const a = mod("src/a.ts");
const b = mod("src/b.ts");
const c = mod("src/c.ts");
const login = fn("src/a.ts", "AuthService.login", "Signs a user in and returns a session.");
const validate = fn("src/b.ts", "validatePassword");
const hash = fn("src/c.ts", "hashPassword");

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = GraphStore.open(":memory:");
    store.replaceFile(
      { path: "src/a.ts", language: "ts", hash: "h1", size: 10 },
      [a, login],
      [
        edge(a, "contains", login),
        edge(a, "imports", b),
        { ...edge(login, "calls", validate), location: { file: "src/a.ts", line: 4, column: 5 } },
      ],
    );
    store.replaceFile(
      { path: "src/b.ts", language: "ts", hash: "h2", size: 10 },
      [b, validate],
      [edge(b, "contains", validate), edge(b, "imports", c), edge(validate, "calls", hash)],
    );
    store.replaceFile(
      { path: "src/c.ts", language: "ts", hash: "h3", size: 10 },
      [c, hash],
      [edge(c, "contains", hash)],
    );
  });

  afterEach(() => store.close());

  it("round-trips nodes with all optional fields", () => {
    expect(store.getNode(login.id)).toEqual(login);
    expect(store.getNode(a.id)).toEqual(a);
    expect(store.getNode("ts:missing.ts")).toBeUndefined();
  });

  it("tracks files", () => {
    expect(store.getFile("src/b.ts")).toEqual({
      path: "src/b.ts",
      language: "ts",
      hash: "h2",
      size: 10,
    });
    expect(store.listFiles().map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(store.stats()).toEqual({ files: 3, nodes: 6, edges: 7 });
  });

  it("stores analysis digests", () => {
    store.replaceFile({ path: "src/c.ts", hash: "h3", size: 10, digest: "d3" }, [c, hash], []);
    expect(store.getFile("src/c.ts")).toEqual({
      path: "src/c.ts",
      hash: "h3",
      size: 10,
      digest: "d3",
    });
  });

  it("queries edges by direction and kind", () => {
    expect(store.edges(login.id)).toEqual([
      { ...edge(login, "calls", validate), location: { file: "src/a.ts", line: 4, column: 5 } },
    ]);
    expect(store.neighbors(validate.id, { direction: "in" })).toEqual([login.id, b.id]);
    expect(store.neighbors(validate.id, { direction: "in", kinds: ["calls"] })).toEqual([login.id]);
    expect(store.neighbors(validate.id, { direction: "both", kinds: ["calls"] })).toEqual([
      login.id,
      hash.id,
    ]);
    expect(store.edges(validate.id, { kinds: [] })).toEqual([]);
  });

  it("finds nodes by filter", () => {
    expect(store.findNodes({ kind: "function" }).map((n) => n.id)).toEqual([
      login.id,
      validate.id,
      hash.id,
    ]);
    expect(store.findNodes({ file: "src/b.ts", kind: "function" })).toEqual([validate]);
    expect(store.findNodes({ name: "login" })).toEqual([login]);
  });

  it("replaces only what a file owns on rescan", () => {
    const verify = fn("src/b.ts", "verifyPassword");
    store.replaceFile(
      { path: "src/b.ts", language: "ts", hash: "h2b", size: 12 },
      [b, verify],
      [edge(b, "contains", verify)],
    );
    expect(store.getNode(validate.id)).toBeUndefined();
    expect(store.getNode(verify.id)).toEqual(verify);
    expect(store.getFile("src/b.ts")?.hash).toBe("h2b");
    // a.ts still owns its (now dangling) call edge until a.ts is re-resolved.
    expect(store.edges(login.id, { kinds: ["calls"] })).toHaveLength(1);
    expect(store.search("validate")).toEqual([]);
    expect(store.search("verify").map((hit) => hit.node.id)).toEqual([verify.id]);
  });

  it("removes files", () => {
    store.removeFile("src/c.ts");
    expect(store.getFile("src/c.ts")).toBeUndefined();
    expect(store.getNode(hash.id)).toBeUndefined();
    expect(store.stats()).toEqual({ files: 2, nodes: 4, edges: 6 });
  });

  it("keeps shared rows separate from file rows", () => {
    const dir: GraphNode = { id: "dir:src", kind: "directory", name: "src", qualifiedName: "src" };
    store.replaceShared([dir], [edge(dir, "contains", a)]);
    store.replaceFile({ path: "src/a.ts", language: "ts", hash: "h1", size: 10 }, [a, login], []);
    expect(store.getNode(dir.id)).toEqual(dir);
    expect(store.edges(dir.id)).toHaveLength(1);
    store.replaceShared([], []);
    expect(store.getNode(dir.id)).toBeUndefined();
    expect(store.getNode(a.id)).toEqual(a);
  });

  it("extracts subgraphs", () => {
    const sub = store.subgraph([login.id], { depth: 2, kinds: ["calls"] });
    expect(sub.nodes.map((n) => n.id)).toEqual([login.id, validate.id, hash.id]);
    expect(sub.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      `${login.id}->${validate.id}`,
      `${validate.id}->${hash.id}`,
    ]);
    expect(store.subgraph([hash.id], { depth: 1, direction: "in" }).nodes.map((n) => n.id)).toEqual(
      [hash.id, validate.id, c.id],
    );
    expect(store.subgraph(["ts:nope"]).nodes).toEqual([]);
  });

  it("finds shortest paths", () => {
    expect(store.shortestPath(login.id, hash.id, { kinds: ["calls"] })).toEqual([
      login.id,
      validate.id,
      hash.id,
    ]);
    expect(store.shortestPath(hash.id, login.id, { kinds: ["calls"] })).toBeUndefined();
    expect(store.shortestPath(hash.id, login.id, { kinds: ["calls"], direction: "in" })).toEqual([
      hash.id,
      validate.id,
      login.id,
    ]);
    expect(store.shortestPath(login.id, login.id)).toEqual([login.id]);
  });

  it("searches identifiers, paths and docs", () => {
    expect(store.search("password").map((hit) => hit.node.id)).toEqual(
      expect.arrayContaining([validate.id, hash.id]),
    );
    expect(store.search("hash_password")[0]?.node.id).toBe(hash.id);
    expect(store.search("session")[0]?.node.id).toBe(login.id);
    expect(store.search("auth service")[0]?.node.id).toBe(login.id);
    expect(store.search("  ")).toEqual([]);
    expect(store.search('"); DROP TABLE nodes; --')).toEqual([]);
    expect(store.stats().nodes).toBe(6);
  });

  it("exports and imports graphs, keeping ownership", () => {
    const graph = store.exportGraph("/repo");
    expect(graph.root).toBe("/repo");
    const copy = GraphStore.open(":memory:");
    copy.importGraph(graph);
    expect(copy.exportGraph().nodes).toEqual(graph.nodes);
    expect(copy.exportGraph().edges).toEqual(graph.edges);
    copy.replaceFile({ path: "src/c.ts", hash: "x", size: 1 }, [], []);
    expect(copy.getNode(hash.id)).toBeUndefined();
    expect(copy.getNode(login.id)).toEqual(login);
    copy.close();
  });

  it("persists to disk and rejects unknown schema versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "xray-store-"));
    try {
      const path = join(dir, "index.db");
      const disk = GraphStore.open(path);
      disk.replaceFile({ path: "src/c.ts", hash: "h3", size: 10 }, [c, hash], []);
      disk.close();
      const reopened = GraphStore.open(path);
      expect(reopened.getNode(hash.id)).toEqual(hash);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back failed transactions", () => {
    expect(() =>
      store.transaction(() => {
        store.removeFile("src/a.ts");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getNode(login.id)).toEqual(login);
  });

  it("nests transactions as savepoints", () => {
    store.transaction(() => {
      store.removeFile("src/c.ts");
      expect(() =>
        store.transaction(() => {
          store.removeFile("src/a.ts");
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(store.getNode(login.id)).toEqual(login);
    expect(store.getNode(hash.id)).toBeUndefined();
  });
});

describe("splitIdentifier", () => {
  it("splits camelCase, PascalCase, snake_case, acronyms and paths", () => {
    expect(splitIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
    expect(splitIdentifier("parseJSONBody")).toEqual(["parse", "json", "body"]);
    expect(splitIdentifier("__init__")).toEqual(["init"]);
    expect(splitIdentifier("src/user-repo.ts")).toEqual(["src", "user", "repo", "ts"]);
    expect(splitIdentifier("v2Api")).toEqual(["v2", "api"]);
  });
});
