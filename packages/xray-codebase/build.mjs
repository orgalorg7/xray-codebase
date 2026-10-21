// Bundles the CLI and every @xray workspace package into dist/xray.js, next to the built map
// UI (dist/ui) and the Python grammar (dist/grammars). npm dependencies stay external.
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(here, "dist");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "grammars"), { recursive: true });

await build({
  entryPoints: [join(root, "packages", "cli", "src", "bin.ts")],
  outfile: join(dist, "xray.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Workspace packages are bundled from source.
  conditions: ["development"],
  external: Object.keys(pkg.dependencies),
  sourcemap: true,
  legalComments: "linked",
  logLevel: "warning",
});
chmodSync(join(dist, "xray.js"), 0o755);

const uiDist = join(root, "packages", "ui", "dist");
cpSync(uiDist, join(dist, "ui"), { recursive: true });

const require = createRequire(join(root, "packages", "lang-python", "package.json"));
cpSync(
  require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
  join(dist, "grammars", "tree-sitter-python.wasm"),
);

cpSync(join(root, "LICENSE"), join(here, "LICENSE"));
console.log(`built ${pkg.name}@${pkg.version} in ${dist}`);
