import type { Confidence, EdgeKind } from "@xray/schema";
import {
  compareStrings,
  DEPENDENCY_KINDS,
  ENTRY_POINT_KINDS,
  type GraphIndex,
  SYMBOL_KINDS,
  weakest,
} from "./graph-index.js";

export type ImpactOptions = {
  /** Stop after this many hops (default: unlimited). */
  maxDepth?: number;
  /** Edge kinds to follow backwards (default: every dependency kind). */
  kinds?: readonly EdgeKind[];
  /** Follow name-based guesses (default true). */
  includeHeuristic?: boolean;
};

export type ImpactedNode = {
  id: string;
  depth: number;
  /** The edge kind that reached this node, from `from`. `overrides` marks dynamic dispatch. */
  via: EdgeKind;
  from: string;
  /** The weakest confidence along the path from the change. */
  confidence: Confidence;
};

export type RiskLevel = "low" | "medium" | "high";

export type ImpactReport = {
  /** The changed nodes, including everything they contain. */
  targets: string[];
  impacted: ImpactedNode[];
  rings: { depth: number; ids: string[] }[];
  entryPoints: ImpactedNode[];
  tests: ImpactedNode[];
  /** Modules containing impacted symbols, sorted. */
  modules: string[];
  risk: { score: number; level: RiskLevel; reasons: string[] };
};

/**
 * Everything that may break if `targets` change: reverse reachability over dependency edges,
 * plus dynamic dispatch (callers of a method an impacted method overrides).
 */
export function impact(
  index: GraphIndex,
  targets: readonly string[],
  options: ImpactOptions = {},
): ImpactReport {
  const kinds = options.kinds ?? DEPENDENCY_KINDS;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const expanded = [
    ...new Set(targets.filter((id) => index.node(id)).flatMap((id) => index.descendants(id))),
  ];
  const seen = new Map<string, ImpactedNode>();
  const targetSet = new Set(expanded);
  let frontier: { id: string; confidence: Confidence }[] = expanded.map((id) => ({
    id,
    confidence: "exact",
  }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { id: string; confidence: Confidence }[] = [];
    const reach = (id: string, via: EdgeKind, from: string, confidence: Confidence): void => {
      if (targetSet.has(id) || seen.has(id)) return;
      const node: ImpactedNode = { id, depth, via, from, confidence };
      seen.set(id, node);
      next.push({ id, confidence });
    };
    for (const current of frontier) {
      for (const edge of index.in(current.id, kinds)) {
        if (edge.confidence === "heuristic" && options.includeHeuristic === false) continue;
        reach(edge.source, edge.kind, current.id, weakest(current.confidence, edge.confidence));
      }
      // A changed override changes what calls to the overridden method do.
      for (const edge of index.out(current.id, ["overrides"])) {
        reach(edge.target, "overrides", current.id, weakest(current.confidence, "inferred"));
      }
    }
    frontier = next;
  }

  const impacted = [...seen.values()].sort(
    (a, b) => a.depth - b.depth || compareStrings(a.id, b.id),
  );
  const rings: ImpactReport["rings"] = [];
  for (const node of impacted) {
    const ring = rings.at(-1);
    if (ring?.depth === node.depth) ring.ids.push(node.id);
    else rings.push({ depth: node.depth, ids: [node.id] });
  }
  const kindOf = (id: string) => index.node(id)?.kind;
  const asTarget = (id: string): ImpactedNode => ({
    id,
    depth: 0,
    via: "contains",
    from: id,
    confidence: "exact",
  });
  const entryPoints = [
    ...expanded.filter((id) => ENTRY_POINT_KINDS.has(kindOf(id) ?? "module")).map(asTarget),
    ...impacted.filter((node) => ENTRY_POINT_KINDS.has(kindOf(node.id) ?? "module")),
  ];
  const tests = impacted.filter((node) => kindOf(node.id) === "test");
  const modules = [
    ...new Set(
      impacted.flatMap((node) => {
        const mod = index.moduleOf(node.id);
        return mod && !targetSet.has(mod) ? [mod] : [];
      }),
    ),
  ].sort();

  return {
    targets: expanded,
    impacted,
    rings,
    entryPoints,
    tests,
    modules,
    risk: assessRisk(
      impacted.filter((node) => SYMBOL_KINDS.has(kindOf(node.id) ?? "module")).length,
      entryPoints.length,
      tests.length,
      impacted,
    ),
  };
}

function assessRisk(
  symbols: number,
  entryPoints: number,
  tests: number,
  impacted: ImpactedNode[],
): ImpactReport["risk"] {
  const reasons: string[] = [];
  let score = Math.round(15 * Math.log2(1 + symbols));
  if (symbols > 0) reasons.push(`${symbols} dependent symbol${symbols === 1 ? "" : "s"}`);
  if (entryPoints > 0) {
    score += 8 * Math.min(entryPoints, 5);
    reasons.push(
      `${entryPoints} entry point${entryPoints === 1 ? "" : "s"} (routes, commands, components) affected`,
    );
  }
  if (tests === 0 && symbols > 0) {
    score += 15;
    reasons.push("no tests reach the change");
  } else if (tests > 0) reasons.push(`${tests} test${tests === 1 ? "" : "s"} cover the change`);
  const guessed = impacted.filter((node) => node.confidence === "heuristic").length;
  if (guessed > 0)
    reasons.push(`${guessed} dependent${guessed === 1 ? " is" : "s are"} only linked by name`);
  score = Math.min(100, score);
  return { score, level: score < 25 ? "low" : score < 60 ? "medium" : "high", reasons };
}

// ---- diffs -----------------------------------------------------------------------------

export type LineRange = { start: number; end: number };

/**
 * Changed line ranges per file from a unified diff (`git diff` output), in new-file line
 * numbers. Deleted files get one unbounded range so the whole module counts as changed.
 */
export function parseUnifiedDiff(diff: string): Map<string, LineRange[]> {
  const changes = new Map<string, LineRange[]>();
  let oldPath: string | undefined;
  let path: string | undefined;
  let line = 0;
  let inHunk = false;
  // For a hunk that adds no lines, git's start line is the line *before* the deletion.
  let deletionOnly = false;
  const add = (file: string, start: number, end: number): void => {
    const ranges = changes.get(file) ?? [];
    const last = ranges.at(-1);
    if (last && start <= last.end + 1 && end >= last.start - 1) {
      last.start = Math.min(last.start, start);
      last.end = Math.max(last.end, end);
    } else ranges.push({ start, end });
    changes.set(file, ranges);
  };
  const strip = (raw: string): string | undefined => {
    const value = raw.trim().replace(/\t.*$/, "");
    if (value === "/dev/null") return undefined;
    return value.replace(/^"?[ab]\//, "").replace(/"$/, "");
  };
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git")) {
      inHunk = false;
      oldPath = undefined;
      path = undefined;
    } else if (!inHunk && text.startsWith("--- ")) oldPath = strip(text.slice(4));
    else if (!inHunk && text.startsWith("+++ ")) {
      path = strip(text.slice(4));
      if (path === undefined && oldPath !== undefined) add(oldPath, 1, Number.POSITIVE_INFINITY);
    } else if (text.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(text);
      line = match ? Number(match[1]) : 0;
      deletionOnly = match?.[2] === "0";
      inHunk = true;
    } else if (inHunk && path) {
      if (text.startsWith("+")) {
        add(path, line, line);
        line++;
      } else if (text.startsWith("-")) {
        // A deletion changes the code on both sides of where the lines were.
        const before = deletionOnly ? line : line - 1;
        add(path, Math.max(1, before), Math.max(1, before + 1));
      } else if (!text.startsWith("\\")) line++;
    }
  }
  return changes;
}

/**
 * The innermost symbols whose source spans overlap the changed lines. Changes outside any
 * symbol (imports, top-level code) map to the module itself.
 */
export function symbolsForChanges(
  index: GraphIndex,
  changes: ReadonlyMap<string, readonly LineRange[]>,
): string[] {
  const byFile = new Map<string, { id: string; start: number; end: number }[]>();
  const modules = new Map<string, string>();
  for (const node of index.nodes.values()) {
    const loc = node.location;
    if (!loc) continue;
    if (node.kind === "module") {
      modules.set(loc.file, node.id);
      continue;
    }
    const list = byFile.get(loc.file) ?? [];
    list.push({ id: node.id, start: loc.line, end: loc.endLine ?? loc.line });
    byFile.set(loc.file, list);
  }
  const result = new Set<string>();
  for (const [file, ranges] of changes) {
    const symbols = byFile.get(file) ?? [];
    const moduleId = modules.get(file);
    for (const range of ranges) {
      if (range.end === Number.POSITIVE_INFINITY && moduleId) {
        result.add(moduleId);
        continue;
      }
      const overlapping = symbols.filter((s) => s.start <= range.end && s.end >= range.start);
      // Innermost: drop any symbol that strictly encloses another overlapping one.
      const innermost = overlapping.filter(
        (outer) =>
          !overlapping.some(
            (inner) =>
              inner !== outer &&
              inner.start >= outer.start &&
              inner.end <= outer.end &&
              (inner.start > outer.start || inner.end < outer.end),
          ),
      );
      if (innermost.length > 0) for (const s of innermost) result.add(s.id);
      else if (moduleId) result.add(moduleId);
    }
  }
  return [...result].sort();
}
