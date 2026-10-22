import type { AnalysisBuilder } from "@xray/parser";
import {
  type Confidence,
  externalId,
  type GraphEdge,
  type Language,
  moduleId,
  symbolId,
} from "@xray/schema";
import {
  CALLABLE,
  type Call,
  CLASS_LIKE,
  type Decl,
  type Expr,
  type FileModel,
  type Import,
  type TypeName,
} from "./model.js";
import { locationOf } from "./syntax.js";

/** What a name stands for in a file. */
export type Binding =
  | { kind: "decls"; decls: Decl[] }
  | { kind: "namespace"; key: string }
  | { kind: "external"; name: string };

export type ImportResult = {
  /** Project files the import brings in (one `imports` edge each). */
  files: FileModel[];
  /** An external package, when the import is neither in the project nor in the standard library. */
  external?: string;
  /** Names the import binds. */
  bindings?: [string, Binding][];
  /** Namespaces whose members become visible without qualification (wildcards, C# `using`). */
  open?: string[];
};

/** What differs between languages: where names come from and what imports mean. */
export interface LanguageRules {
  /** The plugin's main language (a plugin may cover several, such as Java and Kotlin). */
  readonly language: Language;
  /** Registry for external packages: `go`, `maven`, `cargo`, `nuget`, `composer`, `gem`. */
  readonly registry: string;
  /** Separator of qualified names (`.`, `::`, `\`), for fully qualified type names. */
  readonly separator?: string;
  /** Constants resolve project-wide by simple name (Ruby). */
  readonly globalTypes?: boolean;
  /** Classes may be reopened: declarations with one qualified name are one type (Ruby). */
  readonly openClasses?: boolean;
  /** Files depend on each other through the constants they use, without imports (Rails). */
  readonly autoload?: boolean;
  /** Called with every file before anything resolves (reads go.mod, builds the module tree…). */
  prepare?(project: Project): void;
  /** The namespace key of a file's top-level declarations. */
  namespaceOf(file: FileModel): string;
  /** Namespaces visible in a file without any import (C# enclosing namespaces). */
  implicitNamespaces?(file: FileModel): string[];
  resolveImport(file: FileModel, imp: Import, project: Project): ImportResult;
  /** Extra edges once everything is resolved (Go's implicit interface satisfaction). */
  finish?(project: Project, emit: Emitter): void;
  /** A namespace inside another (`crate::store`, `Acme.Core`), when paths can name one. */
  childNamespace?(key: string, name: string, project: Project): string | undefined;
}

export type Emitter = (file: FileModel, edge: GraphEdge) => void;

type FileScope = { bindings: Map<string, Binding>; open: string[] };

/** What an expression evaluates to, as far as static analysis can tell. */
type Value =
  | { kind: "decl"; decl: Decl; confidence: Confidence }
  | { kind: "instance"; type: Decl; confidence: Confidence }
  | { kind: "namespace"; key: string }
  | { kind: "external" };

type Context = { file: FileModel; from: Decl | undefined };

const WEAKER: Record<Confidence, number> = { exact: 0, inferred: 1, heuristic: 2 };
const weakest = (a: Confidence, b: Confidence): Confidence => (WEAKER[a] >= WEAKER[b] ? a : b);

/** Method names too common to guess a target from by name alone. */
const AMBIGUOUS = new Set([
  "get",
  "set",
  "add",
  "put",
  "remove",
  "delete",
  "close",
  "open",
  "run",
  "call",
  "apply",
  "map",
  "filter",
  "each",
  "to_s",
  "toString",
  "ToString",
  "String",
  "equals",
  "Equals",
  "hashCode",
  "GetHashCode",
  "len",
  "size",
  "length",
  "new",
  "init",
  "clone",
  "from",
  "into",
  "unwrap",
  "push",
  "pop",
  "send",
  "write",
  "read",
  "update",
  "save",
  "load",
  "find",
  "Error",
]);

/**
 * Resolves one language's files against each other with the language's rules, and emits the
 * graph: modules, declarations, containment, imports, inheritance, overrides, calls,
 * instantiations, type references and routes.
 */
export class Project {
  readonly files: readonly FileModel[];
  readonly rules: LanguageRules;
  readonly root: string;
  /** Top-level declarations by namespace key, then name. */
  readonly namespaces = new Map<string, Map<string, Decl[]>>();
  readonly filesByNamespace = new Map<string, FileModel[]>();
  readonly fileOf = new Map<Decl, FileModel>();
  readonly #scopes = new Map<FileModel, FileScope>();
  /** Class-like declarations by simple name, for languages with global constants. */
  readonly #types = new Map<string, Decl[]>();
  readonly #methods = new Map<string, Decl[]>();
  /** Detached methods (Go receivers, Rust impls) attached to their type. */
  readonly #owned = new Map<Decl, Decl[]>();
  readonly #ownerOf = new Map<Decl, Decl>();
  readonly #bases = new Map<Decl, { decl: Decl; relation: "extends" | "implements" }[]>();
  /** Supertypes added from outside the type (Rust `impl Trait for Type`). */
  readonly #extraBases = new Map<Decl, { type: TypeName; file: FileModel }[]>();
  /** Reopened classes: every declaration of a qualified name (open-class languages). */
  readonly #reopened = new Map<string, Decl[]>();

  constructor(root: string, files: readonly FileModel[], rules: LanguageRules) {
    this.root = root;
    this.files = files;
    this.rules = rules;
  }

  scopeOf(file: FileModel): FileScope {
    let scope = this.#scopes.get(file);
    if (!scope) {
      scope = { bindings: new Map(), open: [] };
      this.#scopes.set(file, scope);
    }
    return scope;
  }

  /** Top-level declarations of a namespace named `name`. */
  inNamespace(key: string, name: string): Decl[] {
    return this.namespaces.get(key)?.get(name) ?? [];
  }

  /** Indexes declarations and resolves imports. Call before `emit`. */
  link(): void {
    this.rules.prepare?.(this);
    for (const file of this.files) {
      const key = this.rules.namespaceOf(file);
      const list = this.filesByNamespace.get(key) ?? [];
      list.push(file);
      this.filesByNamespace.set(key, list);
      let names = this.namespaces.get(key);
      if (!names) {
        names = new Map();
        this.namespaces.set(key, names);
      }
      for (const decl of file.decls) {
        this.fileOf.set(decl, file);
        if (CLASS_LIKE.has(decl.kind)) {
          if (this.rules.openClasses) {
            const same = this.#reopened.get(decl.qualifiedName);
            if (same) {
              same.push(decl);
              continue;
            }
            this.#reopened.set(decl.qualifiedName, [decl]);
          }
          push(this.#types, decl.name, decl);
        }
        if (decl.kind === "method") push(this.#methods, decl.name, decl);
        if (!decl.parent && !decl.owner) push(names, decl.name, decl);
      }
    }
    for (const file of this.files) {
      const scope = this.scopeOf(file);
      for (const imp of file.imports) {
        const result = this.rules.resolveImport(file, imp, this);
        for (const [name, binding] of result.bindings ?? []) scope.bindings.set(name, binding);
        scope.open.push(...(result.open ?? []));
      }
    }
    // Detached methods join their type, and impl blocks add supertypes.
    for (const file of this.files) {
      for (const decl of file.decls) {
        if (!decl.owner) continue;
        const owner = this.resolveType({ file, from: undefined }, decl.owner);
        if (!owner) continue;
        push(this.#owned, owner, decl);
        this.#ownerOf.set(decl, owner);
      }
      for (const impl of file.impls) {
        const type = this.resolveType({ file, from: undefined }, impl.type);
        if (type) push(this.#extraBases, type, { type: impl.trait, file });
      }
    }
  }

  // ---- lookup ---------------------------------------------------------------------------

  /** Members of a type, attached detached methods (and reopened declarations) included. */
  membersOf(type: Decl): Decl[] {
    const owned = this.#owned.get(type);
    const reopened = this.rules.openClasses ? this.#reopened.get(type.qualifiedName) : undefined;
    if (reopened && reopened.length > 1) {
      return [...reopened.flatMap((d) => d.members), ...(owned ?? [])];
    }
    return owned ? [...type.members, ...owned] : type.members;
  }

  /** The class or type a declaration belongs to. */
  enclosingType(decl: Decl | undefined): Decl | undefined {
    for (let d = decl; d; d = d.parent ?? this.#ownerOf.get(d)) {
      if (d !== decl && CLASS_LIKE.has(d.kind)) return d;
      const owner = this.#ownerOf.get(d);
      if (owner) return owner;
    }
    return undefined;
  }

  /** Resolved supertypes of a type. */
  basesOf(type: Decl): { decl: Decl; relation: "extends" | "implements" }[] {
    const cached = this.#bases.get(type);
    if (cached) return cached;
    const result: { decl: Decl; relation: "extends" | "implements" }[] = [];
    this.#bases.set(type, result); // guards against cyclic hierarchies while resolving
    const file = this.fileOf.get(type);
    if (!file) return result;
    const context = { file, from: type.parent };
    const declarations = this.rules.openClasses
      ? (this.#reopened.get(type.qualifiedName) ?? [type])
      : [type];
    for (const base of declarations.flatMap((d) => d.bases)) {
      const decl = this.resolveType(context, base.type);
      if (!decl || decl === type) continue;
      const relation =
        base.relation !== "unknown"
          ? base.relation
          : decl.kind === "interface" && type.kind !== "interface"
            ? "implements"
            : "extends";
      result.push({ decl, relation });
    }
    for (const extra of this.#extraBases.get(type) ?? []) {
      const decl = this.resolveType({ file: extra.file, from: undefined }, extra.type);
      if (decl && decl !== type) result.push({ decl, relation: "implements" });
    }
    return result;
  }

  /** A member by name on a type or its supertypes (nearest first). */
  member(type: Decl, name: string, seen = new Set<Decl>()): Decl | undefined {
    if (seen.has(type)) return undefined;
    seen.add(type);
    const own = this.membersOf(type).find((m) => m.name === name);
    if (own) return own;
    // Kotlin companion objects hold a class's static members.
    const companion = type.members.find((m) => m.meta?.companion === true);
    const fromCompanion = companion && this.membersOf(companion).find((m) => m.name === name);
    if (fromCompanion) return fromCompanion;
    for (const base of this.basesOf(type)) {
      const found = this.member(base.decl, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  #fromNamespace(key: string, name: string): Decl | undefined {
    return this.inNamespace(key, name)[0];
  }

  /** What a simple name refers to at a point in a file, locals and members first. */
  lookup(ctx: Context, name: string): { decl?: Decl; local?: Value; binding?: Binding } {
    // `Self` (Rust), `self`/`static` (PHP) name the enclosing type.
    if (name === "Self" || name === "self" || name === "static") {
      const type = this.enclosingType(ctx.from);
      if (type) return { decl: type };
    }
    // Classes, methods, then the file, imports, the namespace and globals.
    for (let type = this.enclosingType(ctx.from); type; type = this.enclosingType(type)) {
      const member = this.member(type, name);
      if (member) return { decl: member };
      if (type.name === name) return { decl: type };
    }
    const file = ctx.file;
    const top = file.decls.find((d) => d.name === name && !d.parent && !d.owner);
    if (top) return { decl: top };
    const scope = this.scopeOf(file);
    const binding = scope.bindings.get(name);
    if (binding?.kind === "decls" && binding.decls[0]) return { decl: binding.decls[0] };
    if (binding) return { binding };
    const namespaces = [
      this.rules.namespaceOf(file),
      ...(this.rules.implicitNamespaces?.(file) ?? []),
      ...scope.open,
    ];
    for (const key of namespaces) {
      const found = this.#fromNamespace(key, name);
      if (found) return { decl: found };
    }
    if (this.rules.globalTypes) {
      const types = this.#types.get(name);
      if (types?.length === 1) return { decl: types[0] as Decl };
    }
    return {};
  }

  /** The declaration a type name refers to. */
  resolveType(ctx: Context, type: TypeName): Decl | undefined {
    const [first, ...rest] = type;
    if (!first) return undefined;
    let current: Value | undefined = this.#nameValue(ctx, first, 0, true);
    if (!current && type.length > 1) {
      // A fully qualified name: the longest namespace prefix, then members.
      const separator = this.rules.separator ?? ".";
      for (let n = type.length - 1; n > 0 && !current; n--) {
        const key = type.slice(0, n).join(separator);
        if (this.namespaces.has(key)) {
          current = { kind: "namespace", key };
          rest.splice(0, rest.length, ...type.slice(n));
        }
      }
    }
    for (const segment of rest) {
      if (!current) return undefined;
      if (current.kind === "namespace") {
        const decl = this.#fromNamespace(current.key, segment);
        current = decl ? { kind: "decl", decl, confidence: "exact" } : undefined;
      } else if (current.kind === "decl" && CLASS_LIKE.has(current.decl.kind)) {
        const member = this.member(current.decl, segment);
        current = member ? { kind: "decl", decl: member, confidence: "exact" } : undefined;
      } else return undefined;
    }
    return current?.kind === "decl" && CLASS_LIKE.has(current.decl.kind) ? current.decl : undefined;
  }

  #valueOf(decl: Decl, confidence: Confidence, depth: number): Value | undefined {
    if (CLASS_LIKE.has(decl.kind) || CALLABLE.has(decl.kind)) {
      return { kind: "decl", decl, confidence };
    }
    const file = this.fileOf.get(decl);
    if (!file) return undefined;
    const ctx = { file, from: decl.parent };
    if (decl.type) {
      const type = this.resolveType(ctx, decl.type);
      return type ? { kind: "instance", type, confidence } : undefined;
    }
    const init = decl.meta?.init as Expr | undefined;
    if (init) {
      const value = this.evaluate({ file, from: decl }, init, depth + 1);
      if (value?.kind === "instance") {
        return { ...value, confidence: weakest(value.confidence, "inferred") };
      }
    }
    return undefined;
  }

  #nameValue(ctx: Context, name: string, depth: number, typesOnly = false): Value | undefined {
    if (!typesOnly) {
      for (let d = ctx.from; d; d = d.parent ?? this.#ownerOf.get(d)) {
        const local = d.locals.get(name);
        if (!local) continue;
        if (local.type) {
          const type = this.resolveType({ file: ctx.file, from: d }, local.type);
          return type ? { kind: "instance", type, confidence: "exact" } : undefined;
        }
        if (local.init) {
          const value = this.evaluate({ file: ctx.file, from: d }, local.init, depth + 1);
          if (value?.kind === "instance") {
            return { ...value, confidence: weakest(value.confidence, "inferred") };
          }
        }
        return undefined;
      }
    }
    const found = this.lookup(ctx, name);
    if (found.decl) return this.#valueOf(found.decl, "exact", depth);
    if (found.binding?.kind === "namespace") return { kind: "namespace", key: found.binding.key };
    if (found.binding?.kind === "external") return { kind: "external" };
    return undefined;
  }

  /** What an expression evaluates to. */
  evaluate(ctx: Context, expr: Expr, depth = 0): Value | undefined {
    if (depth > 12) return undefined;
    switch (expr.kind) {
      case "name":
        return this.#nameValue(ctx, expr.name, depth);
      case "this": {
        const type = this.enclosingType(ctx.from);
        return type ? { kind: "instance", type, confidence: "exact" } : undefined;
      }
      case "super": {
        const type = this.enclosingType(ctx.from);
        const base = type && this.basesOf(type).find((b) => b.relation === "extends");
        return base ? { kind: "instance", type: base.decl, confidence: "exact" } : undefined;
      }
      case "member": {
        const object = this.evaluate(ctx, expr.object, depth + 1);
        if (!object) return undefined;
        if (object.kind === "external") return object;
        if (object.kind === "namespace") {
          const decl = this.#fromNamespace(object.key, expr.name);
          if (decl) return this.#valueOf(decl, "exact", depth);
          const child = this.rules.childNamespace?.(object.key, expr.name, this);
          return child ? { kind: "namespace", key: child } : undefined;
        }
        const type = object.kind === "instance" ? object.type : object.decl;
        if (!CLASS_LIKE.has(type.kind)) return undefined;
        const member = this.member(type, expr.name);
        if (member) return this.#valueOf(member, object.confidence, depth);
        // Ruby's Foo.new (and Rust's Foo::new without a body here) stands for the class itself,
        // so calling it yields an instance.
        if (object.kind === "decl" && expr.name === "new") return object;
        return undefined;
      }
      case "call": {
        const callee = this.evaluate(ctx, expr.callee, depth + 1);
        if (callee?.kind !== "decl") return callee?.kind === "external" ? callee : undefined;
        if (CLASS_LIKE.has(callee.decl.kind)) {
          return { kind: "instance", type: callee.decl, confidence: callee.confidence };
        }
        const returns = callee.decl.type;
        const file = this.fileOf.get(callee.decl);
        if (!returns || !file) return undefined;
        const type = this.resolveType({ file, from: callee.decl }, returns);
        return type ? { kind: "instance", type, confidence: callee.confidence } : undefined;
      }
      case "new": {
        const type = this.resolveType(ctx, expr.type);
        return type ? { kind: "instance", type, confidence: "exact" } : undefined;
      }
      default:
        return undefined;
    }
  }

  /** The declaration a call reaches, and whether it calls or constructs it. */
  resolveCall(
    ctx: Context,
    call: Call,
  ): { target: Decl; kind: "calls" | "instantiates"; confidence: Confidence } | undefined {
    if (call.kind === "new") {
      const type = this.resolveType(ctx, exprType(call.callee) ?? []);
      return type ? { target: type, kind: "instantiates", confidence: "exact" } : undefined;
    }
    const callee = call.callee;
    if (callee.kind === "name") {
      const value = this.#nameValue(ctx, callee.name, 0);
      if (value?.kind !== "decl") return undefined;
      return {
        target: value.decl,
        kind: CLASS_LIKE.has(value.decl.kind) ? "instantiates" : "calls",
        confidence: value.confidence,
      };
    }
    if (callee.kind === "this" || callee.kind === "super") {
      // this(…) / super(…): another constructor of the same class or of the base.
      const value = this.evaluate(ctx, callee);
      if (value?.kind !== "instance") return undefined;
      const ctor = this.membersOf(value.type).find((m) => m.meta?.ctor === true);
      return ctor ? { target: ctor, kind: "calls", confidence: "exact" } : undefined;
    }
    if (callee.kind !== "member") return undefined;
    const object = this.evaluate(ctx, callee.object);
    if (object?.kind === "external") return undefined;
    if (object?.kind === "namespace") {
      const decl = this.#fromNamespace(object.key, callee.name);
      if (!decl) return undefined;
      return {
        target: decl,
        kind: CLASS_LIKE.has(decl.kind) ? "instantiates" : "calls",
        confidence: "exact",
      };
    }
    if (object) {
      const type = object.kind === "instance" ? object.type : object.decl;
      if (!CLASS_LIKE.has(type.kind)) return undefined;
      const member = this.member(type, callee.name);
      if (member && CALLABLE.has(member.kind)) {
        return { target: member, kind: "calls", confidence: object.confidence };
      }
      // Ruby's Foo.new and Rust's Foo::new() without a declared constructor build a Foo.
      if (!member && object.kind === "decl" && callee.name === "new") {
        return { target: type, kind: "instantiates", confidence: "exact" };
      }
      if (member && CLASS_LIKE.has(member.kind)) {
        return { target: member, kind: "instantiates", confidence: object.confidence };
      }
      return undefined;
    }
    // An unknown receiver: guess by a method name that only one type declares. Not for imported
    // names, capitalized ones (library classes such as String or Collections), or receivers
    // declared with a type outside the project (a guess into the project would be wrong).
    if (
      callee.object.kind === "name" &&
      (this.lookup(ctx, callee.object.name).binding || /^\p{Lu}/u.test(callee.object.name))
    ) {
      return undefined;
    }
    if (this.#declaredElsewhere(ctx, callee.object)) return undefined;
    // A chain that starts at a library name (`Command::new("git").args(a).output()`).
    const root = rootName(callee.object);
    if (root && (/^\p{Lu}/u.test(root) || this.lookup(ctx, root).binding)) return undefined;
    if (AMBIGUOUS.has(callee.name)) return undefined;
    const candidates = this.#methods.get(callee.name);
    if (candidates?.length !== 1) return undefined;
    return { target: candidates[0] as Decl, kind: "calls", confidence: "heuristic" };
  }

  /** The module-level variable a name refers to at a point, unless a local shadows it. */
  #stateVariable(ctx: Context, name: string): Decl | undefined {
    for (let d = ctx.from; d; d = d.parent ?? this.#ownerOf.get(d)) {
      if (d.locals.has(name)) return undefined;
    }
    const decl = this.lookup(ctx, name).decl;
    return decl?.kind === "variable" && !decl.parent && !decl.owner ? decl : undefined;
  }

  /** Whether an expression has a declared type that is not one of the project's types. */
  #declaredElsewhere(ctx: Context, expr: Expr): boolean {
    let declared: { type: TypeName; ctx: Context } | undefined;
    if (expr.kind === "name") {
      for (let d = ctx.from; d && !declared; d = d.parent ?? this.#ownerOf.get(d)) {
        const local = d.locals.get(expr.name);
        if (local) {
          if (!local.type) return false;
          declared = { type: local.type, ctx: { file: ctx.file, from: d } };
        }
      }
      if (!declared) {
        const decl = this.lookup(ctx, expr.name).decl;
        const file = decl && this.fileOf.get(decl);
        if (decl?.type && file) declared = { type: decl.type, ctx: { file, from: decl.parent } };
      }
    } else if (expr.kind === "member") {
      const object = this.evaluate(ctx, expr.object);
      const type =
        object?.kind === "instance"
          ? object.type
          : object?.kind === "decl"
            ? object.decl
            : undefined;
      const member = type && CLASS_LIKE.has(type.kind) ? this.member(type, expr.name) : undefined;
      const file = member && this.fileOf.get(member);
      if (member?.type && file)
        declared = { type: member.type, ctx: { file, from: member.parent } };
    }
    return !!declared && !this.resolveType(declared.ctx, declared.type);
  }

  // ---- output ---------------------------------------------------------------------------

  idOf(decl: Decl): string {
    const file = this.fileOf.get(decl) as FileModel;
    return symbolId(file.language, file.path, decl.qualifiedName);
  }

  emit(builder: AnalysisBuilder): void {
    const emitted = new Set<string>();
    const emit: Emitter = (file, edge) => {
      if (edge.source === edge.target) return;
      builder.edge(file.path, edge);
    };
    for (const file of this.files) {
      const language = file.language;
      const mid = moduleId(language, file.path);
      builder.node(file.path, {
        id: mid,
        kind: "module",
        name: file.path.split("/").pop() as string,
        qualifiedName: file.path,
        language,
        location: { file: file.path, line: 1, column: 1 },
        ...(file.isTest ? { meta: { test: true } } : {}),
      });

      // Declarations and what contains them.
      for (const decl of file.decls) {
        const id = this.idOf(decl);
        builder.node(file.path, {
          id,
          kind: decl.kind,
          name: decl.name,
          qualifiedName: decl.qualifiedName,
          language,
          location: locationOf(decl.node, file.path),
          ...(decl.signature ? { signature: decl.signature } : {}),
          ...(decl.doc ? { doc: decl.doc } : {}),
          exported: decl.exported,
          ...(decl.meta && publicMeta(decl.meta) ? { meta: publicMeta(decl.meta) } : {}),
        });
        const container = decl.parent ?? this.#ownerOf.get(decl);
        emit(file, {
          source: container ? this.idOf(container) : mid,
          target: id,
          kind: "contains",
          confidence: "exact",
        });
      }

      // Imports.
      const imported = new Set<string>();
      for (const imp of file.imports) {
        const result = this.rules.resolveImport(file, imp, this);
        for (const target of result.files) {
          const tid = moduleId(target.language, target.path);
          if (target === file || imported.has(tid)) continue;
          imported.add(tid);
          emit(file, {
            source: mid,
            target: tid,
            kind: "imports",
            confidence: "exact",
            location: locationOf(imp.node, file.path),
          });
        }
        if (result.external) {
          const eid = externalId(this.rules.registry, result.external);
          if (!emitted.has(eid)) {
            emitted.add(eid);
            builder.sharedNode({
              id: eid,
              kind: "external",
              name: result.external,
              qualifiedName: result.external,
            });
          }
          if (!imported.has(eid)) {
            imported.add(eid);
            emit(file, {
              source: mid,
              target: eid,
              kind: "imports",
              confidence: "exact",
              location: locationOf(imp.node, file.path),
            });
          }
        }
      }

      // Inheritance and overrides.
      for (const decl of file.decls) {
        if (!CLASS_LIKE.has(decl.kind)) continue;
        for (const base of this.basesOf(decl)) {
          emit(file, {
            source: this.idOf(decl),
            target: this.idOf(base.decl),
            kind: base.relation,
            confidence: "exact",
            location: locationOf(decl.node, file.path),
          });
        }
      }
      for (const decl of file.decls) {
        if (decl.kind !== "method" || decl.static || decl.meta?.ctor === true) continue;
        const type = this.enclosingType(decl);
        if (!type) continue;
        for (const base of this.basesOf(type)) {
          const overridden = this.member(base.decl, decl.name);
          if (overridden?.kind !== "method") continue;
          const target = this.enclosingType(overridden);
          emit(file, {
            source: this.idOf(decl),
            target: this.idOf(overridden),
            kind: "overrides",
            confidence: "exact",
            ...(target?.kind === "interface" ? { detail: "implements" } : {}),
          });
          break;
        }
      }

      // Calls and instantiations.
      for (const call of file.calls) {
        const ctx = { file, from: call.from };
        const resolved = this.resolveCall(ctx, call);
        if (!resolved) continue;
        const target = this.fileOf.get(resolved.target);
        if (this.rules.autoload && target && target !== file) {
          const tid = moduleId(target.language, target.path);
          if (!imported.has(tid)) {
            imported.add(tid);
            emit(file, {
              source: mid,
              target: tid,
              kind: "imports",
              confidence: "inferred",
              detail: "autoload",
              location: locationOf(call.node, file.path),
            });
          }
        }
        emit(file, {
          source: call.from ? this.idOf(call.from) : mid,
          target: this.idOf(resolved.target),
          kind: resolved.kind,
          confidence: resolved.confidence,
          location: locationOf(call.node, file.path),
        });
      }

      // Reads and writes of module-level variables (state).
      const accessed = new Set<string>();
      for (const access of file.accesses) {
        const decl = this.#stateVariable({ file, from: access.from }, access.name);
        if (!decl || decl === access.from) continue;
        const detail = access.write ? "writes" : "reads";
        const key = `${this.idOf(access.from)}\u0000${this.idOf(decl)}\u0000${detail}`;
        if (accessed.has(key)) continue;
        accessed.add(key);
        emit(file, {
          source: this.idOf(access.from),
          target: this.idOf(decl),
          kind: "references",
          confidence: "exact",
          detail,
          location: locationOf(access.node, file.path),
        });
      }

      // Types used in fields, parameters and results.
      for (const decl of file.decls) {
        const types = new Map<string, Decl>();
        const consider = (type: TypeName | undefined, from: Decl | undefined) => {
          if (!type) return;
          const target = this.resolveType({ file, from }, type);
          if (target && target !== decl) types.set(this.idOf(target), target);
        };
        if (decl.kind === "property" || decl.kind === "variable") consider(decl.type, decl.parent);
        if (CALLABLE.has(decl.kind)) {
          consider(decl.type, decl);
          for (const local of (decl.meta?.params as string[] | undefined) ?? []) {
            consider(decl.locals.get(local)?.type, decl);
          }
        }
        for (const target of types.keys()) {
          emit(file, {
            source: this.idOf(decl),
            target,
            kind: "references",
            confidence: "exact",
            detail: "type",
            location: locationOf(decl.node, file.path),
          });
        }
      }

      // Routes.
      for (const route of file.routes) {
        const qualifiedName = `${route.method} ${route.path}`;
        const id = symbolId(language, file.path, qualifiedName);
        builder.node(file.path, {
          id,
          kind: "route",
          name: qualifiedName,
          qualifiedName,
          language,
          location: locationOf(route.node, file.path),
          meta: { method: route.method, path: route.path, framework: route.framework },
        });
        emit(file, { source: mid, target: id, kind: "contains", confidence: "exact" });
        const handler =
          route.handler && "qualifiedName" in route.handler
            ? route.handler
            : route.handler
              ? this.#handlerOf({ file, from: route.from }, route.handler)
              : undefined;
        if (handler) {
          emit(file, {
            source: id,
            target: this.idOf(handler),
            kind: "handles",
            confidence: "exact",
            location: locationOf(route.node, file.path),
          });
        }
      }
    }
    this.rules.finish?.(this, emit);
  }

  #handlerOf(ctx: Context, expr: Expr): Decl | undefined {
    const value = this.evaluate(ctx, expr);
    return value?.kind === "decl" && CALLABLE.has(value.decl.kind) ? value.decl : undefined;
  }
}

/** The name a chain of members and calls starts from: `a` in `a.b().c`. */
function rootName(expr: Expr): string | undefined {
  if (expr.kind === "name") return expr.name;
  if (expr.kind === "member") return rootName(expr.object);
  if (expr.kind === "call") return rootName(expr.callee);
  return undefined;
}

/** The type an expression names: `Foo`, `pkg.Foo`, `Outer::Inner`. */
export function exprType(expr: Expr): TypeName | undefined {
  if (expr.kind === "name") return [expr.name];
  if (expr.kind === "member") {
    const object = exprType(expr.object);
    return object ? [...object, expr.name] : undefined;
  }
  if (expr.kind === "new") return expr.type;
  return undefined;
}

/** Meta without the resolver's own keys (initializers, parameter lists). */
function publicMeta(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const { init: _init, params: _params, companion: _companion, ctor: _ctor, ...rest } = meta;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
