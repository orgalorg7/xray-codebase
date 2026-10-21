import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
