import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Snapshot } from "@xray/service";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The built map UI. Looked up next to the CLI (published package), then in the monorepo, or
 * wherever XRAY_UI_DIR points.
 */
export function findUiDir(): string | undefined {
  const candidates = [
    process.env.XRAY_UI_DIR,
    join(here, "ui"),
    join(here, "..", "ui"),
    resolve(here, "..", "..", "ui", "dist"),
  ].filter((p): p is string => p !== undefined);
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}

/** The snapshot as embedded in an export: plain data, sources as a map. */
export type SnapshotData = Omit<Snapshot, "sources"> & { sources?: Record<string, string> };

const escapeScript = (text: string): string => text.replaceAll("</", "<\\/");

/**
 * A single self-contained HTML page: the map UI with its script and styles inlined and the
 * snapshot embedded (gzip + base64). Opens from disk, works offline, can be shared as a file.
 */
export function buildHtml(uiDir: string, snapshot: SnapshotData): string {
  let html = readFileSync(join(uiDir, "index.html"), "utf8");
  const asset = (ref: string) => readFileSync(join(uiDir, ref.replace(/^\.?\//, "")), "utf8");

  html = html.replace(
    /<script type="module" crossorigin src="([^"]+)"><\/script>/,
    (_, src: string) => {
      return `<script type="module">${escapeScript(asset(src))}</script>`;
    },
  );
  html = html.replace(
    /<link rel="stylesheet" crossorigin href="([^"]+)">/,
    (_, href: string) => `<style>${asset(href)}</style>`,
  );
  if (/<script[^>]+src=/.test(html) || /<link rel="stylesheet"/.test(html)) {
    throw new Error(
      "the UI build has unexpected external assets; rebuild it with the bundled config",
    );
  }

  const payload = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }).toString("base64");
  const data = `<script id="xray-snapshot" type="application/octet-stream">${payload}</script>`;
  const title = `<title>${snapshot.name.replace(/[<&]/g, "")} · xray</title>`;
  return html.replace(/<title>.*?<\/title>/, title).replace("</head>", `${data}\n</head>`);
}
