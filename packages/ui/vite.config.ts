import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * `slim-grammar:<lang>`: a Shiki grammar without the languages it embeds. Ruby's heredocs and
 * PHP's templates pull in a dozen other grammars (about 2.5 MB); without them those parts show
 * as plain strings and every page stays small.
 */
function slimGrammars(): Plugin {
  const prefix = "\0slim-grammar:";
  return {
    name: "xray-slim-grammars",
    resolveId: (id) => (id.startsWith("slim-grammar:") ? `\0${id}` : undefined),
    async load(id) {
      if (!id.startsWith(prefix)) return undefined;
      const name = id.slice(prefix.length);
      const grammars = (await import(`@shikijs/langs/${name}`)).default as {
        name: string;
        embeddedLangs?: unknown;
        embeddedLangsLazy?: unknown;
      }[];
      const own = grammars.find((g) => g.name === name);
      if (!own) throw new Error(`no Shiki grammar named ${name}`);
      const { embeddedLangs: _embedded, embeddedLangsLazy: _lazy, ...slim } = own;
      return `export default [${JSON.stringify(slim)}];`;
    },
  };
}

export default defineConfig({
  plugins: [react(), slimGrammars()],
  // Relative asset URLs, so the build works from any path and can be inlined into one file.
  base: "./",
  resolve: {
    // Workspace packages are consumed from source.
    conditions: ["development", "browser", "module", "import", "default"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One JS and one CSS file: `xray export --format html` inlines them into a single page.
    rolldownOptions: { output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 4000,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4400", ws: true },
    },
  },
});
