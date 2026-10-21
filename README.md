# xray

**X-ray vision for any codebase.** Point xray at an unfamiliar repository and get a zoomable,
Google-Maps-style map of everything in it: packages → files → classes → functions, and every
import, call, inheritance link and reference between them.

- **Directions:** trace how one function reaches another, across files.
- **Dependencies:** see the full import graph and every circular import.
- **Where does this live?** Find a feature's code from a plain-language query.
- **Blast radius:** see everything a change to a function can affect, including routes, CLI commands and tests.

xray is static analysis only. It never runs your code, needs no AI or network, and gives the same results on every run.
Each edge records how confident the analyzer is (`exact`, `inferred`, `heuristic`).

Planned shells, all sharing one engine and one map UI:

1. `npx codebase-xray .`: CLI plus a local web map
2. A VS Code extension
3. A hosted app: paste a GitHub URL

Languages: TypeScript/JavaScript and Python first; more through tree-sitter plugins.

## Status

Phases 0–2 are done: xray scans a repository into a graph database and analyzes it. The map
UI and CLI come next.

| Package | What it does |
| --- | --- |
| `@xray/schema` | Graph model (node/edge kinds, confidence), stable IDs, JSON format v1 + validation |
| `@xray/store` | SQLite graph store: per-file incremental updates, neighbors, subgraphs, shortest paths, full-text search |
| `@xray/parser` | Language plugin contract, result builder, tree-sitter loader |
| `@xray/lang-ts` | TypeScript/JavaScript via the TypeScript compiler: imports, re-exports, calls through aliases, generics and typed receivers, inheritance, overrides, CommonJS, JSX, workspace packages |
| `@xray/lang-python` | Python via tree-sitter: packages and relative imports, `__init__` re-exports, MRO, `self`/`cls`/`super()`, type inference from constructors, annotations and return types |
| `@xray/engine` | File discovery (`.gitignore`, `.xrayignore`), incremental scans, watch mode, repo/directory/package skeleton |
| `@xray/analysis` | Import and call cycles with suggested cuts; blast radius (impact rings, entry points, tests, risk) from symbols or a `git diff`; call routes between symbols and call trees; feature search ("where is login handled"); fan-in/out, centrality, dead code, unused exports, hotspots; districts (Louvain); git churn and co-change; the base-map layout and zoom-level roads |
| `@xray/testkit` | Golden fixtures, inline test projects and precision/recall scoring |

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
pnpm test        # vitest
pnpm lint        # biome
pnpm build       # tsc project references via turbo
pnpm typecheck   # packages + tests
pnpm bench       # real-world repos (needs network on first run)
```

## License

MIT
