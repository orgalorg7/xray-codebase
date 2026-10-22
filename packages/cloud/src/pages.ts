import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MapRecord } from "./results.js";

/** What a page shows: the start page, a map, or a repository being mapped. */
export type Page =
  | { kind: "home" }
  | { kind: "map"; map: MapRecord }
  /** `target` is the GitHub URL the page asks to map, then opens. */
  | { kind: "pending"; owner: string; repo: string; target: string };

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export const mapPath = (map: { owner: string; repo: string; sha: string }): string =>
  `/github/${map.owner}/${map.repo}/${map.sha}`;

const LANGUAGE_NAMES: Record<string, string> = { ts: "TypeScript", js: "JavaScript", py: "Python" };

/** "1,234 files of TypeScript and Python, 9,876 symbols and 20,123 links between them" */
export function describeMap(map: MapRecord): string {
  const languages = new Intl.ListFormat("en").format(
    Object.keys(map.languages).map((l) => LANGUAGE_NAMES[l] ?? l),
  );
  return `${map.files.toLocaleString("en")} files${languages ? ` of ${languages}` : ""}, ${map.symbols.toLocaleString("en")} symbols and ${map.edges.toLocaleString("en")} links between them`;
}

/**
 * Renders pages from the UI's index.html: asset URLs made absolute (pages live at any depth),
 * and what the page is about passed in `<meta>` tags, which the UI reads at start-up. The tags
 * also give link previews (Open Graph) when a map is shared.
 */
export class PageRenderer {
  readonly #indexPath: string;
  readonly #publicUrl: string | undefined;
  #template: { html: string; mtimeMs: number } | undefined;

  constructor(uiDir: string, publicUrl?: string) {
    this.#indexPath = join(uiDir, "index.html");
    this.#publicUrl = publicUrl;
  }

  #html(): string {
    const { mtimeMs } = statSync(this.#indexPath);
    if (this.#template?.mtimeMs !== mtimeMs) {
      const html = readFileSync(this.#indexPath, "utf8").replace(
        /(src|href)="\.\/assets\//g,
        '$1="/assets/',
      );
      this.#template = { html, mtimeMs };
    }
    return this.#template.html;
  }

  render(page: Page, path: string): string {
    const meta: Record<string, string> = { "xray-page": page.kind };
    let title = "xray · X-ray vision for any codebase";
    let description =
      "Paste a GitHub repository and get an interactive map of its architecture: every file, class and function, what calls what, import cycles, and the blast radius of a change.";
    if (page.kind === "map") {
      const { map } = page;
      const repo = `${map.owner}/${map.repo}`;
      meta["xray-api"] = `/api/maps/${map.owner}/${map.repo}/${map.sha}`;
      meta["xray-repo"] = repo;
      meta["xray-ref"] = map.ref;
      meta["xray-source"] = `https://github.com/${repo}/blob/${map.sha}/`;
      title = `${repo} · xray`;
      description = `Interactive map of ${repo} (${map.ref === map.sha ? map.sha.slice(0, 7) : map.ref}): ${describeMap(map)}.`;
    } else if (page.kind === "pending") {
      meta["xray-repo"] = `${page.owner}/${page.repo}`;
      meta["xray-target"] = page.target;
      title = `Mapping ${page.owner}/${page.repo} · xray`;
      description = `An interactive architecture map of ${page.owner}/${page.repo}, made by xray.`;
    }
    const og: Record<string, string> = {
      "og:title": title.replace(/ · xray$/, ""),
      "og:description": description,
      "og:type": "website",
      "og:site_name": "xray",
      ...(this.#publicUrl ? { "og:url": `${this.#publicUrl}${path}` } : {}),
    };
    const tags = [
      ...Object.entries(meta).map(([n, v]) => `<meta name="${n}" content="${escapeHtml(v)}" />`),
      `<meta name="description" content="${escapeHtml(description)}" />`,
      ...Object.entries(og).map(([p, v]) => `<meta property="${p}" content="${escapeHtml(v)}" />`),
      `<meta name="twitter:card" content="summary" />`,
    ].join("\n    ");
    return this.#html()
      .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
      .replace("</head>", `    ${tags}\n  </head>`);
  }
}
