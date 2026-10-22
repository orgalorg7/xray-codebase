// Builds the extension into dist/ and media/: everything is bundled, so the .vsix needs no
// node_modules. The worker is CommonJS because the bundled TypeScript compiler locates its lib
// files next to its own script (__dirname), which therefore ship beside it.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const require = createRequire(join(here, "package.json"));
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "grammars"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  conditions: ["development"],
  logLevel: "warning",
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: [join(here, "src", "extension.ts")],
  outfile: join(dist, "extension.js"),
  format: "cjs",
  external: ["vscode"],
});

await build({
  ...common,
  entryPoints: [join(here, "src", "worker.ts")],
  outfile: join(dist, "worker.cjs"),
  format: "cjs",
  // ESM code (web-tree-sitter, our plugins) asks for its own URL to find .wasm files.
  define: { "import.meta.url": "__xrayImportMetaUrl" },
  banner: { js: 'const __xrayImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});

// Runtime assets next to the worker: tree-sitter's runtime and grammars, TypeScript's libs.
cpSync(require.resolve("web-tree-sitter/web-tree-sitter.wasm"), join(dist, "web-tree-sitter.wasm"));
cpSync(
  require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
  join(dist, "grammars", "tree-sitter-python.wasm"),
);
// Go, Java, Kotlin, Rust, C#, PHP and Ruby grammars.
const languagesDir = join(join(here, "..", ".."), "packages", "languages");
const { GRAMMARS } = await import(pathToFileURL(join(languagesDir, "dist", "index.js")).href);
const fromLanguages = createRequire(join(languagesDir, "package.json"));
for (const grammar of GRAMMARS) {
  cpSync(
    fromLanguages.resolve(`${grammar.package}/${grammar.file}`),
    join(dist, "grammars", grammar.file),
  );
}
const tsLib = dirname(require.resolve("typescript"));
for (const file of readdirSync(tsLib)) {
  if (/^lib\..*\.d\.ts$|^lib\.d\.ts$/.test(file)) cpSync(join(tsLib, file), join(dist, file));
}

// The map UI.
const ui = join(here, "..", "ui", "dist");
if (!existsSync(join(ui, "index.html")))
  throw new Error("build the UI first: pnpm --filter @xray/ui build");
rmSync(join(here, "media", "ui"), { recursive: true, force: true });
cpSync(ui, join(here, "media", "ui"), { recursive: true });

cpSync(join(here, "..", "..", "LICENSE"), join(here, "LICENSE"));
console.log(watch ? "built (watch not supported; rerun to rebuild)" : "built xray-vscode");
