import type { FileAnalysis, SourceFile } from "@xray/parser";
import { type Confidence, type GraphEdge, type GraphNode, moduleId } from "@xray/schema";

/**
 * Links HTTP requests in code to the routes that serve them, across languages: a React
 * component's `fetch("/api/users/" + id)` to a FastAPI `@app.get("/api/users/{id}")`, a Go
 * client's `http.Get(base + "/health")` to an Express handler. Only literal paths are followed.
 */

type Route = { node: GraphNode; method: string; segments: string[] };

const VERBS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  del: "DELETE",
  head: "HEAD",
};

/**
 * A call with a URL-like string literal as an argument: the callee chain right before `(`,
 * optional generic arguments, then the literal (", ', `, Python f-strings, C# $-strings).
 */
const CALL =
  /([A-Za-z_$][\w$]*(?:(?:\.|->|::|\?\.)[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]{0,80}>)?\s*\(\s*(?:["'][A-Z]+["']\s*,\s*)?(?:[a-zA-Z_$][\w.$]*\s*\+\s*)?[fF$@]?(["'`])((?:https?:\/\/[^/"'`\s]+)?\/?(?:[A-Za-z0-9_\-.~/:{}<>[\]*]|\$\{[^}\n]*\})*)\2/g;

/** Callee names that send requests (the last segment, lowercased). */
const CLIENT =
  /^(fetch|request|newrequest|newrequestwithcontext|ajax|send|get|post|put|patch|delete|del|head|getasync|postasync|putasync|patchasync|deleteasync|getfromjsonasync|postasjsonasync|putasjsonasync|getstringasync|getforobject|getforentity|postforobject|postforentity|exchange|uri|url)$/;

/** Client methods commonly given paths relative to a base address. */
const RELATIVE =
  /^(getasync|postasync|putasync|patchasync|deleteasync|getfromjsonasync|postasjsonasync|putasjsonasync|getstringasync|getforobject|getforentity|postforobject|postforentity|exchange|uri)$/;

/** Receivers that define routes rather than send requests. */
const ROUTER = /^(app|router|mux|route|routes|server|fastify|blueprint|bp|engine|Route)$/;

function segmentsOf(path: string): string[] {
  return path
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => (/^[:{<[*]|^\$\{|[{}]/.test(segment) ? "*" : segment.toLowerCase()));
}

/** The route segments matching a URL's segments: all of them, or just its end. */
function matchOf(url: string[], route: string[]): "full" | "suffix" | undefined {
  const same = (a: string, b: string) => a === b || a === "*" || b === "*";
  // Catch-all routes (`/*path`, `/{rest}`) would match anything.
  if (!route.some((s) => s !== "*")) return undefined;
  if (url.length === route.length)
    return url.every((s, i) => same(s, route[i] as string)) ? "full" : undefined;
  // A route mounted under a prefix the analyzer did not see (`/api` + `/users/{id}`).
  if (route.length >= 1 && url.length > route.length) {
    const tail = url.slice(url.length - route.length);
    if (tail.every((s, i) => same(s, route[i] as string)) && route.some((s) => s !== "*"))
      return "suffix";
  }
  return undefined;
}

/** Callees that take the method as an option or argument rather than in their name. */
const GENERIC = /^(fetch|request|newrequest|newrequestwithcontext|ajax|send|exchange|uri|url)$/;

/** The HTTP method of a request: from the callee (`axios.post`), `method:` options, or GET. */
function methodOf(callee: string, call: string): string {
  const last =
    callee
      .split(/\.|->|::/)
      .pop()
      ?.toLowerCase() ?? "";
  if (!GENERIC.test(last)) {
    const verb = /^(get|post|put|patch|delete|del|head)/.exec(last)?.[1];
    return verb ? (VERBS[verb] as string) : "GET";
  }
  const option =
    /method\s*[:=]\s*["'`]?(\w+)/i.exec(call)?.[1] ?? /\(\s*["']([A-Z]+)["']\s*,/.exec(call)?.[1];
  return option ? (VERBS[option.toLowerCase()] ?? option.toUpperCase()) : "GET";
}

/** The text of a call up to its closing parenthesis (at most 400 characters). */
function callText(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  const end = Math.min(text.length, open + 400);
  for (let i = open; i < end; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = undefined;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open, end);
}

/** Lines where each file defines routes, so route definitions are not read as requests. */
function routeLines(analyses: readonly FileAnalysis[]): Set<string> {
  const lines = new Set<string>();
  for (const analysis of analyses) {
    for (const node of analysis.nodes) {
      if (node.kind === "route" && node.location)
        lines.add(`${analysis.path}:${node.location.line}`);
    }
  }
  return lines;
}

/** The innermost function, method, test or route containing a line, or the module. */
function enclosing(analysis: FileAnalysis, line: number, language: SourceFile["language"]): string {
  let best: GraphNode | undefined;
  for (const node of analysis.nodes) {
    if (
      !["function", "method", "test", "route", "component", "variable", "property"].includes(
        node.kind,
      )
    )
      continue;
    const at = node.location;
    if (!at || at.line > line || (at.endLine ?? at.line) < line) continue;
    if (!best || at.line >= (best.location?.line ?? 0)) best = node;
  }
  return best?.id ?? moduleId(language, analysis.path);
}

/**
 * `calls` edges (detail `http`) from requests to the routes they reach, by requesting file.
 * Plugins' analyses are left as they are (plugins reuse them between scans).
 */
export function linkHttpCalls(
  analyses: readonly FileAnalysis[],
  files: ReadonlyMap<string, SourceFile>,
): Map<string, GraphEdge[]> {
  const links = new Map<string, GraphEdge[]>();
  const routes: Route[] = [];
  for (const analysis of analyses) {
    for (const node of analysis.nodes) {
      const path = node.kind === "route" ? (node.meta?.path as string | undefined) : undefined;
      if (path === undefined) continue;
      routes.push({ node, method: String(node.meta?.method ?? "ANY"), segments: segmentsOf(path) });
    }
  }
  if (routes.length === 0) return links;
  const definitions = routeLines(analyses);
  for (const analysis of analyses) {
    const file = files.get(analysis.path);
    if (!file) continue;
    const lineStarts = [0];
    for (let i = 0; i < file.text.length; i++) if (file.text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const seen = new Set<string>();
    for (const match of file.text.matchAll(CALL)) {
      const [, callee = "", , url = ""] = match;
      const parts = callee.split(/\.|->|::|\?\./);
      const last = parts.at(-1)?.toLowerCase() ?? "";
      if (!CLIENT.test(last)) continue;
      // Decorators, annotations and attributes declare routes: @app.get(…), #[get(…)].
      if (/[@[]\s*$/.test(file.text.slice(Math.max(0, match.index - 3), match.index))) continue;
      // `app.get("/x", handler)` and friends define routes.
      if (parts.length > 1 && ROUTER.test(parts.at(-2) as string) && last !== "fetch") continue;
      // A bare word ("tree", "id") is a URL only for clients that take relative paths
      // (`client.GetAsync("api/users")`); elsewhere a path starts with / or a scheme.
      if (!/^(https?:\/\/|\/)/.test(url) && !RELATIVE.test(last)) continue;
      const segments = segmentsOf(url);
      // `"/api/users/" + id`: the concatenated value is one more segment.
      if (url.endsWith("/") && /^\s*\+/.test(file.text.slice(match.index + match[0].length))) {
        segments.push("*");
      }
      // The bare root is too generic to say which server it reaches.
      if (segments.length === 0) continue;
      const line = lineOf(match.index);
      if (definitions.has(`${analysis.path}:${line}`)) continue;
      // Examples in comments and docs are not requests.
      if (/^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(file.text.slice(lineStarts[line - 1], match.index)))
        continue;
      const method = methodOf(callee, callText(file.text, match.index + callee.length));
      // The best routes: full matches before suffix matches, more literal segments first.
      let best: { route: Route; kind: "full" | "suffix"; literal: number }[] = [];
      for (const route of routes) {
        if (route.method !== "ANY" && method !== route.method) continue;
        const kind = matchOf(segments, route.segments);
        if (!kind) continue;
        const literal = route.segments.filter((s) => s !== "*").length;
        const candidate = { route, kind, literal };
        const top = best[0];
        const better =
          !top ||
          (kind === "full" && top.kind === "suffix") ||
          (kind === top.kind && literal > top.literal);
        if (better) best = [candidate];
        else if (kind === top.kind && literal === top.literal) best.push(candidate);
      }
      if (best.length === 0 || best.length > 3) continue;
      const source = enclosing(analysis, line, file.language);
      for (const { route, kind } of best) {
        const key = `${source}\u0000${route.node.id}\u0000${line}`;
        if (seen.has(key) || source === route.node.id) continue;
        seen.add(key);
        const column = match.index - (lineStarts[line - 1] as number) + 1;
        const confidence: Confidence = kind === "full" ? "inferred" : "heuristic";
        const edge: GraphEdge = {
          source,
          target: route.node.id,
          kind: "calls",
          confidence,
          detail: "http",
          location: { file: analysis.path, line, column },
        };
        const list = links.get(analysis.path) ?? [];
        list.push(edge);
        links.set(analysis.path, list);
      }
    }
  }
  return links;
}
