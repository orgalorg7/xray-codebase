import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meta, SourceView } from "@xray/service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { analyze } from "../src/analyze.js";
import { type Cloud, createCloud, type JobView } from "../src/app.js";
import { type CloudConfig, loadConfig } from "../src/config.js";
import { type Runner, workerRunner } from "../src/jobs.js";
import { Remotes } from "./remotes.js";

const remotes = new Remotes();
const shopSha = remotes.create("acme", "shop", "ts-classes");
remotes.create("acme", "tools", "py-packages");
const dataDir = mkdtempSync(join(tmpdir(), "xray-cloud-"));
const uiDir = join(dataDir, "ui");
mkdirSync(join(uiDir, "assets"), { recursive: true });
writeFileSync(
  join(uiDir, "index.html"),
  `<!doctype html><html><head><title>xray</title><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head><body><div id="root"></div></body></html>`,
);
writeFileSync(join(uiDir, "assets", "index-abc.js"), "console.log('map');\n");

const config: CloudConfig = {
  ...loadConfig({}),
  dataDir: join(dataDir, "data"),
  uiDir,
  remote: remotes.remote,
  protocols: "file",
  submitsPerHour: 4,
  refCacheMs: 0,
  lookupsPerMinute: 8,
  publicUrl: "https://xray.example.com",
};

/** Maps in this process (the worker process is tested separately below). */
const inProcess: Runner = async (repo, progress) => {
  const dir = mkdtempSync(join(tmpdir(), "xray-job-"));
  // Slow enough for a WebSocket to connect before mapping finishes.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return analyze(
    {
      ...repo,
      remote: config.remote.replace("{owner}", repo.owner).replace("{repo}", repo.repo),
      protocols: config.protocols,
      dbPath: join(config.dataDir, "xray-cloud.db"),
      dir,
      historyDepth: 0,
      maxBytes: 50 * 1024 ** 2,
      maxFiles: repo.repo === "tools" ? 2 : 1000,
      cloneTimeoutMs: 30_000,
    },
    progress,
  );
};

let cloud: Cloud;
beforeAll(async () => {
  cloud = await createCloud(config, { runner: inProcess });
});
afterAll(async () => {
  await cloud.close();
  remotes.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const submit = async (url: string, ip = "10.0.0.1") => {
  const response = await cloud.app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: { url },
    remoteAddress: ip,
  });
  return { status: response.statusCode, body: response.json() as JobView & { error?: string } };
};

const finished = (id: string) =>
  new Promise<JobView>((resolve) => {
    const check = () => {
      const job = cloud.queue.get(id);
      if (job && (job.state === "done" || job.state === "failed")) resolve(job as JobView);
      else setTimeout(check, 20);
    };
    check();
  });

describe("hosted xray", () => {
  it("maps a repository from its URL and serves the map at a permanent link", async () => {
    const first = await submit("https://github.com/ACME/shop");
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ owner: "acme", repo: "shop", sha: shopSha, ref: "main" });
    expect(first.body.path).toBe(`/github/acme/shop/${shopSha}`);
    const job = await finished(first.body.id as string);
    expect(job).toMatchObject({ state: "done", files: 4 });
    expect((await cloud.app.inject(`/api/jobs/${job.id}`)).json()).toMatchObject({ state: "done" });

    // Mapped once: the next request is answered from the store.
    const again = await submit("acme/shop");
    expect(again).toMatchObject({ status: 200, body: { state: "done", sha: shopSha } });

    const api = `/api/maps/acme/shop/${shopSha}`;
    const meta = (await cloud.app.inject(`${api}/meta`)).json() as Meta;
    expect(meta).toMatchObject({ name: "acme/shop", stats: { files: 4 } });
    expect(meta.root).toBe(`https://github.com/acme/shop/tree/${shopSha}`);
    const source = await cloud.app.inject(`${api}/source?file=src/user-repo.ts&start=1&end=3`);
    expect(source.headers["cache-control"]).toBe("public, max-age=3600");
    expect((source.json() as SourceView).lines.join("\n")).toContain("UserRepo");
    const search = (await cloud.app.inject(`${api}/search?q=user%20repo`)).json() as {
      hits: { node: { label: string } }[];
    };
    expect(search.hits[0]?.node.label).toMatch(/UserRepo/);
    expect((await cloud.app.inject(`/api/maps/acme/shop/${"0".repeat(40)}/meta`)).statusCode).toBe(
      404,
    );
    expect((await cloud.app.inject("/api/maps/acme/shop/not-a-sha/meta")).statusCode).toBe(404);

    const recent = (await cloud.app.inject("/api/recent")).json() as { path: string }[];
    expect(recent.map((r) => r.path)).toEqual([`/github/acme/shop/${shopSha}`]);
  });

  it("renders map, pending and start pages with share previews", async () => {
    const map = await cloud.app.inject(`/github/acme/shop/${shopSha}`);
    expect(map.statusCode).toBe(200);
    expect(map.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(map.headers["x-frame-options"]).toBe("DENY");
    expect(map.body).toContain('src="/assets/index-abc.js"');
    expect(map.body).toContain('href="/assets/index-abc.css"');
    expect(map.body).toContain('<meta name="xray-page" content="map" />');
    expect(map.body).toContain(`<meta name="xray-api" content="/api/maps/acme/shop/${shopSha}" />`);
    expect(map.body).toContain(
      `<meta name="xray-source" content="https://github.com/acme/shop/blob/${shopSha}/" />`,
    );
    expect(map.body).toContain("<title>acme/shop · xray</title>");
    expect(map.body).toContain(
      `<meta property="og:url" content="https://xray.example.com/github/acme/shop/${shopSha}" />`,
    );
    expect(map.body).toMatch(
      /og:description" content="Interactive map of acme\/shop \(main\): 4 files/,
    );

    const pending = await cloud.app.inject("/github/acme/tools/tree/main/src");
    expect(pending.body).toContain('<meta name="xray-page" content="pending" />');
    expect(pending.body).toContain(
      '<meta name="xray-target" content="https://github.com/acme/tools/tree/main/src" />',
    );
    const swapped = await cloud.app.inject("/github.com/acme/tools");
    expect(swapped).toMatchObject({ statusCode: 301, headers: { location: "/github/acme/tools" } });
    expect((await cloud.app.inject("/")).body).toContain('content="home"');
    const missing = await cloud.app.inject("/no/such/page");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('content="home"');
    expect((await cloud.app.inject("/assets/index-abc.js")).headers["cache-control"]).toContain(
      "immutable",
    );
    // Values from URLs are escaped in the page.
    const odd = await cloud.app.inject('/github/acme/shop/tree/a"b');
    expect(odd.body).not.toContain('a"b');
  });

  it("streams job progress over a WebSocket", async () => {
    await cloud.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = cloud.app.server.address() as { port: number };
    remotes.commit("acme", "shop", { "src/new.ts": "export const fresh = 1;\n" });
    const { body } = await submit("acme/shop", "10.0.0.2");
    expect(["queued", "cloning"]).toContain(body.state);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/jobs/${body.id}/events`);
    const states: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("message", (data) => states.push((JSON.parse(String(data)) as JobView).state));
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    expect(states.at(-1)).toBe("done");
    expect(states).toContain("scanning");
  });

  it("explains what it cannot map", async () => {
    expect(await submit("https://gitlab.com/a/b")).toMatchObject({ status: 400 });
    expect(await submit("acme/missing")).toMatchObject({
      status: 404,
      body: { error: "github.com/acme/missing was not found, or it is private" },
    });
    const tooMany = await submit("acme/tools", "10.0.0.3");
    const job = await finished(tooMany.body.id as string);
    expect(job.error).toMatch(/too many source files/);
    // A failed commit fails fast for a while.
    expect(await submit("acme/tools", "10.0.0.3")).toMatchObject({
      status: 422,
      body: { state: "failed", error: job.error },
    });
  });

  it("limits how many new maps one client may start", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      remotes.commit("acme", "shop", { [`src/n${i}.ts`]: `export const n${i} = ${i};\n` });
      const response = await submit("acme/shop", "10.0.0.9");
      last = response.status;
      if (response.body.id) await finished(response.body.id);
    }
    expect(last).toBe(429);
  });

  it("limits repository lookups, which each ask GitHub", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await submit("acme/missing", "10.0.0.10")).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(404));
    expect(statuses.slice(8)).toEqual([429, 429]);
  });
});

const workerPath = fileURLToPath(new URL("../dist/analyze.js", import.meta.url));

describe.skipIf(!existsSync(workerPath))("analysis worker process", () => {
  it("maps in a separate process and reports progress", async () => {
    const work = mkdtempSync(join(tmpdir(), "xray-worker-"));
    const runner = workerRunner({
      workerPath,
      remote: (owner, repo) => remotes.remote.replace("{owner}", owner).replace("{repo}", repo),
      workDir: work,
      heapMB: 512,
      protocols: "file",
      dbPath: join(work, "results.db"),
      historyDepth: 0,
      maxBytes: 50 * 1024 ** 2,
      maxFiles: 1000,
      cloneTimeoutMs: 30_000,
    });
    const states: string[] = [];
    const sha = remotes.git("acme", "tools", "rev-parse", "HEAD");
    const result = await runner(
      { owner: "acme", repo: "tools", sha, ref: "main" },
      (p) => states.push(p.state),
      new AbortController().signal,
    );
    expect(result.files).toBeGreaterThan(2);
    expect(states).toEqual(expect.arrayContaining(["cloning", "scanning", "saving"]));

    // Cancelling kills the process and cleans up its checkout.
    const controller = new AbortController();
    const cancelled = runner(
      { owner: "acme", repo: "tools", sha, ref: "main" },
      () => controller.abort(),
      controller.signal,
    );
    await expect(cancelled).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(readdirSync(work).filter((f) => !f.startsWith("results.db"))).toEqual([]);
    rmSync(work, { recursive: true, force: true });
  });
});
