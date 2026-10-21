import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "@xray/testkit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer, Workspace } from "../src/index.js";

describe("server", () => {
  let dir: string;
  let workspace: Workspace;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "xray-server-"));
    cpSync(loadFixture("ts-reexports").dir, dir, { recursive: true });
    const ui = join(dir, "ui-dist");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>xray</title>");
    workspace = new Workspace({ root: dir, git: false });
    app = await createServer({ workspace, uiDir: ui });
  });

  afterEach(async () => {
    await app.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers: { host: "localhost:4400" } });
    return {
      status: res.statusCode,
      body: res.headers["content-type"]?.includes("json") ? res.json() : res.body,
    };
  };

  it("serves the API for the scanned repository", async () => {
    expect((await get("/api/meta")).body).toMatchObject({ stats: { files: 4 } });
    const map = (await get("/api/map")).body;
    expect(map.nodes.length).toBeGreaterThan(5);
    const id = encodeURIComponent("ts:src/app.ts#main");
    expect((await get(`/api/node?id=${id}`)).body.node.name).toBe("main");
    expect((await get("/api/node?id=nope")).status).toBe(404);
    expect((await get("/api/source?file=src/app.ts&start=3&end=3")).body.lines).toEqual([
      "export function main(): number {",
    ]);
    expect((await get("/api/source?file=package.json")).status).toBe(404);
    expect((await get("/api/search?q=multiply")).body.hits[0].node.name).toBe("multiply");
    expect((await get("/api/resolve?q=main")).body.map((s: { id: string }) => s.id)).toEqual([
      "ts:src/app.ts#main",
    ]);
    const add = encodeURIComponent("ts:src/utils/math.ts#add");
    expect((await get(`/api/impact?id=${add}&depth=1`)).body.impacted.length).toBe(4); // main, multiply and the two barrels
    expect((await get(`/api/trace?from=${id}&to=${add}&k=2`)).body.paths).toHaveLength(2);
    expect((await get(`/api/tree?id=${add}&direction=in`)).body.tree.children).toHaveLength(2);
    expect((await get("/api/cycles")).body).toEqual({ imports: [], calls: [] });
    expect((await get("/api/insights")).body).toHaveProperty("districts");
    expect((await get("/api/dsm?level=module")).body.items).toHaveLength(4);
    expect((await get("/api/roads?depth=2")).body.depth).toBe(2);
  });

  it("computes impact from a posted diff", async () => {
    const diff =
      "--- a/src/utils/math.ts\n+++ b/src/utils/math.ts\n@@ -2,1 +2,1 @@\n-  return a + b;\n+  return b + a;\n";
    const res = await app.inject({
      method: "POST",
      url: "/api/impact/diff",
      headers: { host: "127.0.0.1", "content-type": "text/plain" },
      payload: diff,
    });
    expect(res.json().changed.map((c: { id: string }) => c.id)).toEqual([
      "ts:src/utils/math.ts#add",
    ]);
  });

  it("rejects foreign Host headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { host: "evil.example:4400" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves the UI with an index fallback, but not for unknown API routes", async () => {
    expect((await get("/")).body).toContain("<title>xray</title>");
    expect((await get("/some/deep/link")).body).toContain("<title>xray</title>");
    expect((await get("/api/nope")).status).toBe(404);
  });

  it("serves UI files created after startup (a rebuilt UI needs no restart)", async () => {
    writeFileSync(join(dir, "ui-dist", "late.js"), "export {};\n");
    const res = await app.inject({
      method: "GET",
      url: "/late.js",
      headers: { host: "localhost" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
  });

  it("compresses large responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/map",
      headers: { host: "localhost", "accept-encoding": "gzip" },
    });
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("pushes scan events over the websocket", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    await workspace.service();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    const messages: { type: string }[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => socket.once("open", resolve));
    await app.inject({ method: "POST", url: "/api/rescan", headers: { host: "localhost" } });
    await expect.poll(() => messages.map((m) => m.type)).toEqual(["scanning", "scanned"]);
    socket.close();
  });
});

describe("Workspace", () => {
  it("persists its index and scans only once for concurrent first requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xray-ws-"));
    try {
      cpSync(loadFixture("py-classes").dir, dir, { recursive: true });
      const ws = new Workspace({ root: dir, git: false });
      let scans = 0;
      ws.on("scanning", () => scans++);
      const [a, b] = await Promise.all([ws.service(), ws.service()]);
      expect(a).toBe(b);
      expect(scans).toBe(1);
      ws.close();
      const reopened = new Workspace({ root: dir, git: false });
      expect(reopened.store.stats().files).toBe(2);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
