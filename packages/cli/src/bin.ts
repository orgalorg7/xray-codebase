#!/usr/bin/env node
import { spawn } from "node:child_process";
import { totalmem } from "node:os";

// Type-checking a large monorepo (several apps, each with its own node_modules types) can need far
// more heap than Node's default of about 2 GB. Unless the user already chose a limit, run once more
// with half of this machine's memory, between 2 and 8 GB.
const heapChosen = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)].some(
  (arg) => arg.startsWith("--max-old-space-size"),
);
if (!heapChosen && process.env.XRAY_HEAP_SET !== "1") {
  const megabytes = Math.max(2048, Math.min(8192, Math.floor(totalmem() / 2 ** 21)));
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${megabytes}`, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, XRAY_HEAP_SET: "1" } },
  );
  // Stopping this process (Ctrl+C, an editor task, `kill`) stops the real one too.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  child.on("exit", (code, signal) => {
    for (const name of signals) process.off(name, forward);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const { main } = await import("./cli.js");
  const color =
    process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    color,
  });
  process.exitCode = code;
}
