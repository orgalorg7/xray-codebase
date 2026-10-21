import { dirname } from "node:path";
import type { AnalysisBuilder, SyntaxNode } from "@xray/parser";
import {
  type Confidence,
  externalId,
  type GraphEdge,
  type GraphNode,
  moduleId,
  type SourceLocation,
  symbolId,
} from "@xray/schema";
import { type Def, field, type ImportRecord, type ModuleInfo } from "./extract.js";
import { detectFrameworks } from "./frameworks.js";
import { STDLIB_MODULES } from "./stdlib.js";

/** How a member was reached, which decides an edge's confidence and detail. */
type Via = "self" | "super" | "cls" | "inferred" | undefined;

export type Value =
  | { t: "def"; def: Def; mod: ModuleInfo; via?: Via }
  | { t: "module"; mod: ModuleInfo }
  | { t: "instance"; cls: Def; mod: ModuleInfo; via: Via }
  | { t: "cls"; cls: Def; mod: ModuleInfo }
  | { t: "super"; cls: Def; mod: ModuleInfo }
  | { t: "external"; name: string };

type Local =
  | { kind: "param"; index: number; annotation: SyntaxNode | null }
  | { kind: "assign"; values: SyntaxNode[]; annotation: SyntaxNode | null }
  | { kind: "import"; record: ImportRecord }
  | { kind: "unknown" };

type Context = { mod: ModuleInfo; def?: Def; cls?: Def };

const BUILTIN_METHOD_STOPLIST = new Set([
  "append",
  "extend",
  "insert",
  "remove",
  "pop",
  "clear",
  "copy",
  "count",
  "index",
  "sort",
  "reverse",
  "get",
  "items",
  "keys",
  "values",
  "update",
  "setdefault",
  "add",
  "discard",
  "join",
  "split",
  "strip",
  "lstrip",
  "rstrip",
  "replace",
  "format",
  "startswith",
  "endswith",
  "lower",
  "upper",
  "encode",
  "decode",
  "read",
  "write",
  "close",
  "open",
  "send",
  "run",
  "start",
  "stop",
  "save",
  "delete",
  "filter",
  "all",
  "first",
  "exists",
  "create",
  "find",
  "match",
  "search",
  "sub",
  "group",
  "info",
  "debug",
  "warning",
  "error",
  "exception",
  "log",
  "put",
  "post",
  "patch",
  "head",
]);

const named = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((n): n is SyntaxNode => n !== null);

export function locationOf(node: SyntaxNode, path: string): SourceLocation {
  return {
    file: path,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

export const defId = (mod: ModuleInfo, def: Def): string =>
  symbolId("py", mod.path, def.qualifiedName);

/**
 * Cross-module resolution for a Python project: module naming, import binding, class MRO and
 * a small evaluator that infers what an expression refers to.
 */
export class PythonProject {
  readonly modules: ModuleInfo[];
  readonly builder: AnalysisBuilder;
  readonly #byName = new Map<string, ModuleInfo>();
  readonly #primaryName = new Map<ModuleInfo, string>();
  readonly #callables = new Map<string, { mod: ModuleInfo; def: Def }[]>();
  readonly #exportMemo = new Map<string, Value | undefined>();
  readonly #locals = new Map<Def, Map<string, Local>>();
  readonly #mro = new Map<Def, { def: Def; mod: ModuleInfo }[]>();
  readonly #instanceAttrs = new Map<Def, Map<string, { value: SyntaxNode; method: Def }>>();
  readonly #defModule = new Map<Def, ModuleInfo>();
  /** Initializers being evaluated, to cut `x = x.y`-style cycles. */
  readonly #evaluating = new Set<number>();

  constructor(modules: ModuleInfo[], builder: AnalysisBuilder) {
    this.modules = modules;
    this.builder = builder;
    const packageDirs = new Set(modules.filter((m) => m.isPackage).map((m) => dirname(m.path)));
    const hasInit = (dir: string): boolean => packageDirs.has(dir);
    for (const mod of modules) {
      for (const name of this.#candidateNames(mod.path, hasInit)) {
        if (!this.#byName.has(name)) this.#byName.set(name, mod);
        if (!this.#primaryName.has(mod)) this.#primaryName.set(mod, name);
      }
      for (const def of mod.allDefs) {
        this.#defModule.set(def, mod);
        if (def.kind === "method") {
          const list = this.#callables.get(def.name) ?? [];
          list.push({ mod, def });
          this.#callables.set(def.name, list);
        }
      }
    }
  }

  /** Dotted names a file is importable as: from its package root, the repo root and `src/`. */
  #candidateNames(path: string, hasInit: (dir: string) => boolean): string[] {
    const stem = path.replace(/\.pyi?$/, "").replace(/(^|\/)__init__$/, "");
    let root = dirname(path);
    // Walk up through regular packages, and through namespace packages (PEP 420: no __init__.py)
    // nested inside a regular one, like flask/sansio/.
    while (root !== "." && (hasInit(root) || hasInit(dirname(root)))) root = dirname(root);
    const fromRoot = (base: string): string | undefined => {
      if (base === "." || base === "") return stem;
      return stem.startsWith(`${base}/`) ? stem.slice(base.length + 1) : undefined;
    };
    const names = [fromRoot(root), fromRoot("."), fromRoot("src")];
    return [...new Set(names.filter((n): n is string => n !== undefined && n !== ""))].map((n) =>
      n.replaceAll("/", "."),
    );
  }

  moduleNamed(name: string): ModuleInfo | undefined {
    return this.#byName.get(name);
  }

  /** Absolute dotted name of an import's module, resolving leading dots. */
  absoluteModule(mod: ModuleInfo, record: ImportRecord): string {
    if (record.level === 0) return record.module;
    const own = this.#primaryName.get(mod) ?? "";
    const parts = own.split(".").filter(Boolean);
    let packageParts = mod.isPackage ? parts : parts.slice(0, -1);
    packageParts = packageParts.slice(0, Math.max(0, packageParts.length - (record.level - 1)));
    return [...packageParts, ...(record.module ? record.module.split(".") : [])].join(".");
  }

  #external(name: string): Value {
    return { t: "external", name: name.split(".")[0] ?? name };
  }

  /** What `from <module> import <name>` binds. */
  #fromImport(moduleName: string, name: string): Value | undefined {
    const submodule = this.#byName.get(moduleName ? `${moduleName}.${name}` : name);
    const mod = this.#byName.get(moduleName);
    if (mod) {
      const value = this.exportOf(mod, name);
      if (value) return value;
    }
    if (submodule) return { t: "module", mod: submodule };
    return mod ? undefined : this.#external(moduleName);
  }

  /** The value an import record binds to `localName`, if it binds it. */
  bindingOf(mod: ModuleInfo, record: ImportRecord, localName: string): Value | undefined {
    const moduleName = this.absoluteModule(mod, record);
    if (record.names === undefined) {
      if (record.alias !== undefined) {
        if (record.alias !== localName) return undefined;
        const target = this.#byName.get(moduleName);
        return target ? { t: "module", mod: target } : this.#external(moduleName);
      }
      const head = moduleName.split(".")[0];
      if (head !== localName) return undefined;
      const target = this.#byName.get(head);
      return target ? { t: "module", mod: target } : this.#external(head);
    }
    if (record.names === "*") {
      const target = this.#byName.get(moduleName);
      if (!target || localName.startsWith("_")) return undefined;
      if (target.all && !target.all.includes(localName)) return undefined;
      return this.exportOf(target, localName);
    }
    const item = record.names.find((n) => (n.alias ?? n.name) === localName);
    return item ? this.#fromImport(moduleName, item.name) : undefined;
  }

  /** The value of a module-level name, following imports and package submodules. */
  exportOf(mod: ModuleInfo, name: string): Value | undefined {
    const key = `${mod.path}\u0000${name}`;
    if (this.#exportMemo.has(key)) return this.#exportMemo.get(key);
    this.#exportMemo.set(key, undefined); // cycle guard
    let value: Value | undefined;
    const def = mod.defs.get(name);
    if (def) value = { t: "def", def, mod };
    else {
      const imports = mod.imports.filter((r) => r.scope === undefined);
      for (const record of [...imports].reverse()) {
        if (record.names === "*") continue;
        value = this.bindingOf(mod, record, name);
        if (value) break;
      }
      if (!value && mod.isPackage) {
        const own = this.#primaryName.get(mod);
        const sub = own && this.#byName.get(`${own}.${name}`);
        if (sub) value = { t: "module", mod: sub };
      }
      if (!value) {
        for (const record of imports) {
          if (record.names !== "*") continue;
          value = this.bindingOf(mod, record, name);
          if (value) break;
        }
      }
    }
    this.#exportMemo.set(key, value);
    return value;
  }

  // ---- classes -------------------------------------------------------------------------

  moduleOf(def: Def): ModuleInfo {
    return this.#defModule.get(def) as ModuleInfo;
  }

  bases(cls: Def): { def: Def; mod: ModuleInfo; node: SyntaxNode }[] {
    const mod = this.moduleOf(cls);
    const list = field(cls.definition, "superclasses");
    if (!list) return [];
    return named(list).flatMap((expr) => {
      if (expr.type === "keyword_argument") return [];
      const value = this.evaluate(expr, { mod });
      return value?.t === "def" && value.def.kind === "class"
        ? [{ def: value.def, mod: value.mod, node: expr }]
        : [];
    });
  }

  /** Method resolution order, approximated by a left-to-right depth-first walk. */
  mro(cls: Def): { def: Def; mod: ModuleInfo }[] {
    const memo = this.#mro.get(cls);
    if (memo) return memo;
    const order: { def: Def; mod: ModuleInfo }[] = [];
    this.#mro.set(cls, order); // cycle guard
    const seen = new Set<Def>();
    const visit = (def: Def, mod: ModuleInfo): void => {
      if (seen.has(def)) return;
      seen.add(def);
      order.push({ def, mod });
      for (const base of this.bases(def)) visit(base.def, base.mod);
    };
    visit(cls, this.moduleOf(cls));
    return order;
  }

  member(cls: Def, name: string, skipSelf = false): { def: Def; mod: ModuleInfo } | undefined {
    const order = this.mro(cls);
    for (const entry of skipSelf ? order.slice(1) : order) {
      const def = entry.def.members.get(name);
      if (def) return { def, mod: entry.mod };
    }
    return undefined;
  }

  /** `self.attr = <expr>` assignments in a class's methods. */
  #instanceAttribute(cls: Def, name: string): { value: SyntaxNode; method: Def } | undefined {
    let attrs = this.#instanceAttrs.get(cls);
    if (!attrs) {
      attrs = new Map();
      this.#instanceAttrs.set(cls, attrs);
      for (const method of cls.members.values()) {
        if (method.kind !== "method" || method.methodKind !== "instance") continue;
        const self = this.#firstParam(method);
        for (const assignment of method.definition.descendantsOfType("assignment")) {
          const left = assignment && field(assignment, "left");
          const right = assignment && field(assignment, "right");
          if (left?.type !== "attribute" || !right || field(left, "object")?.text !== self)
            continue;
          const attr = field(left, "attribute")?.text;
          if (attr && !attrs.has(attr)) attrs.set(attr, { value: right, method });
        }
      }
    }
    for (const entry of this.mro(cls)) {
      const found = (entry.def === cls ? attrs : undefined)?.get(name);
      if (found) return found;
      if (entry.def !== cls) {
        const inherited = this.#instanceAttribute(entry.def, name);
        if (inherited) return inherited;
      }
    }
    return undefined;
  }

  // ---- evaluation ----------------------------------------------------------------------

  #firstParam(def: Def): string | undefined {
    const params = field(def.definition, "parameters");
    const first = params ? named(params)[0] : undefined;
    if (!first) return undefined;
    return first.type === "identifier"
      ? first.text
      : (field(first, "name")?.text ?? named(first)[0]?.text);
  }

  /** Names bound inside a function: parameters, assignments, local imports and shadowing targets. */
  #localsOf(def: Def): Map<string, Local> {
    const memo = this.#locals.get(def);
    if (memo) return memo;
    const locals = new Map<string, Local>();
    this.#locals.set(def, locals);
    const params = field(def.definition, "parameters");
    named(params ?? def.definition)
      .filter(() => params !== null)
      .forEach((param, index) => {
        let name: string | undefined;
        let annotation: SyntaxNode | null = null;
        if (param.type === "identifier") name = param.text;
        else if (param.type === "typed_parameter") {
          name = named(param).find((n) => n.type === "identifier")?.text;
          annotation = field(param, "type");
        } else if (param.type === "typed_default_parameter") {
          name = field(param, "name")?.text;
          annotation = field(param, "type");
        } else if (param.type === "default_parameter") name = field(param, "name")?.text;
        else name = named(param).find((n) => n.type === "identifier")?.text; // *args, **kwargs
        if (name) locals.set(name, { kind: "param", index, annotation });
      });

    const globals = new Set<string>();
    const shadow = (target: SyntaxNode | null): void => {
      if (!target) return;
      if (target.type === "identifier") {
        if (!locals.has(target.text)) locals.set(target.text, { kind: "unknown" });
        return;
      }
      for (const child of named(target)) shadow(child);
    };
    const visit = (node: SyntaxNode): void => {
      switch (node.type) {
        case "function_definition":
        case "class_definition": {
          if (node.id !== def.definition.id) {
            shadow(field(node, "name"));
            return;
          }
          break;
        }
        case "lambda":
          return;
        case "global_statement":
        case "nonlocal_statement":
          for (const name of named(node)) globals.add(name.text);
          return;
        case "assignment": {
          const left = field(node, "left");
          const right = field(node, "right");
          if (left?.type === "identifier") {
            const existing = locals.get(left.text);
            if (existing?.kind === "assign") {
              if (right) existing.values.push(right);
            } else if (existing === undefined) {
              locals.set(left.text, {
                kind: "assign",
                values: right ? [right] : [],
                annotation: field(node, "type"),
              });
            }
          } else shadow(left);
          break;
        }
        case "named_expression": {
          const name = field(node, "name");
          const value = field(node, "value");
          if (name && value && !locals.has(name.text)) {
            locals.set(name.text, { kind: "assign", values: [value], annotation: null });
          }
          break;
        }
        case "for_statement":
        case "for_in_clause":
          shadow(field(node, "left"));
          break;
        case "as_pattern_target":
          shadow(named(node)[0] ?? null);
          return;
        case "augmented_assignment":
          shadow(field(node, "left")?.type === "identifier" ? field(node, "left") : null);
          break;
      }
      for (const child of named(node)) visit(child);
    };
    const body = field(def.definition, "body");
    if (body) visit(body);
    for (const record of this.moduleOf(def).imports) {
      if (record.scope !== def) continue;
      for (const local of this.#importedNames(record))
        locals.set(local, { kind: "import", record });
    }
    for (const name of globals) locals.delete(name);
    return locals;
  }

  #importedNames(record: ImportRecord): string[] {
    if (record.names === "*") return [];
    if (record.names === undefined) return [record.alias ?? record.module.split(".")[0] ?? ""];
    return record.names.map((n) => n.alias ?? n.name);
  }

  /** The value an identifier refers to in `ctx`. */
  lookup(name: string, ctx: Context, depth = 0): Value | undefined {
    if (ctx.def && ctx.def.kind !== "class") {
      const local = this.#localsOf(ctx.def).get(name);
      if (local) return this.#localValue(local, name, ctx, depth);
    }
    return this.exportOf(ctx.mod, name);
  }

  #localValue(local: Local, name: string, ctx: Context, depth: number): Value | undefined {
    const def = ctx.def as Def;
    switch (local.kind) {
      case "param": {
        if (local.index === 0 && ctx.cls && def.kind !== "function") {
          if (def.methodKind === "instance")
            return { t: "instance", cls: ctx.cls, mod: this.moduleOf(ctx.cls), via: "self" };
          if (def.methodKind === "class")
            return { t: "cls", cls: ctx.cls, mod: this.moduleOf(ctx.cls) };
        }
        return local.annotation ? this.#annotationValue(local.annotation, ctx, depth) : undefined;
      }
      case "assign": {
        if (local.annotation) return this.#annotationValue(local.annotation, ctx, depth);
        const values = local.values.map((v) => this.#evaluateOnce(v, ctx, depth));
        const first = values[0];
        // Only trust a binding whose every assignment agrees.
        if (!first || values.some((v) => !sameValue(v, first))) return undefined;
        return first;
      }
      case "import":
        return this.bindingOf(ctx.mod, local.record, name);
      case "unknown":
        return undefined;
    }
  }

  #annotationValue(annotation: SyntaxNode, ctx: Context, depth: number): Value | undefined {
    let expr: SyntaxNode | undefined =
      annotation.type === "type" ? named(annotation)[0] : annotation;
    if (expr?.type === "string") {
      const text = expr.text.replace(/^['"]+|['"]+$/g, "");
      const parts = text.split(".");
      let value = this.lookup(parts[0] ?? "", { mod: ctx.mod }, depth + 1);
      for (const part of parts.slice(1)) value = value && this.attribute(value, part, depth + 1);
      return value?.t === "def" && value.def.kind === "class"
        ? { t: "instance", cls: value.def, mod: value.mod, via: "inferred" }
        : undefined;
    }
    if (expr?.type === "generic_type") expr = undefined; // list[Foo], Optional[Foo]: not modelled yet
    if (!expr) return undefined;
    const value = this.evaluate(expr, ctx, depth + 1);
    return value?.t === "def" && value.def.kind === "class"
      ? { t: "instance", cls: value.def, mod: value.mod, via: "inferred" }
      : undefined;
  }

  /** What an expression evaluates to, as far as static analysis can tell. */
  evaluate(expr: SyntaxNode, ctx: Context, depth = 0): Value | undefined {
    if (depth > 12) return undefined;
    switch (expr.type) {
      case "identifier":
        return this.lookup(expr.text, ctx, depth);
      case "attribute": {
        const object = field(expr, "object");
        const attr = field(expr, "attribute")?.text;
        const base = object && this.evaluate(object, ctx, depth + 1);
        return base && attr ? this.attribute(base, attr, depth + 1) : undefined;
      }
      case "call": {
        const fn = field(expr, "function");
        if (
          fn?.type === "identifier" &&
          fn.text === "super" &&
          ctx.cls &&
          !this.#isShadowed("super", ctx)
        ) {
          return { t: "super", cls: ctx.cls, mod: this.moduleOf(ctx.cls) };
        }
        const callee = fn && this.evaluate(fn, ctx, depth + 1);
        return callee ? this.#callResult(callee, depth) : undefined;
      }
      case "parenthesized_expression": {
        const inner = named(expr)[0];
        return inner ? this.evaluate(inner, ctx, depth + 1) : undefined;
      }
      case "await": {
        const inner = named(expr)[0];
        return inner ? this.evaluate(inner, ctx, depth + 1) : undefined;
      }
      default:
        return undefined;
    }
  }

  #isShadowed(name: string, ctx: Context): boolean {
    return ctx.def !== undefined && ctx.def.kind !== "class" && this.#localsOf(ctx.def).has(name);
  }

  #callResult(callee: Value, depth: number): Value | undefined {
    // Whatever an external library returns is still external: not a candidate for guessing.
    if (callee.t === "external") return callee;
    if (callee.t === "def" && callee.def.kind === "class") {
      return { t: "instance", cls: callee.def, mod: callee.mod, via: "inferred" };
    }
    if (callee.t === "cls")
      return { t: "instance", cls: callee.cls, mod: callee.mod, via: "inferred" };
    if (callee.t === "def" && (callee.def.kind === "function" || callee.def.kind === "method")) {
      const returns = field(callee.def.definition, "return_type");
      if (!returns) return undefined;
      const cls = callee.def.parent;
      return this.#annotationValue(
        returns,
        { mod: callee.mod, ...(cls ? { cls } : {}) },
        depth + 1,
      );
    }
    return undefined;
  }

  /** Attribute access on a value. */
  attribute(base: Value, name: string, depth = 0): Value | undefined {
    if (depth > 12) return undefined;
    switch (base.t) {
      case "module":
        return this.exportOf(base.mod, name);
      case "def": {
        if (base.def.kind === "class") {
          const found = this.member(base.def, name);
          return found && { t: "def", def: found.def, mod: found.mod };
        }
        if (base.def.kind === "variable" || base.def.kind === "property") {
          // settings = Settings(); settings.greeting
          const right = field(base.def.definition, "right");
          const ctx: Context = {
            mod: base.mod,
            ...(base.def.parent ? { cls: base.def.parent } : {}),
          };
          const value = right && this.#evaluateOnce(right, ctx, depth);
          return value ? this.attribute(value, name, depth + 1) : undefined;
        }
        return undefined;
      }
      case "instance": {
        const found = this.member(base.cls, name);
        if (found) return { t: "def", def: found.def, mod: found.mod, via: base.via };
        const attr = this.#instanceAttribute(base.cls, name);
        if (!attr) return undefined;
        const ctx: Context = { mod: this.moduleOf(attr.method), def: attr.method, cls: base.cls };
        const value = this.#evaluateOnce(attr.value, ctx, depth);
        if (value?.t === "instance") return { ...value, via: "inferred" };
        return value;
      }
      case "cls": {
        const found = this.member(base.cls, name);
        return found && { t: "def", def: found.def, mod: found.mod, via: "cls" };
      }
      case "super": {
        const found = this.member(base.cls, name, true);
        return found && { t: "def", def: found.def, mod: found.mod, via: "super" };
      }
      case "external":
        return base;
    }
  }

  /** Evaluates an initializer unless it is already being evaluated (`x = x.y` style cycles). */
  #evaluateOnce(expr: SyntaxNode, ctx: Context, depth: number): Value | undefined {
    if (this.#evaluating.has(expr.id)) return undefined;
    this.#evaluating.add(expr.id);
    try {
      return this.evaluate(expr, ctx, depth + 1);
    } finally {
      this.#evaluating.delete(expr.id);
    }
  }

  heuristicCallable(name: string): { mod: ModuleInfo; def: Def } | undefined {
    if (BUILTIN_METHOD_STOPLIST.has(name) || name.startsWith("__") || name.length < 3)
      return undefined;
    const candidates = this.#callables.get(name);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }

  // ---- emission ------------------------------------------------------------------------

  emit(): void {
    for (const mod of this.modules) {
      this.#emitNodes(mod);
    }
    for (const mod of this.modules) {
      try {
        const owners = detectFrameworks(this, mod);
        this.#emitImports(mod);
        this.#emitClasses(mod);
        new BodyWalker(this, mod, owners).run();
      } catch (error) {
        this.builder.diagnostics.push({
          severity: "error",
          file: mod.path,
          message: `resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  #emitNodes(mod: ModuleInfo): void {
    const mid = moduleId("py", mod.path);
    this.builder.node(mod.path, {
      id: mid,
      kind: "module",
      name: mod.path.split("/").at(-1) ?? mod.path,
      qualifiedName: mod.path,
      language: "py",
      location: { file: mod.path, line: 1, column: 1 },
      // Without __all__, every public name counts as exported, which says little about intent.
      ...(mod.all ? {} : { meta: { implicitExports: true } }),
    });
    for (const def of mod.allDefs) {
      const node: GraphNode = {
        id: defId(mod, def),
        kind: def.kind,
        name: def.name,
        qualifiedName: def.qualifiedName,
        language: "py",
        location: locationOf(def.node, mod.path),
      };
      if (def.signature) node.signature = def.signature;
      if (def.doc) node.doc = def.doc;
      if (!def.parent) {
        node.exported = mod.all ? mod.all.includes(def.name) : !def.name.startsWith("_");
      }
      const meta: Record<string, unknown> = {};
      if (def.decorators.length > 0) meta.decorators = def.decorators.map((d) => d.text);
      if (def.methodKind && def.methodKind !== "instance") meta.methodKind = def.methodKind;
      if (Object.keys(meta).length > 0) node.meta = meta;
      this.builder.node(mod.path, node);
      const parent = def.parent ? defId(mod, def.parent) : mid;
      this.builder.edge(mod.path, {
        source: parent,
        target: node.id,
        kind: "contains",
        confidence: "exact",
      });
    }
  }

  #moduleTarget(name: string): string | undefined {
    const mod = this.#byName.get(name);
    if (mod) return moduleId("py", mod.path);
    // `import pkg.missing` inside the project: link to the deepest module that exists.
    const parts = name.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = this.#byName.get(parts.slice(0, i).join("."));
      if (prefix) return moduleId("py", prefix.path);
    }
    const top = parts[0] ?? name;
    if (top === "" || STDLIB_MODULES.has(top)) return undefined;
    const id = externalId("pypi", top);
    this.builder.sharedNode({
      id,
      kind: "external",
      name: top,
      qualifiedName: top,
      meta: { registry: "pypi" },
    });
    return id;
  }

  #emitImports(mod: ModuleInfo): void {
    const source = moduleId("py", mod.path);
    const rank = (detail: string | undefined): number =>
      detail === undefined ? 0 : detail === "deferred" ? 1 : 2;
    const edges = new Map<string, GraphEdge>();
    const add = (target: string | undefined, record: ImportRecord): void => {
      if (target === undefined || target === source) return;
      const detail = record.typeOnly ? "type-only" : record.scope ? "deferred" : undefined;
      const previous = edges.get(target);
      if (previous && rank(previous.detail) <= rank(detail)) return;
      const edge: GraphEdge = {
        source,
        target,
        kind: "imports",
        confidence: "exact",
        location: locationOf(record.node, mod.path),
      };
      if (detail) edge.detail = detail;
      edges.set(target, edge);
    };

    for (const record of mod.imports) {
      const moduleName = this.absoluteModule(mod, record);
      if (record.names === undefined || record.names === "*") {
        add(this.#moduleTarget(moduleName), record);
        continue;
      }
      for (const item of record.names) {
        const sub = this.#byName.get(moduleName ? `${moduleName}.${item.name}` : item.name);
        const definesName = this.#byName.get(moduleName)?.defs.has(item.name) ?? false;
        add(
          sub && !definesName ? moduleId("py", sub.path) : this.#moduleTarget(moduleName),
          record,
        );
      }
    }
    for (const edge of edges.values()) this.builder.edge(mod.path, edge);
    this.#emitReExports(mod);
  }

  /** Names a package `__init__` (or any module's `__all__`) pulls in from elsewhere. */
  #emitReExports(mod: ModuleInfo): void {
    const source = moduleId("py", mod.path);
    for (const record of mod.imports) {
      if (record.scope || record.typeOnly) continue;
      if (record.names === "*") {
        if (!mod.isPackage) continue;
        const target = this.#byName.get(this.absoluteModule(mod, record));
        for (const def of target?.defs.values() ?? []) {
          if (def.name.startsWith("_") || (target?.all && !target.all.includes(def.name))) continue;
          this.#reExport(mod, source, { t: "def", def, mod: target as ModuleInfo }, "star");
        }
        continue;
      }
      for (const item of record.names ?? []) {
        const local = item.alias ?? item.name;
        if (!mod.isPackage && !mod.all?.includes(local)) continue;
        const value = this.bindingOf(mod, record, local);
        if (value)
          this.#reExport(
            mod,
            source,
            value,
            item.alias && item.alias !== item.name ? `alias:${item.alias}` : undefined,
          );
      }
    }
  }

  #reExport(mod: ModuleInfo, source: string, value: Value, detail: string | undefined): void {
    if (value.t !== "def" || value.mod === mod) return;
    const edge: GraphEdge = {
      source,
      target: defId(value.mod, value.def),
      kind: "re-exports",
      confidence: "exact",
    };
    if (detail) edge.detail = detail;
    this.builder.edge(mod.path, edge);
  }

  #emitClasses(mod: ModuleInfo): void {
    for (const cls of mod.allDefs) {
      if (cls.kind !== "class") continue;
      const id = defId(mod, cls);
      for (const base of this.bases(cls)) {
        this.builder.edge(mod.path, {
          source: id,
          target: defId(base.mod, base.def),
          kind: "extends",
          confidence: "exact",
          location: locationOf(base.node, mod.path),
        });
      }
      for (const member of cls.members.values()) {
        if (member.kind !== "method" && member.kind !== "test") continue;
        const overridden = this.member(cls, member.name, true);
        if (!overridden) continue;
        this.builder.edge(mod.path, {
          source: defId(mod, member),
          target: defId(overridden.mod, overridden.def),
          kind: "overrides",
          confidence: "exact",
          location: locationOf(member.node, mod.path),
        });
      }
    }
  }
}

function sameValue(a: Value | undefined, b: Value): boolean {
  if (!a || a.t !== b.t) return false;
  if (a.t === "def" && b.t === "def") return a.def === b.def;
  if (a.t === "module" && b.t === "module") return a.mod === b.mod;
  if ((a.t === "instance" || a.t === "cls" || a.t === "super") && a.t === b.t) {
    return a.cls === (b as { cls: Def }).cls;
  }
  if (a.t === "external" && b.t === "external") return a.name === b.name;
  return false;
}

/** Walks code and emits calls, instantiations and references, attributed to their owner. */
class BodyWalker {
  readonly #references = new Set<string>();

  constructor(
    readonly project: PythonProject,
    readonly mod: ModuleInfo,
    /** Syntax node IDs (e.g. inline handlers) owned by a framework entry point. */
    readonly owners: Map<number, string>,
  ) {}

  run(): void {
    const mid = moduleId("py", this.mod.path);
    for (const def of this.mod.allDefs) {
      if (def.kind === "class") continue;
      if (def.kind === "variable" || def.kind === "property") {
        const right = field(def.definition, "right");
        const ctx: Context = { mod: this.mod, ...(def.parent ? { cls: def.parent } : {}) };
        if (right) this.#walk(right, defId(this.mod, def), ctx);
        continue;
      }
      const body = field(def.definition, "body");
      const ctx: Context = { mod: this.mod, def, ...(def.parent ? { cls: def.parent } : {}) };
      if (body) this.#walk(body, defId(this.mod, def), ctx);
    }
    this.#walkTopLevel(this.mod.tree.rootNode, mid, undefined);
  }

  /** Module- and class-level code outside function bodies and variable initializers. */
  #walkTopLevel(block: SyntaxNode, owner: string, cls: Def | undefined): void {
    const ctx: Context = { mod: this.mod, ...(cls ? { cls } : {}) };
    for (const statement of named(block)) {
      switch (statement.type) {
        case "decorated_definition": {
          for (const decorator of named(statement).filter((n) => n.type === "decorator")) {
            this.#walk(decorator, owner, ctx);
          }
          const definition = field(statement, "definition");
          if (definition?.type === "class_definition") this.#walkClass(definition);
          break;
        }
        case "class_definition":
          this.#walkClass(statement);
          break;
        case "function_definition":
        case "import_statement":
        case "import_from_statement":
          break;
        case "expression_statement": {
          const assignment = named(statement)[0];
          const left = assignment?.type === "assignment" ? field(assignment, "left") : null;
          const prefix = cls ? `${cls.qualifiedName}.` : "";
          const def =
            left?.type === "identifier"
              ? (cls ? cls.members : this.mod.defs).get(left.text)
              : undefined;
          if (
            def &&
            def.qualifiedName === `${prefix}${left?.text}` &&
            def.definition.id === assignment?.id
          ) {
            // Initializer already walked with the variable as owner; the target is not a reference.
            break;
          }
          this.#walk(statement, owner, ctx);
          break;
        }
        default: {
          // Compound statements: walk their conditions, recurse into their blocks.
          for (const child of named(statement)) {
            if (child.type === "block") this.#walkTopLevel(child, owner, cls);
            else if (/_clause$/.test(child.type)) {
              for (const inner of named(child)) {
                if (inner.type === "block") this.#walkTopLevel(inner, owner, cls);
                else this.#walk(inner, owner, ctx);
              }
            } else this.#walk(child, owner, ctx);
          }
        }
      }
    }
  }

  #walkClass(definition: SyntaxNode): void {
    const cls = this.mod.allDefs.find((d) => d.definition.id === definition.id);
    const body = field(definition, "body");
    if (!cls || !body) return;
    this.#walkTopLevel(body, defId(this.mod, cls), cls);
  }

  #edge(edge: GraphEdge): void {
    this.project.builder.edge(this.mod.path, edge);
  }

  #walk(node: SyntaxNode, owner: string, ctx: Context): void {
    const own = this.owners.get(node.id) ?? owner;
    switch (node.type) {
      case "call":
        this.#call(node, own, ctx);
        break;
      case "identifier":
      case "attribute":
        if (this.#reference(node, own, ctx)) return;
        break;
      case "function_definition":
      case "class_definition":
        // Nested definitions run in the enclosing scope for our purposes; skip their names.
        for (const child of named(node))
          if (child !== field(node, "name")) this.#walk(child, own, ctx);
        return;
      case "keyword_argument": {
        const value = field(node, "value");
        if (value) this.#walk(value, own, ctx);
        return;
      }
      case "import_statement":
      case "import_from_statement":
      case "global_statement":
      case "nonlocal_statement":
        return;
    }
    for (const child of named(node)) this.#walk(child, own, ctx);
  }

  #call(node: SyntaxNode, owner: string, ctx: Context): void {
    const fn = field(node, "function");
    if (!fn) return;
    const location = locationOf(node, this.mod.path);
    const callee = this.project.evaluate(fn, ctx);
    if (callee === undefined) {
      if (fn.type !== "attribute") return;
      // Guess by name only when nothing is known about the receiver. A known receiver (a project
      // class, super(), an external library object) whose member is missing is not a guess.
      const receiver = field(fn, "object");
      if (receiver && this.project.evaluate(receiver, ctx) !== undefined) return;
      const name = field(fn, "attribute")?.text;
      const guess = name ? this.project.heuristicCallable(name) : undefined;
      if (guess && defId(guess.mod, guess.def) !== owner) {
        this.#edge({
          source: owner,
          target: defId(guess.mod, guess.def),
          kind: "calls",
          confidence: "heuristic",
          location,
        });
      }
      return;
    }
    if (callee.t === "cls") {
      this.#edge({
        source: owner,
        target: defId(callee.mod, callee.cls),
        kind: "instantiates",
        confidence: "inferred",
        detail: "cls-call",
        location,
      });
      return;
    }
    if (callee.t !== "def") return;
    const target = defId(callee.mod, callee.def);
    if (target === owner) return;
    const confidence: Confidence = callee.via === "inferred" ? "inferred" : "exact";
    const edge: GraphEdge = {
      source: owner,
      target,
      kind: callee.def.kind === "class" ? "instantiates" : "calls",
      confidence,
      location,
    };
    if (callee.via === "self") edge.detail = "self-call";
    else if (callee.via === "super") edge.detail = "super-call";
    else if (callee.via === "cls") edge.detail = "cls-call";
    if (callee.def.kind === "property") return;
    // Calling a variable (a callback, a configured client) uses it: record a reference.
    if (callee.def.kind === "variable") edge.kind = "references";
    this.#edge(edge);
  }

  /**
   * Emits a reference for a maximal name or attribute chain that resolves to a definition.
   * Returns true when the node was fully handled (its children need no walk).
   */
  #reference(node: SyntaxNode, owner: string, ctx: Context): boolean {
    const parent = node.parent;
    if (parent?.type === "call" && field(parent, "function")?.equals(node)) {
      // The callee itself is handled by #call; still walk receivers like `foo(x).bar()`.
      return node.type === "identifier";
    }
    if (parent?.type === "assignment" && field(parent, "left")?.equals(node))
      return node.type === "identifier";
    if (node.type === "identifier" && parent?.type === "attribute") return false;
    const value = this.project.evaluate(node, ctx);
    if (value?.t !== "def" || value.def.kind === "property") return false;
    const target = defId(value.mod, value.def);
    if (target === owner || target.startsWith(`${owner}.`)) return true;
    const key = `${owner}\u0000${target}`;
    if (!this.#references.has(key)) {
      this.#references.add(key);
      const edge: GraphEdge = {
        source: owner,
        target,
        kind: "references",
        confidence: value.via === "inferred" ? "inferred" : "exact",
        location: locationOf(node, this.mod.path),
      };
      if (node.parent?.type === "type") edge.detail = "type";
      this.#edge(edge);
    }
    return true;
  }
}
