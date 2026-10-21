import { existsSync } from "node:fs";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { ImpactOptions } from "@xray/analysis";
import type { EdgeKind } from "@xray/schema";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
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

const int = (value: unknown, fallback: number, min = 0, max = 1_000_000): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

const list = (value: unknown): string[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);

type Query = Record<string, unknown>;

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

  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `${what} not found` });
  const service = () => workspace.service();

  app.get("/api/meta", async () => (await service()).meta());
  app.get("/api/map", async () => (await service()).map());
  app.get<{ Querystring: Query }>("/api/roads", async (req) =>
    (await service()).roads(int(req.query.depth, 1, 0, 50)),
  );
  app.get<{ Querystring: Query }>("/api/node", async (req, reply) => {
    const details = (await service()).node(String(req.query.id ?? ""));
    return details ?? notFound(reply, "node");
  });
  app.get<{ Querystring: Query }>("/api/source", async (req, reply) => {
    const view = (await service()).source(
      String(req.query.file ?? ""),
      int(req.query.start, 1, 1),
      req.query.end === undefined ? Number.POSITIVE_INFINITY : int(req.query.end, 1, 1),
    );
    return view ?? notFound(reply, "source");
  });
  app.get<{ Querystring: Query }>("/api/search", async (req) =>
    (await service()).search(String(req.query.q ?? ""), int(req.query.limit, 20, 1, 200)),
  );
  app.get<{ Querystring: Query }>("/api/resolve", async (req) =>
    (await service()).resolve(String(req.query.q ?? "")),
  );
  app.get<{ Querystring: Query }>("/api/impact", async (req) => {
    const opts: ImpactOptions = { includeHeuristic: req.query.heuristic !== "false" };
    if (req.query.depth !== undefined) opts.maxDepth = int(req.query.depth, 10, 1, 100);
    return (await service()).impact(list(req.query.id), opts);
  });
  app.post<{ Body: unknown }>("/api/impact/diff", async (req) => {
    const diff =
      typeof req.body === "string"
        ? req.body
        : String((req.body as { diff?: unknown })?.diff ?? "");
    return (await service()).impactOfDiff(diff);
  });
  app.get<{ Querystring: Query }>("/api/trace", async (req) => {
    const kinds = list(req.query.kind) as EdgeKind[];
    return (await service()).trace(String(req.query.from ?? ""), String(req.query.to ?? ""), {
      k: int(req.query.k, 3, 1, 10),
      ...(kinds.length > 0 ? { kinds } : {}),
    });
  });
  app.get<{ Querystring: Query }>("/api/tree", async (req) =>
    (await service()).tree(
      String(req.query.id ?? ""),
      req.query.direction === "in" ? "in" : "out",
      int(req.query.depth, 3, 1, 8),
    ),
  );
  app.get<{ Querystring: Query }>("/api/cycles", async (req) =>
    (await service()).cycles({
      ignoreTypeOnly: req.query.ignoreTypeOnly === "true",
      ignoreDeferred: req.query.ignoreDeferred === "true",
    }),
  );
  app.get("/api/insights", async () => (await service()).insights());
  app.get<{ Querystring: Query }>("/api/dsm", async (req) =>
    (await service()).dsm(
      req.query.level === "directory" ? "directory" : "module",
      int(req.query.limit, 400, 1, 2000),
    ),
  );
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
