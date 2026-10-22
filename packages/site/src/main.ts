import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findUiDir } from "@xray/cli";
import { addRepo, buildSite, readRepos } from "./build.js";

const USAGE = `xray site build [--repos repos.json] [--out _site] [--home owner/name]
xray site add <repository> [--repos repos.json]`;

const defaultRepos = fileURLToPath(new URL("../repos.json", import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repos: { type: "string", default: defaultRepos },
    out: { type: "string", default: "_site" },
    home: { type: "string" },
  },
});
const [command, ...rest] = positionals;

if (command === "add") {
  try {
    // One line for scripts: "added owner/repo" or "listed owner/repo".
    const { entry, added } = addRepo(values.repos, rest[0] ?? "");
    console.log(`${added ? "added" : "listed"} ${entry.repo}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (command === "build") {
  const uiDir = findUiDir();
  if (!uiDir) throw new Error("build the UI first (pnpm build)");
  const result = await buildSite({
    repos: readRepos(values.repos),
    outDir: resolve(values.out),
    uiDir,
    workDir: join(tmpdir(), "xray-site"),
    ...(values.home ? { home: values.home } : {}),
    log: (line) => console.log(line),
  });
  console.log(`${result.maps.length} maps, ${result.failed.length} failed`);
  // A failed repository is left out; the site fails only if nothing could be mapped.
  if (result.maps.length === 0 && result.failed.length > 0) process.exitCode = 1;
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
