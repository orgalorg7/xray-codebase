import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "@xray/server/workspace";
import type { FileSymbol, Meta, NodeDetails, Summary } from "@xray/service";
import { loadFixture } from "@xray/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerClient } from "../src/client.js";
import { createHandlers } from "../src/handlers.js";
import type { WorkerEvent } from "../src/protocol.js";

const workerPath = fileURLToPath(new URL("../dist/worker.cjs", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xray-vscode-"));
  cpSync(loadFixture("ts-classes").dir, join(dir, "repo"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("handlers", () => {
  it("answer map and editor requests", async () => {
    const workspace = new Workspace({ root: join(dir, "repo"), indexPath: ":memory:", git: false });
    const h = createHandlers(workspace) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const symbols = (await h.fileSymbols?.("src/user-repo.ts")) as FileSymbol[];
    expect(symbols.map((s) => s.label)).toEqual(["UserRepo", "UserRepo.find", "UserRepo.add"]);
    const found = (await h.symbolAt?.("src/user-repo.ts", 7)) as Summary;
    expect(found.id).toBe("ts:src/user-repo.ts#UserRepo.find");
    expect(await h.symbolAt?.("src/user-repo.ts", 999)).toMatchObject({ kind: "module" });
    const impact = (await h.impact?.({ ids: ["ts:src/user-repo.ts#UserRepo.find"], depth: 1 })) as {
      impacted: unknown[];
    };
    expect(impact.impacted.length).toBeGreaterThan(0);
    expect(await h.scan?.(true)).toMatchObject({ files: 4 });
    workspace.close();
  });
});

describe.skipIf(!existsSync(workerPath))("worker process", () => {
  it("serves requests over IPC, pushes rescans and reports bad methods", async () => {
    const client = new WorkerClient({
      workerPath,
      root: join(dir, "repo"),
      indexPath: join(dir, "index.db"),
      watch: true,
      ignore: [],
      maxMemoryMB: 1024,
    });
    const events: WorkerEvent[] = [];
    client.onEvent((event) => {
      if (event.type !== "navigate") events.push(event);
    });
    try {
      const meta = await client.request<Meta>("meta");
      expect(meta.stats.files).toBe(4);
      const details = await client.request<NodeDetails>("node", "ts:src/service.ts#lookup");
      expect(details.outgoing.find((e) => e.kind === "calls")?.other.id).toBe(
        "ts:src/repository.ts#Repository.find",
      );
      await expect(client.request("nope")).rejects.toThrow("unknown method nope");

      // Watch mode: a new file is picked up and announced (the initial scan's event says 4).
      writeFileSync(join(dir, "repo", "src", "extra.ts"), "export const extra = 1;\n");
      await expect
        .poll(() => events.some((e) => e.type === "scanned" && e.files === 5), { timeout: 10_000 })
        .toBe(true);
      expect((await client.request<Meta>("meta")).stats.files).toBe(5);
    } finally {
      client.dispose();
    }
    await expect(client.request("meta")).rejects.toThrow("shut down");
  });

  it("restarts after the worker dies", async () => {
    const client = new WorkerClient({
      workerPath,
      root: join(dir, "repo"),
      indexPath: join(dir, "index.db"),
      watch: false,
      ignore: [],
      maxMemoryMB: 1024,
    });
    try {
      expect((await client.request<Meta>("meta")).stats.files).toBe(4);
      // Simulate a crash: a request in flight fails with a clear reason, the next one works.
      const inFlight = client.request("scan", true);
      process.kill(client.pid as number, "SIGKILL");
      await expect(inFlight).rejects.toThrow(/xray worker stopped/);
      expect((await client.request<Meta>("meta")).stats.files).toBe(4);
    } finally {
      client.dispose();
    }
  });
});
