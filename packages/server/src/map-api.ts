import type { ImpactOptions } from "@xray/analysis";
import type { EdgeKind } from "@xray/schema";
import type { XrayService } from "@xray/service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type MapApiOptions = {
  /** The service answering a request; throw an error with `statusCode: 404` for unknown maps. */
  service: (request: FastifyRequest) => Promise<XrayService>;
};

const int = (value: unknown, fallback: number, min = 0, max = 1_000_000): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

const list = (value: unknown): string[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);

type Query = Record<string, unknown>;

/**
 * The read-only map API over one service: what the map UI asks for (meta, map, node, source,
 * search, impact, trace, …). Register it under a prefix, such as `/api`.
 */
export async function mapApi(app: FastifyInstance, options: MapApiOptions): Promise<void> {
  const { service } = options;
  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `${what} not found` });

  app.get("/meta", async (req) => (await service(req)).meta());
  app.get("/map", async (req) => (await service(req)).map());
  app.get<{ Querystring: Query }>("/roads", async (req) =>
    (await service(req)).roads(int(req.query.depth, 1, 0, 50)),
  );
  app.get<{ Querystring: Query }>("/node", async (req, reply) => {
    const details = (await service(req)).node(String(req.query.id ?? ""));
    return details ?? notFound(reply, "node");
  });
  app.get<{ Querystring: Query }>("/source", async (req, reply) => {
    const view = (await service(req)).source(
      String(req.query.file ?? ""),
      int(req.query.start, 1, 1),
      req.query.end === undefined ? Number.POSITIVE_INFINITY : int(req.query.end, 1, 1),
    );
    return view ?? notFound(reply, "source");
  });
  app.get<{ Querystring: Query }>("/search", async (req) =>
    (await service(req)).search(String(req.query.q ?? ""), int(req.query.limit, 20, 1, 200)),
  );
  app.get<{ Querystring: Query }>("/resolve", async (req) =>
    (await service(req)).resolve(String(req.query.q ?? "")),
  );
  app.get<{ Querystring: Query }>("/impact", async (req) => {
    const opts: ImpactOptions = { includeHeuristic: req.query.heuristic !== "false" };
    if (req.query.depth !== undefined) opts.maxDepth = int(req.query.depth, 10, 1, 100);
    return (await service(req)).impact(list(req.query.id), opts);
  });
  app.post<{ Body: unknown }>("/impact/diff", async (req) => {
    const diff =
      typeof req.body === "string"
        ? req.body
        : String((req.body as { diff?: unknown })?.diff ?? "");
    return (await service(req)).impactOfDiff(diff);
  });
  app.get<{ Querystring: Query }>("/trace", async (req) => {
    const kinds = list(req.query.kind) as EdgeKind[];
    return (await service(req)).trace(String(req.query.from ?? ""), String(req.query.to ?? ""), {
      k: int(req.query.k, 3, 1, 10),
      ...(kinds.length > 0 ? { kinds } : {}),
    });
  });
  app.get<{ Querystring: Query }>("/tree", async (req) =>
    (await service(req)).tree(
      String(req.query.id ?? ""),
      req.query.direction === "in" ? "in" : "out",
      int(req.query.depth, 3, 1, 8),
    ),
  );
  app.get<{ Querystring: Query }>("/cycles", async (req) =>
    (await service(req)).cycles({
      ignoreTypeOnly: req.query.ignoreTypeOnly === "true",
      ignoreDeferred: req.query.ignoreDeferred === "true",
    }),
  );
  app.get("/insights", async (req) => (await service(req)).insights());
  app.get<{ Querystring: Query }>("/dsm", async (req) =>
    (await service(req)).dsm(
      req.query.level === "directory" ? "directory" : "module",
      int(req.query.limit, 400, 1, 2000),
    ),
  );
}
