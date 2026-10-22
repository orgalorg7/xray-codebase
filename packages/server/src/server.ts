import { existsSync } from "node:fs";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { compareSnapshots, type DiffView } from "@xray/service";
import Fastify, { type FastifyInstance } from "fastify";
import { mapApi } from "./map-api.js";
import { commitOf, revisionsOf, serviceAt } from "./revisions.js";
import type { Workspace } from "./workspace.js";

export type ServerOptions = {
  workspace: Workspace;
  /** Directory of the built UI. Without it only the API is served. */
  uiDir?: string;
  /** Extra host names allowed in the Host header (besides localhost and 127.0.0.1). */
  allowedHosts?: string[];
  logger?: boolean;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The HTTP + WebSocket front of a workspace. All routes are read-only. Only local Host headers
 * are accepted, so a malicious web page cannot reach the API through DNS rebinding.
 */
export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { workspace } = options;
  const app = Fastify({ logger: options.logger ?? false });
  const allowed = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])]);

  app.addHook("onRequest", async (request, reply) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    if (!allowed.has(host)) {
      await reply.code(403).send({ error: `host ${host || "(none)"} is not allowed` });
    }
  });

  await app.register(compress, { threshold: 1024 });
  await app.register(websocket);

  await app.register(mapApi, { prefix: "/api", service: () => workspace.service() });
  // How the architecture changed since a revision (the map's Changes view). Mapping a revision
  // takes a full scan, so recent comparisons are kept.
  const diffs = new Map<string, Promise<DiffView>>();
  app.get("/api/revisions", async () => revisionsOf(workspace.root));
  app.get<{ Querystring: { base?: string } }>("/api/diff", async (req, reply) => {
    const base = String(req.query.base ?? "HEAD");
    let commit: string;
    try {
      commit = commitOf(workspace.root, base);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    const current = await workspace.service();
    const key = `${commit}\u0000${current.snapshot.scannedAt}`;
    let diff = diffs.get(key);
    if (!diff) {
      diff = serviceAt(workspace.root, commit).then(({ service }) =>
        compareSnapshots(service, current, { before: base, after: "the working tree" }),
      );
      diff.catch(() => diffs.delete(key));
      diffs.set(key, diff);
      if (diffs.size > 4) diffs.delete(diffs.keys().next().value as string);
    }
    return diff;
  });

  app.post("/api/rescan", async () => {
    const report = await workspace.scan();
    return {
      files: report.files,
      nodes: report.nodes,
      edges: report.edges,
      ms: Math.round(report.timings.total),
    };
  });

  // Live updates: the UI reloads its data when a rescan finishes.
  app.get("/api/events", { websocket: true }, (socket) => {
    const send = (message: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const onScanning = () => send({ type: "scanning" });
    const onScanned = (report: {
      files: number;
      timings: { total: number };
      changed: string[];
      added: string[];
      removed: string[];
    }) =>
      send({
        type: "scanned",
        files: report.files,
        ms: Math.round(report.timings.total),
        changed: report.changed.length + report.added.length + report.removed.length,
      });
    workspace.on("scanning", onScanning);
    workspace.on("scanned", onScanned);
    socket.on("close", () => {
      workspace.off("scanning", onScanning);
      workspace.off("scanned", onScanned);
    });
  });

  if (options.uiDir && existsSync(options.uiDir)) {
    // Files are looked up per request, so a rebuilt UI is served without a restart.
    await app.register(fastifyStatic, { root: options.uiDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "no such endpoint" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
