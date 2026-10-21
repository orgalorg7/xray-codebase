import type { GraphNode } from "@xray/schema";
import { splitIdentifier } from "@xray/store";
import {
  CALL_KINDS,
  compareStrings,
  DEPENDENCY_KINDS,
  ENTRY_POINT_KINDS,
  type GraphIndex,
  isAuxiliaryPath,
  isTestPath,
  SYMBOL_KINDS,
} from "./graph-index.js";

/** Words that describe the question, not the code. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "to",
  "for",
  "and",
  "or",
  "is",
  "are",
  "be",
  "it",
  "its",
  "where",
  "what",
  "which",
  "who",
  "how",
  "when",
  "why",
  "does",
  "do",
  "done",
  "did",
  "this",
  "that",
  "code",
  "function",
  "functions",
  "method",
  "methods",
  "class",
  "file",
  "files",
  "logic",
  "feature",
  "implemented",
  "implementation",
  "happen",
  "happens",
  "live",
  "lives",
  "located",
  "handled",
]);

/**
 * Concepts that are spelled many ways in code. A query word pulls in its group's other words
 * at a weight low enough that direct matches always lead. Purely static: no model involved.
 */
const SYNONYM_WEIGHT = 0.2;

const SYNONYMS: readonly string[][] = [
  [
    "auth",
    "authenticate",
    "authentication",
    "login",
    "signin",
    "logon",
    "session",
    "credential",
    "password",
    "token",
    "jwt",
  ],
  ["user", "account", "profile", "member"],
  ["delete", "remove", "destroy", "drop"],
  ["create", "add", "insert", "register"],
  ["update", "edit", "modify", "patch"],
  ["fetch", "load", "retrieve", "lookup"],
  ["save", "store", "persist"],
  ["config", "configuration", "settings", "options", "env", "preferences"],
  ["error", "exception", "failure"],
  ["pay", "payment", "billing", "invoice", "charge", "checkout"],
  ["email", "mail", "smtp", "notify", "notification"],
  ["cache", "memo", "memoize"],
  ["route", "router", "endpoint", "handler", "controller"],
  ["test", "spec"],
  ["log", "logger", "logging"],
  ["upload", "attachment"],
  ["search", "query", "filter"],
];

/** A deliberately small stemmer: enough to match plurals and -ing/-ed forms. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && /(ss|us|is)$/.test(w)) return w;
  if (w.length > 4 && /(ches|shes|xes|sses)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return w;
}

const SYNONYM_INDEX = new Map<string, string[]>();
for (const group of SYNONYMS) {
  const stems = group.map(stem);
  for (const s of stems)
    SYNONYM_INDEX.set(s, [...new Set([...(SYNONYM_INDEX.get(s) ?? []), ...stems])]);
}

export function tokenize(text: string): string[] {
  return splitIdentifier(text)
    .filter((word) => !STOPWORDS.has(word))
    .map(stem)
    .filter((word) => word.length > 1);
}

type Document = { id: string; length: number; tf: Map<string, number> };

export type FeatureHit = {
  id: string;
  score: number;
  /** Normalized lexical relevance, 0..1. */
  lexical: number;
  /** Normalized graph proximity to the lexical hits, 0..1. */
  graph: number;
  /** Query terms (stemmed) the node itself matched. */
  matched: string[];
};

export type FeatureResult = {
  query: string;
  terms: string[];
  hits: FeatureHit[];
  territory: {
    /** Modules ranked by the summed score of their hits. */
    modules: { id: string; score: number }[];
    /** Routes, commands and components that are hits or reach hits within a few calls. */
    entryPoints: string[];
    /** Tests that exercise the hits, nearest first (at most 25). */
    tests: string[];
  };
};

/** Most entry points and tests listed in a territory, nearest to the hits first. */
const TERRITORY_LIMIT = 25;

const FIELD_WEIGHTS = { name: 3, qualified: 2, path: 1, doc: 1, meta: 2 };

function fields(node: GraphNode): [keyof typeof FIELD_WEIGHTS, string][] {
  const meta = node.meta ?? {};
  const metaText = ["path", "command", "title", "method"]
    .map((key) => meta[key])
    .filter((v) => typeof v === "string");
  return [
    ["name", node.name],
    ["qualified", node.qualifiedName],
    ["path", node.location?.file ?? ""],
    ["doc", node.doc ?? ""],
    ["meta", metaText.join(" ")],
  ];
}

/**
 * Locates features by name: BM25F over identifiers, paths, docs and route paths, re-ranked by
 * personalized PageRank so code tightly connected to the matches rises too.
 */
export class FeatureIndex {
  readonly #index: GraphIndex;
  readonly #docs: Document[] = [];
  readonly #df = new Map<string, number>();
  readonly #avgLength: number;
  readonly #neighbors = new Map<string, { id: string; weight: number }[]>();

  constructor(index: GraphIndex) {
    this.#index = index;
    for (const node of index.nodes.values()) {
      if (!SYMBOL_KINDS.has(node.kind) && node.kind !== "module") continue;
      const tf = new Map<string, number>();
      let length = 0;
      for (const [field, text] of fields(node)) {
        for (const token of tokenize(text)) {
          tf.set(token, (tf.get(token) ?? 0) + FIELD_WEIGHTS[field]);
          length++;
        }
      }
      this.#docs.push({ id: node.id, length, tf });
      for (const token of tf.keys()) this.#df.set(token, (this.#df.get(token) ?? 0) + 1);
    }
    this.#avgLength =
      this.#docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.#docs.length);

    const link = (a: string, b: string, weight: number): void => {
      if (a === b) return;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        const list = this.#neighbors.get(x) ?? [];
        list.push({ id: y, weight });
        this.#neighbors.set(x, list);
      }
    };
    for (const edge of index.edges) {
      if (edge.kind === "contains") link(edge.source, edge.target, 0.3);
      else if (DEPENDENCY_KINDS.includes(edge.kind) && edge.kind !== "imports") {
        link(edge.source, edge.target, edge.confidence === "heuristic" ? 0.3 : 1);
      }
    }
  }

  #lexical(terms: Map<string, number>): Map<string, { score: number; matched: string[] }> {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.#docs.length;
    const scores = new Map<string, { score: number; matched: string[] }>();
    for (const doc of this.#docs) {
      let score = 0;
      const matched: string[] = [];
      for (const [term, weight] of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const df = this.#df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score +=
          weight *
          idf *
          ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.#avgLength)));
        if (weight === 1) matched.push(term);
      }
      if (score > 0) scores.set(doc.id, { score, matched });
    }
    return scores;
  }

  #pageRank(seeds: Map<string, number>, iterations = 20, damping = 0.85): Map<string, number> {
    const total = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
    const restart = new Map([...seeds].map(([id, s]) => [id, s / total]));
    let rank = new Map(restart);
    const strength = new Map<string, number>();
    for (const [id, list] of this.#neighbors)
      strength.set(
        id,
        list.reduce((sum, n) => sum + n.weight, 0),
      );
    for (let i = 0; i < iterations; i++) {
      const next = new Map<string, number>();
      for (const [id, value] of restart) next.set(id, (1 - damping) * value);
      for (const [id, value] of rank) {
        const list = this.#neighbors.get(id);
        const out = strength.get(id);
        if (!list || !out) {
          // Dangling mass returns to the seeds.
          for (const [seed, r] of restart)
            next.set(seed, (next.get(seed) ?? 0) + damping * value * r);
          continue;
        }
        for (const neighbor of list) {
          next.set(
            neighbor.id,
            (next.get(neighbor.id) ?? 0) + (damping * value * neighbor.weight) / out,
          );
        }
      }
      rank = next;
    }
    return rank;
  }

  search(query: string, options: { limit?: number } = {}): FeatureResult {
    const limit = options.limit ?? 20;
    const base = [...new Set(tokenize(query))];
    const terms = new Map<string, number>(base.map((t) => [t, 1]));
    for (const term of base) {
      for (const synonym of SYNONYM_INDEX.get(term) ?? [])
        if (!terms.has(synonym)) terms.set(synonym, SYNONYM_WEIGHT);
    }
    const empty: FeatureResult = {
      query,
      terms: base,
      hits: [],
      territory: { modules: [], entryPoints: [], tests: [] },
    };
    if (terms.size === 0) return empty;

    const lexical = this.#lexical(terms);
    if (lexical.size === 0) return empty;
    const maxLexical = Math.max(...[...lexical.values()].map((v) => v.score));
    const seeds = new Map(
      [...lexical]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 50)
        .map(([id, v]) => [id, v.score]),
    );
    const rank = this.#pageRank(seeds);
    const maxRank = Math.max(...rank.values());

    const candidates = new Set([
      ...lexical.keys(),
      ...[...rank]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit * 2)
        .map(([id]) => id),
    ]);
    const hits: FeatureHit[] = [];
    for (const id of candidates) {
      const node = this.#index.node(id);
      if (!node || !(SYMBOL_KINDS.has(node.kind) || node.kind === "module")) continue;
      const lex = (lexical.get(id)?.score ?? 0) / maxLexical;
      const graph = (rank.get(id) ?? 0) / maxRank;
      let score = 0.65 * lex + 0.35 * graph;
      // Related by the graph alone: shown, but below code that actually matches the query.
      if (lex === 0) score *= 0.6;
      if (ENTRY_POINT_KINDS.has(node.kind)) score *= 1.15;
      if (node.kind === "module") score *= 0.8; // prefer the symbols themselves
      // Source first: tests are reported in the territory, docs and examples rank below.
      const path = node.location?.file ?? node.qualifiedName;
      if (node.kind === "test" || isTestPath(path)) score *= 0.4;
      else if (isAuxiliaryPath(path)) score *= 0.6;
      hits.push({ id, score, lexical: lex, graph, matched: lexical.get(id)?.matched ?? [] });
    }
    hits.sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
    // At most three hits per module, so one file full of similar names cannot fill the list.
    const perModule = new Map<string, number>();
    const top: FeatureHit[] = [];
    for (const hit of hits) {
      if (top.length >= limit) break;
      const mod = this.#index.moduleOf(hit.id) ?? hit.id;
      const count = perModule.get(mod) ?? 0;
      if (count >= 3) continue;
      perModule.set(mod, count + 1);
      top.push(hit);
    }
    return { query, terms: base, hits: top, territory: this.#territory(top) };
  }

  #territory(hits: FeatureHit[]): FeatureResult["territory"] {
    const index = this.#index;
    const moduleScores = new Map<string, number>();
    for (const hit of hits) {
      const mod = index.moduleOf(hit.id);
      if (mod) moduleScores.set(mod, (moduleScores.get(mod) ?? 0) + hit.score);
    }
    /** Nodes of a kind that are hits or reach hits backwards, nearest first, capped. */
    const reaching = (kindTest: (node: GraphNode) => boolean, maxHops: number): string[] => {
      const found: string[] = [];
      let frontier = hits.map((h) => h.id);
      const seen = new Set(frontier);
      const collect = (ids: string[]): void => {
        found.push(
          ...ids.filter((id) => kindTest(index.node(id) as GraphNode)).sort(compareStrings),
        );
      };
      collect(frontier);
      for (
        let hop = 0;
        hop < maxHops && frontier.length > 0 && found.length < TERRITORY_LIMIT;
        hop++
      ) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const edge of index.in(id, [...CALL_KINDS, "references"])) {
            if (seen.has(edge.source)) continue;
            seen.add(edge.source);
            next.push(edge.source);
          }
        }
        collect(next);
        frontier = next;
      }
      return found.slice(0, TERRITORY_LIMIT);
    };
    return {
      modules: [...moduleScores]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id)),
      entryPoints: reaching((node) => ENTRY_POINT_KINDS.has(node.kind), 4),
      tests: reaching((node) => node.kind === "test", 3),
    };
  }
}
