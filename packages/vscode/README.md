# xray: Codebase Map

**X-ray vision for your codebase, inside VS Code.** xray maps every file, class and function in
your workspace and how they depend on each other, then puts that knowledge where you work.

- **Callers above every function.** CodeLens shows how many places call and use a function,
  method or class. Click it to see every call site in the peek view.
- **Blast radius.** Before you change something, see everything that could break: dependents by
  distance, the routes and commands that reach it, the tests to run, and a risk score.
- **The map.** A zoomable map of the whole workspace, folders as regions and files as cities,
  with dependency roads, search ("where is login handled"), call routes between any two
  functions, circular imports with the import to cut, and a dependency matrix.
- **Hovers** add caller counts and map links to declarations and calls.
- **Sidebar** lists import cycles, hotspot files and possibly dead code.

TypeScript, JavaScript and Python. Static analysis only: your code is never run and nothing
leaves your machine. Links say how sure they are: resolved exactly, inferred from types, or
guessed by name.

## Use it

| Action | How |
| --- | --- |
| Open the map | `xray: Open Map` (Ctrl+Alt+M), the status bar item, or the xray sidebar |
| Show the code under the cursor on the map | `xray: Reveal in Map` (Ctrl+Alt+R) or the editor context menu |
| What breaks if this changes | `xray: Blast Radius of This Symbol`, or "blast radius" above any function |
| Find a feature | `xray: Find Where a Feature Lives` |
| Circular imports | `xray: Show Import Cycles`, or the sidebar |

Press `?` on the map for its keyboard shortcuts.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `xray.codeLens.enabled` | `true` | Callers and blast radius above declarations |
| `xray.hover.enabled` | `true` | Caller counts in hovers |
| `xray.watch` | `true` | Rescan when files change |
| `xray.exclude` | `[]` | Extra gitignore-style patterns to leave out (`.gitignore` and `.xrayignore` are always honored) |
| `xray.maxMemoryMB` | `0` | Memory limit for the analysis process; 0 picks half your RAM (2–8 GB) |

The analysis runs in its own process, so even a minute-long first scan of a large repository
never slows the editor down. Its index is kept in VS Code's storage for the workspace, not in
your repository. Later sessions reuse it while no file has changed.

The same engine powers the `xray` command line ([xray-codebase on npm](https://www.npmjs.com/package/xray-codebase)):
`npx xray-codebase open` in any repository.

## Requirements

VS Code 1.125 or newer (it needs the Node.js 22.13+ runtime with SQLite that recent VS Code
ships).
