import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer, serviceAt, Workspace } from "@xray/server";
import {
  type Baseline,
  type CheckConfig,
  compareSnapshots,
  type DiffView,
  diffMarkdown,
  impactMarkdown,
  runCheck,
  type Summary,
  snapshotData,
  toDot,
  toGraphML,
  toMermaid,
  type XrayService,
} from "@xray/service";
import { buildHtml, findUiDir } from "./html.js";
import { type IO, line, painter } from "./io.js";

export const VERSION = "0.3.0";

const HELP = `xray: X-ray vision for any codebase

Usage: xray <command> [options]

Commands
  open [dir]              Scan and open the interactive map in your browser
  scan [dir]              Build or update the index (.xray/index.db)
  where <query>           Find where a feature lives ("where is login handled")
  impact <symbol...>      What may break if these change
  impact --diff [ref]     ...or if the changes since a git ref (default HEAD) land
  trace <from> <to>       Call routes from one symbol to another
  diff <ref> [ref]        How the architecture changed since a git revision
  cycles                  Circular imports with suggested cuts
  check                   Enforce rules from .xray.json (cycles, layers) for CI
  export                  Write the graph: --format json|html|dot|mermaid|graphml

Symbols can be IDs, path#Name, path:line, a file path or a plain name.

Common options
  -C, --dir <dir>         Repository to analyze (default: current directory)
      --json              Machine-readable output
      --no-git            Skip git history
  -h, --help              Show help
  -v, --version           Show the version

Run "xray <command> --help" for command options.`;

const COMMAND_HELP: Record<string, string> = {
  open: `xray open [dir] [--port 4400] [--host 127.0.0.1] [--no-browser] [--no-watch]
Scans the repository, starts a local server and opens the map. Rescans as files change.`,
  scan: `xray scan [dir] [--force]
Builds or incrementally updates the index in <dir>/.xray/index.db and prints a summary.
Unchanged files are not re-analyzed; --force re-analyzes everything (after dependency or
tsconfig changes).`,
  where: `xray where <query> [-n 10] [--json]
Ranks code by how well it matches the query and how connected it is to the matches.`,
  impact: `xray impact <symbol...> [--depth N] [--no-guesses] [--json]
xray impact --diff [ref] [--staged] [--format text|markdown] [--link <url>]
Lists everything that depends on the symbols, by distance, with entry points, tests and a risk score.
--format markdown writes a pull request comment; --link prefixes file links in it, for example
https://github.com/owner/repo/blob/<sha>/.`,
  trace: `xray trace <from> <to> [-k 3] [--json]
The cheapest call routes from <from> to <to>; sure links are preferred over guesses.`,
  diff: `xray diff <base> [head] [--format text|markdown|json] [--link <url>]
Maps the repository at <base> (and at <head>, or the working tree) and compares them: files and
symbols added and removed, new and removed dependencies between files and directories, import
cycles introduced and resolved, exported API changes, routes and coupling shifts.`,
  cycles: `xray cycles [--ignore-type-only] [--calls] [--json]
Circular imports between files, each with the smallest set of imports to cut.`,
  check: `xray check [--format text|github] [--update-baseline]
Evaluates the "check" section of .xray.json and exits with 1 on violations:
  { "check": { "maxImportCycles": 0, "noNewCycles": true, "ignoreTypeOnlyCycles": true,
               "layers": [{ "name": "ui is not db", "from": ["src/ui/**"], "disallow": ["src/db/**"] }] } }
--update-baseline records today's cycles in .xray/baseline.json so only new ones fail.`,
  export: `xray export --format json|html|dot|mermaid|graphml [--level module|symbol] [-o file] [--no-sources]
html writes one self-contained page with the full interactive map (works offline).`,
};

type Flags = Record<string, string | boolean | string[] | undefined>;

const COMMON = {
  dir: { type: "string", short: "C" },
  json: { type: "boolean" },
  "no-git": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

/** Runs the CLI. Returns the process exit code. */
export async function main(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv;
  const p = painter(io);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(`${HELP}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    io.err(`${p.red("error")} unknown command "${command}"\n\n${HELP}\n`);
    return 2;
  }
  try {
    return await handler(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(
        `${p.red("error")} ${error.message}\n${COMMAND_HELP[command] ? `\n${COMMAND_HELP[command]}\n` : ""}`,
      );
      return 2;
    }
    io.err(`${p.red("error")} ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parse<
  O extends Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>,
>(args: string[], options: O): { values: Flags; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { ...COMMON, ...options },
      allowPositionals: true,
    });
    return { values: values as Flags, positionals };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Opens the workspace for a command and brings its index up to date. */
async function open(
  io: IO,
  flags: Flags,
  positionalDir?: string,
): Promise<{ workspace: Workspace; service: XrayService }> {
  const root = resolve(io.cwd, (flags.dir as string | undefined) ?? positionalDir ?? ".");
  if (!existsSync(root)) throw new Error(`no such directory: ${root}`);
  const workspace = new Workspace({ root, git: !flags["no-git"] });
  const service = await workspace.service();
  return { workspace, service };
}

/** Resolves a user-typed reference to exactly one node, or explains why it cannot. */
function resolveOne(service: XrayService, reference: string): Summary {
  const matches = service.resolve(reference);
  if (matches.length === 1) return matches[0] as Summary;
  if (matches.length === 0) {
    const suggestions = service.search(reference, 5).hits.map((h) => `  ${h.node.id}`);
    throw new UsageError(
      `nothing matches "${reference}"${suggestions.length ? `. Did you mean:\n${suggestions.join("\n")}` : ""}`,
    );
  }
  throw new UsageError(
    `"${reference}" is ambiguous (${matches.length} matches). Use one of:\n${matches
      .slice(0, 12)
      .map((m) => `  ${m.id}`)
      .join("\n")}`,
  );
}

const json = (io: IO, value: unknown): number => {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
};

const helpRequested = (io: IO, name: string, flags: Flags): boolean => {
  if (!flags.help) return false;
  io.out(`${COMMAND_HELP[name]}\n`);
  return true;
};

type Command = (args: string[], io: IO) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  async scan(args, io) {
    const { values, positionals } = parse(args, { force: { type: "boolean" } });
    if (helpRequested(io, "scan", values)) return 0;
    const p = painter(io);
    const root = resolve(io.cwd, (values.dir as string | undefined) ?? positionals[0] ?? ".");
    if (!existsSync(root)) throw new Error(`no such directory: ${root}`);
    const workspace = new Workspace({ root, git: !values["no-git"] });
    try {
      const report = await workspace.scan({ force: Boolean(values.force) });
      if (values.json) return json(io, { ...report, index: join(root, ".xray", "index.db") });
      const meta = (await workspace.service()).meta();
      io.out(
        `${p.green("✓")} ${p.bold(meta.name)}: ${meta.stats.files} files, ${meta.stats.symbols} symbols, ${meta.stats.edges} links ${p.dim(`(${Math.round(report.timings.total)} ms)`)}\n`,
      );
      const changes = report.added.length + report.changed.length + report.removed.length;
      if (changes > 0)
        io.out(
          `  ${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed\n`,
        );
      for (const d of report.diagnostics.slice(0, 10)) {
        io.out(
          `  ${d.severity === "error" ? p.red("error") : p.yellow("warn")} ${d.file ? `${d.file}: ` : ""}${d.message}\n`,
        );
      }
      if (report.diagnostics.length > 10)
        io.out(p.dim(`  …and ${report.diagnostics.length - 10} more notes\n`));
      if (report.skipped.length > 0)
        io.out(p.dim(`  skipped ${report.skipped.length} large or binary files\n`));
      return 0;
    } finally {
      workspace.close();
    }
  },

  async open(args, io) {
    const { values, positionals } = parse(args, {
      port: { type: "string" },
      host: { type: "string" },
      "no-browser": { type: "boolean" },
      "no-watch": { type: "boolean" },
    });
    if (helpRequested(io, "open", values)) return 0;
    const p = painter(io);
    const uiDir = findUiDir();
    if (!uiDir)
      throw new Error(
        "the map UI is not built. Run `pnpm --filter @xray/ui build` (or set XRAY_UI_DIR).",
      );
    const { workspace, service } = await open(io, values, positionals[0]);
    const meta = service.meta();
    io.out(
      `${p.green("✓")} ${p.bold(meta.name)}: ${meta.stats.files} files, ${meta.stats.symbols} symbols\n`,
    );
    const app = await createServer({ workspace, uiDir });
    const host = (values.host as string | undefined) ?? "127.0.0.1";
    const firstPort = Number((values.port as string | undefined) ?? 4400);
    let url: string | undefined;
    for (let port = firstPort; port < firstPort + 20 && !url; port++) {
      try {
        await app.listen({ port, host });
        url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`;
      } catch (error) {
        if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
      }
    }
    if (!url) throw new Error(`ports ${firstPort}–${firstPort + 19} are all in use`);
    if (!values["no-watch"]) workspace.watch();
    io.out(
      `  Map: ${p.cyan(url)}${values["no-watch"] ? "" : p.dim("  (live: rescans when files change)")}\n  Press Ctrl+C to stop.\n`,
    );
    if (!values["no-browser"]) openBrowser(url);
    await new Promise<void>((done) => {
      const stop = () => {
        app.close().finally(() => {
          workspace.close();
          done();
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  },

  async where(args, io) {
    const { values, positionals } = parse(args, { n: { type: "string", short: "n" } });
    if (helpRequested(io, "where", values)) return 0;
    const query = positionals.join(" ").trim();
    if (!query) throw new UsageError("what should I look for?");
    const { workspace, service } = await open(io, values);
    try {
      const result = service.search(query, Number(values.n ?? 10));
      if (values.json) return json(io, result);
      const p = painter(io);
      if (result.hits.length === 0) {
        io.out(
          `Nothing matches "${query}". Try words the code would use (function or file names).\n`,
        );
        return 0;
      }
      io.out(`${p.bold("Best matches")}\n`);
      for (const hit of result.hits)
        io.out(`  ${line(io, hit.node, hit.lexical === 0 ? p.dim("(related)") : "")}\n`);
      const { territory } = result;
      if (territory.modules.length > 0) {
        io.out(`\n${p.bold("Files")}\n`);
        for (const m of territory.modules.slice(0, 6)) io.out(`  ${m.node.label}\n`);
      }
      if (territory.entryPoints.length > 0) {
        io.out(`\n${p.bold("Entry points that lead here")}\n`);
        for (const e of territory.entryPoints.slice(0, 10)) io.out(`  ${line(io, e)}\n`);
      }
      if (territory.tests.length > 0)
        io.out(`\n${p.dim(`${territory.tests.length} tests exercise this code`)}\n`);
      return 0;
    } finally {
      workspace.close();
    }
  },

  async impact(args, io) {
    const { values, positionals } = parse(args, {
      diff: { type: "boolean" },
      staged: { type: "boolean" },
      depth: { type: "string" },
      "no-guesses": { type: "boolean" },
      all: { type: "boolean" },
      format: { type: "string" },
      link: { type: "string" },
    });
    if (helpRequested(io, "impact", values)) return 0;
    const format = String(values.format ?? "text");
    if (format !== "text" && format !== "markdown")
      throw new UsageError(`unknown format "${format}" (text or markdown)`);
    const p = painter(io);
    const { workspace, service } = await open(io, values);
    try {
      const options = {
        includeHeuristic: !values["no-guesses"],
        ...(values.depth ? { maxDepth: Number(values.depth) } : {}),
      };
      let targets: Summary[];
      let report: ReturnType<XrayService["impact"]>;
      if (values.diff) {
        const ref = positionals[0] ?? "HEAD";
        const diffArgs = values.staged
          ? ["diff", "--staged", "--unified=0"]
          : ["diff", "--unified=0", ref];
        const diff = execFileSync("git", ["-C", workspace.root, ...diffArgs], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        const result = service.impactOfDiff(diff, options);
        targets = result.changed;
        report = result.report;
      } else {
        if (positionals.length === 0) throw new UsageError("which symbols? (or --diff)");
        targets = positionals.map((ref) => resolveOne(service, ref));
        report = service.impact(
          targets.map((t) => t.id),
          options,
        );
      }
      if (values.json) return json(io, { changed: targets, ...report });
      if (format === "markdown") {
        io.out(impactMarkdown(targets, report, values.link ? { link: String(values.link) } : {}));
        return 0;
      }
      if (targets.length === 0) {
        io.out("No code changes found in the diff.\n");
        return 0;
      }
      io.out(`${p.bold("Changed")}\n`);
      for (const t of targets.slice(0, 20)) io.out(`  ${line(io, t)}\n`);
      if (targets.length > 20) io.out(p.dim(`  …and ${targets.length - 20} more\n`));
      const color =
        report.risk.level === "high" ? p.red : report.risk.level === "medium" ? p.yellow : p.green;
      io.out(
        `\n${color(`${report.risk.level.toUpperCase()} risk (${report.risk.score}/100)`)}: ${report.risk.reasons.join("; ") || "nothing depends on it"}\n`,
      );
      if (report.rings.length > 0) {
        io.out(
          `  ${report.rings.map((r) => `${r.ids.length} at distance ${r.depth}`).join(", ")}\n`,
        );
      }
      if (report.entryPoints.length > 0) {
        io.out(`\n${p.bold("Entry points affected")}\n`);
        for (const e of report.entryPoints.slice(0, 20)) io.out(`  ${line(io, e.node)}\n`);
      }
      if (report.tests.length > 0) {
        io.out(`\n${p.bold(`Tests to run (${report.tests.length})`)}\n`);
        for (const t of report.tests.slice(0, values.all ? undefined : 15))
          io.out(`  ${line(io, t.node)}\n`);
      }
      const direct = report.impacted.filter((n) => n.depth === 1);
      if (direct.length > 0) {
        io.out(`\n${p.bold(`Direct dependents (${direct.length})`)}\n`);
        for (const n of direct.slice(0, values.all ? undefined : 25))
          io.out(
            `  ${line(io, n.node, n.confidence === "exact" ? "" : p.dim(`(${n.confidence})`))}\n`,
          );
        if (!values.all && direct.length > 25) io.out(p.dim(`  …use --all to list everything\n`));
      }
      return 0;
    } finally {
      workspace.close();
    }
  },

  async diff(args, io) {
    const { values, positionals } = parse(args, {
      format: { type: "string" },
      link: { type: "string" },
    });
    if (helpRequested(io, "diff", values)) return 0;
    const format = values.json ? "json" : String(values.format ?? "text");
    if (!["text", "markdown", "json"].includes(format)) {
      throw new UsageError(`unknown format "${format}" (text, markdown or json)`);
    }
    const [base, head] = positionals;
    if (!base) throw new UsageError("compare with which revision? For example: xray diff main");
    const { workspace, service } = await open(io, values);
    try {
      const before = await serviceAt(workspace.root, base);
      const after = head ? (await serviceAt(workspace.root, head)).service : service;
      const view = compareSnapshots(before.service, after, {
        before: base,
        after: head ?? "the working tree",
      });
      if (format === "json") return json(io, view);
      if (format === "markdown") {
        io.out(diffMarkdown(view, values.link ? { link: String(values.link) } : {}));
        return 0;
      }
      io.out(diffText(view, painter(io), io));
      return 0;
    } finally {
      workspace.close();
    }
  },

  async trace(args, io) {
    const { values, positionals } = parse(args, { k: { type: "string", short: "k" } });
    if (helpRequested(io, "trace", values)) return 0;
    if (positionals.length !== 2) throw new UsageError("trace needs a start and a destination");
    const p = painter(io);
    const { workspace, service } = await open(io, values);
    try {
      const from = resolveOne(service, positionals[0] as string);
      const to = resolveOne(service, positionals[1] as string);
      const result = service.trace(from.id, to.id, { k: Number(values.k ?? 3) });
      if (values.json) return json(io, result);
      if (result.paths.length === 0) {
        io.out(
          `No call route from ${from.label} to ${to.label}. Calls run one way: try swapping them.\n`,
        );
        return 1;
      }
      result.paths.forEach((path, i) => {
        io.out(
          `${p.bold(`Route ${i + 1}`)} ${p.dim(`(${path.nodes.length - 1} steps${path.confidence === "exact" ? "" : `, ${path.confidence}`})`)}\n`,
        );
        path.nodes.forEach((n, j) => {
          const edge = j > 0 ? path.edges[j - 1] : undefined;
          const via = edge
            ? p.dim(
                `${edge.kind}${edge.location ? ` at ${edge.location.file}:${edge.location.line}` : ""}`,
              )
            : "";
          io.out(`  ${j === 0 ? " " : "→"} ${line(io, n)}${via ? `\n      ${via}` : ""}\n`);
        });
      });
      return 0;
    } finally {
      workspace.close();
    }
  },

  async cycles(args, io) {
    const { values } = parse(args, {
      "ignore-type-only": { type: "boolean" },
      calls: { type: "boolean" },
    });
    if (helpRequested(io, "cycles", values)) return 0;
    const p = painter(io);
    const { workspace, service } = await open(io, values);
    try {
      const result = service.cycles({ ignoreTypeOnly: Boolean(values["ignore-type-only"]) });
      if (values.json) return json(io, result);
      if (result.imports.length === 0) io.out(`${p.green("✓")} No circular imports.\n`);
      result.imports.forEach((cycle, i) => {
        io.out(`${p.red(`Cycle ${i + 1}`)} ${p.dim(`(${cycle.members.length} files)`)}\n`);
        for (const m of cycle.members) io.out(`    ${m.label}\n`);
        io.out(`  ${p.bold("Cut")}:\n`);
        for (const e of cycle.cut) {
          const target = cycle.members.find((m) => m.id === e.target)?.label ?? e.target;
          io.out(
            `    ${e.location ? `${e.location.file}:${e.location.line}` : e.source} imports ${target}${e.detail ? p.dim(` (${e.detail})`) : ""}\n`,
          );
        }
      });
      if (values.calls && result.calls.length > 0) {
        io.out(`\n${p.bold("Mutual recursion")}\n`);
        for (const c of result.calls) io.out(`  ${c.members.map((m) => m.label).join(" ⇄ ")}\n`);
      }
      return 0;
    } finally {
      workspace.close();
    }
  },

  async check(args, io) {
    const { values } = parse(args, {
      format: { type: "string" },
      "update-baseline": { type: "boolean" },
    });
    if (helpRequested(io, "check", values)) return 0;
    const p = painter(io);
    const { workspace, service } = await open(io, values);
    try {
      const configPath = join(workspace.root, ".xray.json");
      const config: CheckConfig = existsSync(configPath)
        ? ((JSON.parse(readFileSync(configPath, "utf8")) as { check?: CheckConfig }).check ?? {})
        : {};
      const baselinePath = join(workspace.root, ".xray", "baseline.json");
      if (values["update-baseline"]) {
        const cycles = runCheck(service, { ...config, noNewCycles: false }).cycles;
        mkdirSync(dirname(baselinePath), { recursive: true });
        writeFileSync(baselinePath, `${JSON.stringify({ cycles } satisfies Baseline, null, 2)}\n`);
        io.out(`${p.green("✓")} Recorded ${cycles.length} accepted cycles in ${baselinePath}\n`);
        return 0;
      }
      const baseline = existsSync(baselinePath)
        ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline)
        : undefined;
      const result = runCheck(service, config, baseline);
      if (values.json) {
        json(io, result);
        return result.ok ? 0 : 1;
      }
      if (values.format === "github") {
        for (const v of result.violations) {
          const where = v.location ? ` file=${v.location.file},line=${v.location.line}` : "";
          io.out(`::error${where},title=xray ${v.rule}::${v.message}\n`);
        }
      } else {
        for (const v of result.violations) {
          io.out(
            `${p.red("✗")} ${v.message}${v.location ? p.dim(`  (${v.location.file}:${v.location.line})`) : ""}\n`,
          );
        }
      }
      if (result.ok)
        io.out(
          `${p.green("✓")} All checks passed (${result.cycles.length} known import cycles).\n`,
        );
      else
        io.out(
          `\n${p.red(`${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}`)}\n`,
        );
      return result.ok ? 0 : 1;
    } finally {
      workspace.close();
    }
  },

  async export(args, io) {
    const { values } = parse(args, {
      format: { type: "string", short: "f" },
      level: { type: "string" },
      output: { type: "string", short: "o" },
      "no-sources": { type: "boolean" },
    });
    if (helpRequested(io, "export", values)) return 0;
    const format = (values.format as string | undefined) ?? "json";
    const level =
      values.level === "symbol" ? "symbol" : values.level === "module" ? "module" : undefined;
    if (!["json", "html", "dot", "mermaid", "graphml"].includes(format))
      throw new UsageError(`unknown format "${format}"`);
    const p = painter(io);
    const { workspace, service } = await open(io, values);
    try {
      let text: string;
      if (format === "json") text = `${JSON.stringify(service.snapshot.graph, null, 2)}\n`;
      else if (format === "dot") text = toDot(service, level ?? "module");
      else if (format === "mermaid") text = toMermaid(service, level ?? "module");
      else if (format === "graphml") text = toGraphML(service, level ?? "symbol");
      else {
        const uiDir = findUiDir();
        if (!uiDir)
          throw new Error(
            "the map UI is not built. Run `pnpm --filter @xray/ui build` (or set XRAY_UI_DIR).",
          );
        text = buildHtml(uiDir, snapshotData(service.snapshot, !values["no-sources"]));
      }
      const output = values.output as string | undefined;
      if (!output) {
        io.out(text);
        return 0;
      }
      const target = resolve(io.cwd, output);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      io.err(
        `${p.green("✓")} Wrote ${target} ${p.dim(`(${(Buffer.byteLength(text) / 1024).toFixed(0)} KB)`)}\n`,
      );
      return 0;
    } finally {
      workspace.close();
    }
  },
};

/** The architecture diff for a terminal: what matters most first, long lists shortened. */
function diffText(view: DiffView, p: ReturnType<typeof painter>, io: IO): string {
  const out: string[] = [];
  const name = (s: Summary) => line(io, s);
  const list = (title: string, items: string[], limit = 15) => {
    if (items.length === 0) return;
    out.push(`\n${p.bold(`${title} (${items.length})`)}`);
    for (const item of items.slice(0, limit)) out.push(`  ${item}`);
    if (items.length > limit) out.push(p.dim(`  …and ${items.length - limit} more`));
  };
  const dep = (d: { source: Summary; target: Summary }) => `${d.source.label} → ${d.target.label}`;
  out.push(
    `${p.bold("Architecture")} ${p.dim(`${view.before.label} → ${view.after.label}`)}: files +${view.modules.added.length} −${view.modules.removed.length}, dependencies +${view.dependencies.added.length} −${view.dependencies.removed.length}, symbols +${view.symbols.added.length} −${view.symbols.removed.length}`,
  );
  list(
    p.red("New import cycles"),
    view.cycles.introduced.map((c) => [...c, c[0] as Summary].map((s) => s.label).join(" → ")),
  );
  list("New dependencies between directories", view.directories.added.map(dep));
  list(p.red("Removed exported API"), view.api.removed.map(name));
  list(
    "Changed signatures",
    view.api.changed.map((c) => `${c.node.label}: ${c.before} → ${c.after}`),
  );
  list("New routes", view.routes.added.map(name));
  list("Removed routes", view.routes.removed.map(name));
  list(
    p.green("Resolved import cycles"),
    view.cycles.resolved.map((c) => c.map((s) => s.label).join(" → ")),
  );
  list(
    "Coupling shifts (importers)",
    view.coupling.map((c) => `${c.node.label}: ${c.before} → ${c.after}`),
  );
  list("New dependencies between files", view.dependencies.added.map(dep), 10);
  list("Removed dependencies between files", view.dependencies.removed.map(dep), 10);
  list(
    "Added files",
    view.modules.added.map((s) => s.label),
    10,
  );
  list(
    "Removed files",
    view.modules.removed.map((s) => s.label),
    10,
  );
  return `${out.join("\n")}\n`;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // No browser available (SSH, CI): the URL is printed anyway.
  }
}
