# xray-codebase

**X-ray vision for any codebase.** Point it at a repository and get an interactive,
Google-Maps-style map of everything in it: directories, files, classes and functions, and every
import, call and inheritance link between them. TypeScript, JavaScript and Python.

```sh
npx xray-codebase open            # scan the current repository and open the map
```

- **Directions:** how one function reaches another (`xray trace <from> <to>`).
- **Dependencies:** the whole import graph and every circular import (`xray cycles`).
- **Where does this live?** Find a feature's code from a plain query (`xray where "login"`).
- **Blast radius:** what a change can break, with entry points, tests and a risk score
  (`xray impact <symbol>` or `xray impact --diff main`).
- **Pull request comments:** `xray impact --diff origin/main --format markdown` writes the
  blast radius of a branch as a comment, ready for a bot to post.
- **CI rules:** fail on new cycles or broken layering (`xray check`, see `.xray.json`).
- **Share:** `xray export --format html` writes one self-contained, offline map.

Static analysis only: your code is never executed and nothing leaves your machine. Every link
says how sure it is: exact, inferred from types, or guessed by name.

Requires Node.js 24 or newer. Run `xray --help` for all commands.

MIT licensed.
