import { existsSync } from "node:fs";
import { createCloud } from "./app.js";
import { loadConfig } from "./config.js";

/** Starts the hosted xray from its environment (see README for the variables). */
const config = loadConfig();
if (!existsSync(config.workerPath)) throw new Error(`no analysis worker at ${config.workerPath}`);
if (!existsSync(`${config.uiDir}/index.html`)) throw new Error(`no built UI in ${config.uiDir}`);

const cloud = await createCloud(config, { logger: true });
await cloud.app.listen({ port: config.port, host: config.host });

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  cloud.app.log.info(`${signal}: shutting down`);
  cloud.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
