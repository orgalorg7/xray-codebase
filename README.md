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

Phase 0 (foundation) is in place:

| Package | What it does |
| --- | --- |
| `@xray/schema` | Graph model (node/edge kinds, confidence), stable IDs, JSON format v1 + validation |
| `@xray/store` | SQLite graph store: per-file incremental updates, neighbors, subgraphs, shortest paths, full-text search |
| `@xray/testkit` | Golden fixture loader and precision/recall scoring for extractors |

`fixtures/` holds small repos with hand-written expected graphs; see [fixtures/README.md](fixtures/README.md).

## Development

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm test        # vitest
pnpm lint        # biome
pnpm build       # tsc project references via turbo
pnpm typecheck   # packages + tests
```

## License

MIT
