import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { mapApi } from "@xray/server";
import { XrayService } from "@xray/service";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CloudConfig } from "./config.js";
import {
  isSha,
  NotFoundError,
  parseRepo,
  type RepoTarget,
  type ResolvedRepo,
  resolveRepo,
} from "./github.js";
import { JobQueue, type JobStatus, QueueError, type Runner, workerRunner } from "./jobs.js";
import { RateLimiter } from "./limits.js";
import { mapPath, type Page, PageRenderer } from "./pages.js";
import { type MapKey, type MapRecord, mapSlug, ResultStore } from "./results.js";

export type Cloud = {
  app: FastifyInstance;
  queue: JobQueue;
  store: ResultStore;
  close(): Promise<void>;
};

/** What clients get back about mapping a repository. */
export type JobView = Partial<JobStatus> &
  Pick<JobStatus, "owner" | "repo" | "sha" | "ref" | "state"> & {
    /** The map page, once done. */
    path: string;
  };

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/**
 * The hosted xray: people submit a public GitHub repository, a worker maps one commit of it, and
 * everyone gets the same map UI over the stored result at a permanent link.
 */
export async function createCloud(
  config: CloudConfig,
  overrides: { runner?: Runner; logger?: boolean } = {},
): Promise<Cloud> {
  const dbPath = join(config.dataDir, "xray-cloud.db");
  const workDir = join(config.dataDir, "work");
  rmSync(workDir, { recursive: true, force: true }); // checkouts left by a previous run
  mkdirSync(workDir, { recursive: true });
  const store = ResultStore.open(dbPath);
  const remote = (owner: string, repo: string) =>
    config.remote.replaceAll("{owner}", owner).replaceAll("{repo}", repo);

  const queue = new JobQueue({
    concurrency: config.concurrency,
    maxQueued: config.maxQueued,
    maxPerClient: config.maxPerClient,
    timeoutMs: config.jobTimeoutMs,
    runner:
      overrides.runner ??
      workerRunner({
        workerPath: config.workerPath,
        remote,
        workDir,
        heapMB: config.workerHeapMB,
        protocols: config.protocols,
        dbPath,
        historyDepth: config.historyDepth,
        maxBytes: config.maxRepoMB * 1024 ** 2,
        maxFiles: config.maxFiles,
        cloneTimeoutMs: Math.min(config.jobTimeoutMs, 5 * 60_000),
      }),
  });

  // Loaded maps, least recently used first.
  const services = new Map<string, Promise<XrayService>>();
  const serviceFor = (key: MapKey): Promise<XrayService> => {
    const slug = mapSlug(key);
    let service = services.get(slug);
    if (service) services.delete(slug);
    else {
      const snapshot = store.snapshot(key);
      if (!snapshot) throw httpError(404, "map not found");
      service = Promise.resolve(new XrayService(snapshot));
    }
    services.set(slug, service);
    while (services.size > config.cachedMaps)
      services.delete(services.keys().next().value as string);
    return service;
  };

  // Every open progress socket listens to the queue.
  queue.setMaxListeners(0);
  queue.on("finished", (job) => {
    const key = { owner: job.owner, repo: job.repo, sha: job.sha };
    if (job.state === "done") {
      services.delete(mapSlug(key));
      store.prune(config.maxStorageMB * 1024 ** 2, key);
    } else store.fail(key, job.error ?? "mapping failed");
  });

  // Branch and tag lookups, briefly cached so a burst of visits makes one `git ls-remote`.
  const resolved = new Map<string, { at: number; repo: Promise<ResolvedRepo> }>();
  const resolve = (target: RepoTarget): Promise<ResolvedRepo> => {
    const key = JSON.stringify(target);
    const cached = resolved.get(key);
    if (cached && Date.now() - cached.at < config.refCacheMs) return cached.repo;
    const repo = resolveRepo(target, { remote, protocols: config.protocols });
    resolved.set(key, { at: Date.now(), repo });
    repo.catch(() => resolved.delete(key));
    if (resolved.size > 1000) resolved.delete(resolved.keys().next().value as string);
    return repo;
  };

  const app = Fastify({
    logger: overrides.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
  });
  const pages = new PageRenderer(config.uiDir, config.publicUrl);
  const api = new RateLimiter({ capacity: config.requestsPerMinute, windowMs: 60_000 });
  const submits = new RateLimiter({ capacity: config.submitsPerHour, windowMs: 3_600_000 });
  const lookups = new RateLimiter({ capacity: config.lookupsPerMinute, windowMs: 60_000 });

  const limited = (reply: FastifyReply, seconds: number) =>
    reply
      .code(429)
      .header("retry-after", String(seconds))
      .send({ error: `too many requests; try again in ${seconds} s` });

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    if (request.url.startsWith("/api/")) {
      const wait = api.take(request.ip);
      if (wait > 0) return limited(reply, wait);
    }
  });

  await app.register(compress, { threshold: 1024 });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(fastifyStatic, {
    root: join(config.uiDir, "assets"),
    prefix: "/assets/",
    // Asset names carry a content hash.
    immutable: true,
    maxAge: "365d",
  });

  const view = (job: JobStatus): JobView => ({ ...job, path: mapPath(job) });
  const done = (map: MapRecord): JobView => ({
    owner: map.owner,
    repo: map.repo,
    sha: map.sha,
    ref: map.ref,
    state: "done",
    files: map.files,
    path: mapPath(map),
  });

  // ---- mapping jobs ------------------------------------------------------------------------
  app.post<{ Body: { url?: unknown } }>("/api/jobs", async (request, reply) => {
    const url = typeof request.body?.url === "string" ? request.body.url : "";
    const target = parseRepo(url);
    const lookupWait = lookups.take(request.ip);
    if (lookupWait > 0) return limited(reply, lookupWait);
    if (!target) {
      return reply.code(400).send({
        error: "That is not a GitHub repository. Paste a link like github.com/owner/repo.",
      });
    }
    let repo: ResolvedRepo;
    try {
      repo = await resolve(target);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      request.log.warn(error);
      return reply.code(502).send({ error: "GitHub could not be reached; try again shortly." });
    }
    const existing = store.get(repo);
    if (existing) return done(existing);
    const failure = store.failure(repo, config.failureCacheMs);
    if (failure) {
      return reply
        .code(422)
        .send({ ...repo, state: "failed", error: failure, path: mapPath(repo) });
    }
    // Only new work counts against the hourly limit; opening existing maps is free.
    const wait = submits.take(request.ip);
    if (wait > 0) return limited(reply, wait);
    try {
      return reply.code(202).send(view(queue.submit(repo, request.ip)));
    } catch (error) {
      if (error instanceof QueueError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = queue.get(request.params.id);
    return job ? view(job) : reply.code(404).send({ error: "no such job" });
  });

  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/events",
    { websocket: true },
    (socket, request) => {
      const send = (job: JobStatus) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(view(job)));
        if (job.state === "done" || job.state === "failed") socket.close();
      };
      const id = request.params.id;
      const job = queue.get(id);
      if (!job) {
        socket.close(4404, "no such job");
        return;
      }
      const onUpdate = (update: JobStatus) => {
        if (update.id === id) send(update);
      };
      queue.on("update", onUpdate);
      socket.on("close", () => queue.off("update", onUpdate));
      send(job);
    },
  );

  // ---- maps --------------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/recent", async (request) => {
    const limit = Math.min(48, Math.max(1, Number(request.query.limit) || 12));
    return store.recent(limit).map((map) => ({ ...map, path: mapPath(map) }));
  });

  app.get("/api/health", async () => ({ ok: true, ...queue.stats, ...store.count() }));

  const viewed = new Map<string, number>();
  const mapKey = (request: FastifyRequest): MapKey => {
    const { owner, repo, sha } = request.params as Record<string, string>;
    const target = parseRepo(`${owner}/${repo}`);
    if (!target || !isSha(sha ?? "")) throw httpError(404, "map not found");
    return { owner: target.owner, repo: target.repo, sha: sha as string };
  };
  await app.register(
    async (maps) => {
      // A commit's map never changes.
      maps.addHook("onSend", async (_request, reply) => {
        if (reply.statusCode === 200) reply.header("cache-control", "public, max-age=3600");
      });
      await maps.register(mapApi, {
        service: (request) => {
          const key = mapKey(request);
          const slug = mapSlug(key);
          // Count a view at most every ten minutes per map, not on every request.
          if (Date.now() - (viewed.get(slug) ?? 0) > 600_000) {
            viewed.set(slug, Date.now());
            store.touch(key);
          }
          return serviceFor(key);
        },
      });
    },
    { prefix: "/api/maps/:owner/:repo/:sha" },
  );

  // ---- pages -------------------------------------------------------------------------------
  const sendPage = (reply: FastifyReply, page: Page, path: string, status = 200) =>
    reply
      .code(status)
      .type("text/html; charset=utf-8")
      .header("content-security-policy", CONTENT_SECURITY_POLICY)
      .header("cache-control", "no-cache")
      .send(pages.render(page, path));

  app.get("/", async (request, reply) => sendPage(reply, { kind: "home" }, request.url));

  // /github/<owner>/<repo>[/<sha> | /tree/<ref> | /commit/<sha> | /<ref>]: a map, or a page
  // that maps the repository and then opens it.
  app.get<{ Params: { "*": string } }>("/github/*", async (request, reply) => {
    const [owner = "", repo = "", ...rest] = request.params["*"].split("/").filter(Boolean);
    let path = rest.join("/");
    if (/^(tree|blob)\//.test(path)) path = path.slice(5);
    if (path.startsWith("commit/")) path = path.slice(7);
    const target = parseRepo(`${owner}/${repo}`);
    if (!target) return sendPage(reply, { kind: "home" }, request.url, 404);
    if (isSha(path)) {
      const map = store.get({ ...target, sha: path });
      if (map) return sendPage(reply, { kind: "map", map }, request.url);
    }
    const github = `https://github.com/${target.owner}/${target.repo}`;
    return sendPage(
      reply,
      {
        kind: "pending",
        owner: target.owner,
        repo: target.repo,
        target: path ? `${github}/${isSha(path) ? "commit" : "tree"}/${path}` : github,
      },
      request.url,
    );
  });

  // Swap "github.com" for this site's address in any GitHub link to map it.
  app.get<{ Params: { "*": string } }>("/github.com/*", async (request, reply) =>
    reply.redirect(`/github/${request.params["*"]}`, 301),
  );

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "no such endpoint" });
    return sendPage(reply, { kind: "home" }, request.url, 404);
  });

  return {
    app,
    queue,
    store,
    async close() {
      queue.close();
      await app.close();
      store.close();
    },
  };
}
