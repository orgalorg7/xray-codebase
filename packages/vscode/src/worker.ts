/**
 * The analysis process. Runs the xray engine outside the extension host, so a long scan or a
 * large type-check never slows down the editor or other extensions. Speaks the protocol in
 * protocol.ts over the Node IPC channel.
 */
import type { Request, WorkerMessage, WorkerOptions } from "./protocol.js";
import { WORKER_OPTIONS_ENV } from "./protocol.js";

const send = (message: WorkerMessage): void => {
  process.send?.(message);
};

async function main(): Promise<void> {
  try {
    await import("node:sqlite");
  } catch {
    send({
      type: "fatal",
      message: `xray needs a Node.js runtime with SQLite (Node 22.13 or newer); this VS Code runs Node ${process.versions.node}. Update VS Code to use xray.`,
    });
    process.exit(1);
  }
  const options = JSON.parse(process.env[WORKER_OPTIONS_ENV] ?? "{}") as WorkerOptions;
  const { Workspace } = await import("@xray/server/workspace");
  const { createHandlers } = await import("./handlers.js");
  const workspace = new Workspace({
    root: options.root,
    indexPath: options.indexPath,
    ignore: options.ignore,
  });
  const handlers = createHandlers(workspace);

  workspace.on("scanning", () => send({ type: "event", event: { type: "scanning" } }));
  workspace.on("scanned", (report) =>
    send({
      type: "event",
      event: {
        type: "scanned",
        files: report.files,
        ms: Math.round(report.timings.total),
        changed: report.added.length + report.changed.length + report.removed.length,
      },
    }),
  );
  workspace.on("error", (error) =>
    send({
      type: "event",
      event: { type: "error", message: error instanceof Error ? error.message : String(error) },
    }),
  );

  process.on("message", async (message: Request) => {
    if (message?.type !== "request") return;
    const handler = handlers[message.method];
    try {
      if (!handler) throw new Error(`unknown method ${message.method}`);
      const result = await (handler as (...args: unknown[]) => unknown)(...message.args);
      send({ type: "response", id: message.id, result });
    } catch (error) {
      send({
        type: "response",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // The first scan starts right away; requests made meanwhile wait for it.
  await workspace.service();
  if (options.watch) workspace.watch();

  const shutdown = () => {
    workspace.close();
    process.exit(0);
  };
  process.on("disconnect", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
