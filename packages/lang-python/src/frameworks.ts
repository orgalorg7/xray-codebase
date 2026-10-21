import type { SyntaxNode } from "@xray/parser";
import { type GraphNode, moduleId, symbolId } from "@xray/schema";
import { type Def, field, type ModuleInfo, stringValue } from "./extract.js";
import { defId, locationOf, type PythonProject } from "./resolve.js";

const ROUTE_DECORATORS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "route",
  "api_route",
  "websocket",
]);
const CLI_DECORATORS = new Set(["command", "group"]);
const DJANGO_ROUTES = new Set(["path", "re_path", "url"]);

const named = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((n): n is SyntaxNode => n !== null);

function args(call: SyntaxNode): { positional: SyntaxNode[]; keywords: Map<string, SyntaxNode> } {
  const positional: SyntaxNode[] = [];
  const keywords = new Map<string, SyntaxNode>();
  const list = field(call, "arguments");
  for (const arg of list ? named(list) : []) {
    if (arg.type === "keyword_argument") {
      const name = field(arg, "name")?.text;
      const value = field(arg, "value");
      if (name && value) keywords.set(name, value);
    } else positional.push(arg);
  }
  return { positional, keywords };
}

/** The final name of a decorator: `app.get(...)` → get, `click.command` → command. */
function decoratorName(
  expr: SyntaxNode,
): { name: string; call: SyntaxNode | undefined } | undefined {
  const call = expr.type === "call" ? expr : undefined;
  const target = call ? field(call, "function") : expr;
  if (target?.type === "attribute") {
    const name = field(target, "attribute")?.text;
    return name ? { name, call } : undefined;
  }
  if (target?.type === "identifier") return { name: target.text, call };
  return undefined;
}

/**
 * Finds HTTP routes (FastAPI, Flask, Django urls) and CLI commands (click, typer) and adds them
 * as entry-point nodes with `handles` edges to their handler.
 */
export function detectFrameworks(project: PythonProject, mod: ModuleInfo): Map<number, string> {
  const builder = project.builder;
  const mid = moduleId("py", mod.path);

  const entry = (
    kind: GraphNode["kind"],
    qualifiedName: string,
    at: SyntaxNode,
    meta: Record<string, unknown>,
    handler: { def: Def; mod: ModuleInfo },
  ): void => {
    const id = symbolId("py", mod.path, qualifiedName);
    builder.node(mod.path, {
      id,
      kind,
      name: qualifiedName,
      qualifiedName,
      language: "py",
      location: locationOf(at, mod.path),
      meta,
    });
    builder.edge(mod.path, { source: mid, target: id, kind: "contains", confidence: "exact" });
    builder.edge(mod.path, {
      source: id,
      target: defId(handler.mod, handler.def),
      kind: "handles",
      confidence: "exact",
      location: locationOf(at, mod.path),
    });
  };

  for (const def of mod.allDefs) {
    if (def.kind === "class" || def.kind === "variable" || def.kind === "property") continue;
    for (const decorator of def.decorators) {
      const info = decoratorName(decorator);
      if (!info) continue;
      const call = info.call;

      if (ROUTE_DECORATORS.has(info.name) && call) {
        const { positional, keywords } = args(call);
        const path = stringValue(positional[0] ?? keywords.get("path"));
        if (path === undefined || !(path.startsWith("/") || path === "")) continue;
        let methods: string[];
        if (info.name === "websocket") methods = ["WS"];
        else if (info.name === "route" || info.name === "api_route") {
          const list = keywords.get("methods");
          methods = list
            ? named(list).flatMap((m) => stringValue(m)?.toUpperCase() ?? [])
            : ["GET"];
          if (methods.length === 0) methods = ["GET"];
        } else methods = [info.name.toUpperCase()];
        for (const method of methods) {
          entry(
            "route",
            `${method} ${path || "/"}`,
            decorator,
            { method, path: path || "/", framework: "http" },
            { def, mod },
          );
        }
      } else if (CLI_DECORATORS.has(info.name)) {
        const { positional, keywords } = call
          ? args(call)
          : { positional: [], keywords: new Map<string, SyntaxNode>() };
        const name =
          stringValue(positional[0] ?? keywords.get("name")) ?? def.name.replaceAll("_", "-");
        entry(
          "cli-command",
          `command:${name}`,
          decorator,
          { command: name, group: info.name === "group" },
          { def, mod },
        );
      }
    }
  }

  if (/(^|\/)urls\.py$/.test(mod.path)) {
    for (const call of mod.tree.rootNode.descendantsOfType("call")) {
      if (!call) continue;
      const fn = field(call, "function");
      const name = fn?.type === "attribute" ? field(fn, "attribute")?.text : fn?.text;
      if (!name || !DJANGO_ROUTES.has(name)) continue;
      const { positional } = args(call);
      const route = stringValue(positional[0]);
      let view = positional[1];
      if (route === undefined || !view) continue;
      // SomeView.as_view() → SomeView
      if (view.type === "call") {
        const inner = field(view, "function");
        view = inner?.type === "attribute" ? (field(inner, "object") ?? view) : view;
      }
      const value = project.evaluate(view, { mod });
      if (value?.t !== "def") continue;
      const path = `/${route.replace(/^\^|\$$/g, "").replace(/^\//, "")}`;
      entry(
        "route",
        `ANY ${path}`,
        call,
        { method: "ANY", path, framework: "django" },
        { def: value.def, mod: value.mod },
      );
    }
  }
  return new Map();
}
