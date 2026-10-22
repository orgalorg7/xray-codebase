# xray

**X-ray vision for any codebase.** Point xray at an unfamiliar repository and get a zoomable,
Google-Maps-style map of everything in it: packages → files → classes → functions, and every
import, call, inheritance link and reference between them.

- **Directions:** trace how one function reaches another, across files.
- **Dependencies:** see the full import graph and every circular import.
- **Where does this live?** Find a feature's code from a plain-language query.
- **Blast radius:** see everything a change to a function can affect, including routes, CLI commands and tests.

xray is static analysis only. It never runs your code, needs no AI or network, and gives the
same results on every run. Each link says how sure the analyzer is: resolved exactly, inferred
from types or assignments, or guessed by name.

Languages: TypeScript/JavaScript and Python.

## Quick start

In any TypeScript, JavaScript or Python repository (Node 24 or newer):

```sh
npx xray-codebase open
```

`xray open` scans the repository (the index lives in `<repo>/.xray/`, so add `.xray/` to its
`.gitignore`), starts a local server on 127.0.0.1 and opens the map. It rescans as files change.
Later commands reuse the index while no file has changed.

From a checkout of this repository: `pnpm install && pnpm build`, then
`node packages/cli/dist/bin.js open path/to/some/repo`.

xray comes in three forms that share one engine and one map:

- **Command line:** `npx xray-codebase` (this section and [Commands](#commands)).
- **VS Code:** the map in an editor tab, caller counts and blast radius above every function,
  xray in hovers, and insights in the sidebar. See [packages/vscode](packages/vscode/README.md).
- **Hosted:** paste a public GitHub repository and share its map by link. In any GitHub link,
  replace `github.com` with the site's address. See [packages/cloud](packages/cloud/README.md)
  to run it.

**See it without installing anything:** the [gallery](https://orgalorg7.github.io/xray-codebase/)
has maps of express, zod, fastapi, flask, xray itself and more. It is rebuilt weekly from
[packages/site/repos.json](packages/site/repos.json), and anyone can
[request a map](https://github.com/orgalorg7/xray-codebase/issues/new?template=map-request.yml).

## The map

The map nests code like places: directories are regions, files are cities, classes and functions
are buildings, sized by lines of code and tinted by **district** (groups of files that depend on
each other). Lines between areas are dependency **roads**, drawn for whatever is readable at the
current zoom.

| View | What it answers |
| --- | --- |
| **Explore** | What is this? Signature, docs, source, callers and callees, inheritance, history |
| **Search** | "where is login handled": best matches, their files, entry points and tests |
| **Directions** | How does A reach B? The cheapest call routes, step by step |
| **Blast radius** | What breaks if this changes? Dependents by distance, entry points, tests, risk |
| **Cycles** | Which files import each other in a loop, and which imports to cut |
| **Insights** | Hotspot files, large classes, dead code, unused exports, districts, churn |
| **Matrix** | The dependency structure matrix: layering at a glance |

Layers add import cycles, git churn, dead code and untested code on top of the map. Every view
is in the URL, so links can be shared. Press `?` in the map for keyboard shortcuts.

## Commands

```text
xray open [dir]              Scan and open the interactive map
xray scan [dir]              Build or update the index
xray where <query>           Find where a feature lives
xray impact <symbol...>      What may break if these change
xray impact --diff [ref]     ...or if the changes since a git ref land
xray trace <from> <to>       Call routes from one symbol to another
xray cycles                  Circular imports with suggested cuts
xray check                   Enforce .xray.json rules in CI
xray export --format F       json, html (one offline file), dot, mermaid or graphml
```

Symbols can be IDs, `path#Name`, `path:line`, a file path or a plain name. Every command takes
`--json` for scripting.

## Rules in CI

`xray check` reads the `check` section of `.xray.json` and exits with 1 on violations:

```json
{
  "check": {
    "maxImportCycles": 0,
    "ignoreTypeOnlyCycles": true,
    "layers": [{ "name": "ui is not db", "from": ["src/ui/**"], "disallow": ["src/db/**"] }]
  }
}
```

`xray check --update-baseline` records today's cycles so that only new ones fail. With
`--format github` violations become inline annotations; [action.yml](action.yml) packages that
as a GitHub Action. xray checks its own architecture this
way: see [.xray.json](.xray.json).

### Blast radius on pull requests

[pr-impact](pr-impact/action.yml) comments on each pull request with what its changes reach:
risk, entry points (routes, commands, components), tests to run and direct dependents, linked to
the code. It keeps one comment per pull request and updates it on every push.

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: orgalorg7/xray-codebase/pr-impact@main
        with:
          fail-on-risk: never # or low, medium, high
```

The comment comes from `xray impact --diff <base> --format markdown`, which works with any CI.

## How it works

| Package | What it does |
| --- | --- |
| `@xray/schema` | Graph model (node/edge kinds, confidence), stable IDs, JSON format v1 + validation |
| `@xray/store` | SQLite graph store: per-file incremental updates, neighbors, subgraphs, shortest paths, full-text search |
| `@xray/parser` | Language plugin contract, result builder, tree-sitter loader |
| `@xray/lang-ts` | TypeScript/JavaScript via the TypeScript compiler: imports, re-exports, calls through aliases, generics and typed receivers, inheritance, overrides, CommonJS, JSX, workspace packages |
| `@xray/lang-python` | Python via tree-sitter: packages and relative imports, `__init__` re-exports, MRO, `self`/`cls`/`super()`, type inference from constructors, annotations and return types |
| `@xray/engine` | File discovery (`.gitignore`, `.xrayignore`), incremental scans, watch mode, repo/directory/package skeleton |
| `@xray/analysis` | Cycles with suggested cuts; impact rings, entry points, tests and risk (from symbols or a diff); call routes and trees; feature search; centrality, dead code, unused exports, hotspots; districts; git churn and co-change; the map layout and zoom-level roads |
| `@xray/service` | The API over a graph snapshot, shared by the server, the HTML export and future editor integrations (browser-safe) |
| `@xray/server` | Local workspace (index, watch, git) behind a read-only HTTP + WebSocket API |
| `@xray/ui` | The map: a canvas renderer with semantic zoom, search, panels for every view |
| `@xray/cli` | The `xray` command |
| `xray-codebase` | The publishable npm package: the CLI bundled with the UI |
| `xray-vscode` | The VS Code extension: an analysis worker per folder, the map in a webview, CodeLens, hovers, sidebar |
| `@xray/site` | The gallery on GitHub Pages: self-contained map pages of public repositories, rebuilt by a workflow |
| `@xray/cloud` | Hosted xray: GitHub URL → sandboxed shallow fetch → map, a job queue with live progress, stored maps at permanent links, rate limits, a container image |

Entry points it recognises: Express/Fastify-style routes, Next.js route handlers, commander and
yargs commands, React components, Jest/Vitest/Mocha tests; FastAPI, Flask and Django routes,
click/typer commands and pytest tests.

### Benchmarks

`pnpm bench` scans pinned real repositories ([bench/repos.json](bench/repos.json)) and writes
[bench/results/latest.json](bench/results/latest.json). A rescan with no changes takes
10–150 ms.

| Repo | Lines | Cold scan | Calls resolved |
| --- | --- | --- | --- |
| express | 21.6k JS | 1.9 s | 1523 (26% exact, rest by unique method name) |
| zod | 103.6k TS | 13–16 s | 25496 (99.9% exact) |
| flask | 18.4k Py | 0.5 s | 1128 (40% exact, 25% inferred) |
| requests | 12.1k Py | 0.3 s | 736 (65% exact, 33% inferred) |
| fastapi | 128.4k Py | 3.6 s | 3870 (43% exact, 56% inferred) |

`fixtures/` holds small repos with hand-written expected graphs; see [fixtures/README.md](fixtures/README.md).

## Development

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm build       # every package, the UI and the npm bundle
pnpm test        # vitest
pnpm e2e         # Playwright (PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome)
pnpm lint        # biome
pnpm typecheck   # packages + tests
pnpm bench       # real-world repos (needs network on first run)
pnpm --filter @xray/ui dev   # UI with hot reload, against `xray open --port 4400`
node packages/cloud/dist/main.js   # the hosted version on :8080 (data in ./data)
```

## Roadmap

Done: the engine, analyses, CLI and local map, the VS Code extension, the hosted version and
pull request comments. Next: private repositories in the hosted version (a GitHub App), more
languages through tree-sitter (Go, Java, Rust, C#), links from frontend `fetch` calls to backend
routes, and comparing the maps of two commits.

## License

MIT
