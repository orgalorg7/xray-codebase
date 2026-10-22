import { LANGUAGE_NAMES, type Language } from "@xray/schema";
import type { MapEntry } from "./build.js";

export type PageOptions = {
  /** The GitHub repository publishing the site (`owner/name`). */
  home?: string;
};

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

const count = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * Where the site lives on GitHub Pages: `/` for an `<owner>.github.io` repository, otherwise
 * `/<name>/`. Needed by the 404 page, which GitHub serves at any depth.
 */
export function siteBase(home: string | undefined): string {
  if (!home) return "/";
  const [owner = "", name = ""] = home.split("/");
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? "/" : `/${name}/`;
}

const STYLE = `
:root {
  --bg: #f6f8fa; --surface: #fff; --border: #d8dee4; --text: #1f2328; --muted: #59636e;
  --accent: #0969da; --on-accent: #fff;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8d96a0;
    --accent: #58a6ff; --on-accent: #0d1117;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--sans); }
a { color: var(--accent); }
header { display: flex; align-items: center; gap: 10px; padding: 14px 20px; background: var(--surface); border-bottom: 1px solid var(--border); }
header .name { font-weight: 700; font-size: 17px; color: var(--text); text-decoration: none; }
header .tagline { color: var(--muted); font-size: 13px; }
header nav { margin-left: auto; }
.logo { width: 24px; height: 24px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 36% 40%, #fff 0 22%, transparent 23%),
    radial-gradient(circle at 64% 62%, rgba(255,255,255,.6) 0 16%, transparent 17%), #3b5bdb; }
main { max-width: 1000px; margin: 0 auto; padding: 48px 16px 32px; }
h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 14px; }
.lead { font-size: 17px; color: var(--muted); max-width: 700px; margin: 0 0 24px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 44px; }
.button { display: inline-block; padding: 10px 18px; border-radius: 10px; font-weight: 600; text-decoration: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
h2 { font-size: 18px; margin: 0 0 14px; }
.maps { list-style: none; margin: 0 0 48px; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.maps a { display: flex; flex-direction: column; gap: 4px; height: 100%; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); text-decoration: none; }
.maps a:hover, .maps a:focus-visible { border-color: var(--accent); }
.repo { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats, .commit { font-size: 13px; color: var(--muted); }
.commit { font-family: var(--mono); font-size: 12px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.chip { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); }
.empty { color: var(--muted); }
.use { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 40px; }
.use div { padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.use h3 { margin: 0 0 6px; font-size: 15px; }
.use p { margin: 0; color: var(--muted); font-size: 14px; }
code { white-space: nowrap; font-family: var(--mono); font-size: 13px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
footer { text-align: center; color: var(--muted); font-size: 13px; padding: 20px 16px 32px; }
@media (max-width: 560px) { header .tagline { display: none; } main { padding-top: 28px; } }
`;

function layout(title: string, description: string, body: string, options: PageOptions): string {
  const base = siteBase(options.home);
  const github = options.home ? `https://github.com/${options.home}` : undefined;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%233b5bdb'/%3E%3Ccircle cx='12' cy='13' r='5' fill='%23fff' opacity='.9'/%3E%3Ccircle cx='20' cy='19' r='4' fill='%23fff' opacity='.6'/%3E%3C/svg%3E" />
<style>${STYLE}</style>
</head>
<body>
<header>
  <span class="logo" aria-hidden="true"></span>
  <a class="name" href="${base}">xray</a>
  <span class="tagline">Google Maps for codebases</span>
  ${github ? `<nav><a href="${github}">GitHub</a></nav>` : ""}
</header>
${body}
<footer>Static analysis only: xray reads code and never runs it. Maps open in your browser with no server.</footer>
</body>
</html>
`;
}

/** The start page: what xray is, the gallery of maps, and how to use it on your own code. */
export function renderIndex(maps: readonly MapEntry[], options: PageOptions = {}): string {
  const github = options.home ? `https://github.com/${options.home}` : undefined;
  const request = github ? `${github}/issues/new?template=map-request.yml` : undefined;
  const cards = maps
    .map((m) => {
      const languages = Object.keys(m.languages)
        .map((l) => `<span class="chip">${escapeHtml(LANGUAGE_NAMES[l as Language] ?? l)}</span>`)
        .join("");
      const at = m.ref === m.sha ? m.sha.slice(0, 7) : `${m.ref} @ ${m.sha.slice(0, 7)}`;
      return `<li><a href="${escapeHtml(m.path)}">
  <span class="repo">${escapeHtml(m.owner)}/<strong>${escapeHtml(m.repo)}</strong></span>
  <span class="stats">${count(m.files)} files · ${count(m.symbols)} symbols · ${count(m.edges)} links</span>
  <span class="commit">${escapeHtml(at)} · ${escapeHtml(m.mappedAt.slice(0, 10))}</span>
  <span class="chips">${languages}</span>
</a></li>`;
    })
    .join("\n");
  const body = `<main>
<h1>X-ray vision for any codebase</h1>
<p class="lead">Interactive maps of real projects: every file, class and function, what calls what,
circular imports, where a feature lives, and the blast radius of a change. Pick one and explore.</p>
<p class="actions">
  ${request ? `<a class="button primary" href="${request}">Request a map</a>` : ""}
  <a class="button" href="#use">Map your own code</a>
</p>
<h2>Maps</h2>
${maps.length > 0 ? `<ul class="maps">\n${cards}\n</ul>` : '<p class="empty">No maps yet.</p>'}
<h2 id="use">Map your own code</h2>
<div class="use">
  <div><h3>Command line</h3><p>In any repository of TypeScript, JavaScript, Python, Go, Java, Kotlin, Rust, C#, PHP or Ruby (Node 24+): <code>npx xray-codebase open</code></p></div>
  <div><h3>VS Code</h3><p>The map in an editor tab, callers above every function and the blast radius from the cursor.${github ? ` See <a href="${github}/tree/main/packages/vscode">the extension</a>.` : ""}</p></div>
  <div><h3>Pull requests</h3><p>A comment on each pull request with what the change reaches and which tests to run.${github ? ` See <a href="${github}#blast-radius-on-pull-requests">pr-impact</a>.` : ""}</p></div>
</div>
</main>`;
  return layout(
    "xray · X-ray vision for any codebase",
    `Interactive architecture maps of ${maps.length} open source projects, made by xray.`,
    body,
    options,
  );
}

/** GitHub Pages shows this for any missing path. */
export function renderNotFound(options: PageOptions = {}): string {
  const base = siteBase(options.home);
  return layout(
    "Not found · xray",
    "This page does not exist.",
    `<main><h1>Not found</h1><p class="lead">There is no map here (yet). <a href="${base}">See all maps</a>.</p></main>`,
    options,
  );
}
