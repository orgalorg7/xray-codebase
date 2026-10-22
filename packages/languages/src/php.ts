import { posix } from "node:path";
import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { joinRoute } from "./core/annotations.js";
import { Extraction, httpMethod } from "./core/extraction.js";
import type { Annotation, Decl, Expr, FileModel, TypeName } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { Binding, ImportResult, LanguageRules, Project } from "./core/resolve.js";
import {
  childOf,
  childrenOf,
  descendants,
  docComment,
  field,
  named,
  oneLine,
  stringValue,
  typeName,
} from "./core/syntax.js";

const TEST_FILE = /(^|\/)tests?\/|Test\.php$/;

const phpType = (node: SyntaxNode | null | undefined): TypeName | undefined => {
  if (!node || node.type === "primitive_type") return undefined;
  if (node.type === "optional_type" || node.type === "named_type") return phpType(named(node)[0]);
  if (node.type === "union_type" || node.type === "intersection_type")
    return phpType(named(node)[0]);
  return typeName(node.text.replace(/^\\/, ""));
};

/** A variable's key in locals: `$user`. */
const variable = (node: SyntaxNode): string =>
  `$${childOf(node, "name")?.text ?? node.text.replace(/^\$/, "")}`;

function phpExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "variable_name": {
      const name = variable(node);
      return name === "$this" ? { kind: "this" } : { kind: "name", name };
    }
    case "name":
      return { kind: "name", name: node.text };
    case "qualified_name":
      return {
        kind: "name",
        name: childOf(node, "name")?.text ?? node.text.split("\\").pop() ?? "",
      };
    case "relative_scope":
      return node.text === "parent" ? { kind: "super" } : { kind: "name", name: node.text };
    case "member_access_expression":
    case "nullsafe_member_access_expression":
      return {
        kind: "member",
        object: phpExpr(field(node, "object")),
        name: field(node, "name")?.text ?? "",
      };
    case "member_call_expression":
    case "nullsafe_member_call_expression":
    case "scoped_call_expression":
    case "function_call_expression":
      return { kind: "call", callee: phpCallee(node) };
    case "object_creation_expression": {
      const type = phpType(
        named(node).find((c) => c.type === "name" || c.type === "qualified_name"),
      );
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "parenthesized_expression":
      return phpExpr(named(node)[0]);
    default:
      return { kind: "unknown" };
  }
}

function phpCallee(call: SyntaxNode): Expr {
  if (call.type === "function_call_expression") return phpExpr(field(call, "function"));
  const name = field(call, "name")?.text ?? "";
  const object = field(call, "object") ?? field(call, "scope");
  return { kind: "member", object: phpExpr(object), name };
}

/** `#[Route('/x', methods: ['GET'])]` */
function attributesOf(node: SyntaxNode): Annotation[] {
  const list = field(node, "attributes") ?? childOf(node, "attribute_list");
  if (!list) return [];
  return [...descendants(list)]
    .filter((n) => n.type === "attribute")
    .map((attribute) => {
      const strings: string[] = [];
      const namedArgs: Record<string, string[]> = {};
      const args = field(attribute, "parameters");
      for (const arg of args ? childrenOf(args, "argument") : []) {
        const key = field(arg, "name")?.text;
        const values = [...descendants(arg)]
          .map((d) => stringValue(d))
          .filter((v): v is string => v !== undefined);
        if (key) namedArgs[key] = values;
        else strings.push(...values.slice(0, 1));
      }
      const name =
        (childOf(attribute, "name", "qualified_name")?.text ?? "").split("\\").pop() ?? "";
      return { name, strings, named: namedArgs, node: attribute };
    });
}

const visibilityOf = (node: SyntaxNode): string =>
  childOf(node, "visibility_modifier")?.text ?? "public";

function extractPhp(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, TEST_FILE.test(file.path));

  const scan = (body: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(
      body,
      (d) => d.type === "class_declaration" || d.type === "function_definition",
    )) {
      switch (n.type) {
        case "member_call_expression":
        case "nullsafe_member_call_expression":
        case "function_call_expression":
          x.call(from, phpCallee(n), n);
          break;
        case "scoped_call_expression": {
          x.call(from, phpCallee(n), n);
          laravelRoute(n);
          break;
        }
        case "object_creation_expression": {
          const type = phpType(
            named(n).find((c) => c.type === "name" || c.type === "qualified_name"),
          );
          if (type) x.call(from, { kind: "new", type }, n, "new");
          break;
        }
        case "assignment_expression": {
          const left = field(n, "left");
          if (from && left?.type === "variable_name" && !from.locals.has(variable(left))) {
            from.locals.set(variable(left), { init: phpExpr(field(n, "right")) });
          }
          break;
        }
        case "include_expression":
        case "include_once_expression":
        case "require_expression":
        case "require_once_expression": {
          const path = stringValue(named(n)[0]);
          if (path) x.import({ path, node: n, form: "require" });
          break;
        }
      }
    }
  };

  /** Laravel: Route::get('/users/{id}', [UserController::class, 'show']) or 'Ctrl@method'. */
  const laravelRoute = (call: SyntaxNode): void => {
    if (field(call, "scope")?.text !== "Route") return;
    const verb = field(call, "name")?.text ?? "";
    const method = httpMethod(verb) ?? (verb === "any" ? "ANY" : undefined);
    if (!method) return;
    const args = childrenOf(field(call, "arguments") ?? call, "argument").map((a) => named(a)[0]);
    const path = stringValue(args[0]);
    if (path === undefined) return;
    let handler: Expr | undefined;
    const target = args[1];
    if (target?.type === "array_creation_expression") {
      const [cls, action] = childrenOf(target, "array_element_initializer").map((e) => named(e)[0]);
      const className =
        cls?.type === "class_constant_access_expression" ? named(cls)[0]?.text : undefined;
      const actionName = stringValue(action);
      if (className && actionName)
        handler = {
          kind: "member",
          object: { kind: "name", name: className.split("\\").pop() ?? className },
          name: actionName,
        };
    } else {
      const text = stringValue(target);
      const [className, actionName] = text?.split("@") ?? [];
      if (className && actionName)
        handler = {
          kind: "member",
          object: { kind: "name", name: className.split("\\").pop() ?? className },
          name: actionName,
        };
    }
    x.route({
      method,
      path: joinRoute(path),
      node: call,
      framework: "laravel",
      ...(handler ? { handler } : {}),
    });
  };

  const params = (decl: Decl, list: SyntaxNode | null): void => {
    const names: string[] = [];
    for (const p of list ? named(list).filter((c) => /parameter/.test(c.type)) : []) {
      const nameNode = field(p, "name");
      if (!nameNode) continue;
      const name = variable(nameNode);
      const type = phpType(field(p, "type"));
      decl.locals.set(name, type ? { type } : {});
      names.push(name);
      // Constructor promotion: `public function __construct(private Repo $repo)`.
      if (decl.meta?.ctor === true && /property_promotion/.test(p.type) && decl.parent) {
        x.declare(
          {
            kind: "property",
            name: name.slice(1),
            node: p,
            exported: visibilityOf(p) === "public",
            ...(type ? { type } : {}),
          },
          decl.parent,
        );
      }
    }
    decl.meta = { ...decl.meta, params: names };
  };

  const KINDS: Record<string, Decl["kind"]> = {
    class_declaration: "class",
    interface_declaration: "interface",
    trait_declaration: "class",
    enum_declaration: "enum",
  };

  const visitType = (node: SyntaxNode): void => {
    const name = field(node, "name")?.text ?? "";
    const doc = docComment(node);
    const annotations = attributesOf(node);
    const decl = x.declare({
      kind: KINDS[node.type] ?? "class",
      name,
      node,
      exported: true,
      annotations,
      ...(doc ? { doc } : {}),
      signature: oneLine(
        node.text.slice(0, (field(node, "body")?.startIndex ?? node.endIndex) - node.startIndex),
      ),
      ...(node.type === "trait_declaration" ? { meta: { trait: true } } : {}),
    });
    const base = childOf(node, "base_clause");
    for (const b of base ? named(base) : []) {
      const type = phpType(b);
      if (type) decl.bases.push({ type, relation: "extends" });
    }
    const interfaces = childOf(node, "class_interface_clause");
    for (const i of interfaces ? named(interfaces) : []) {
      const type = phpType(i);
      if (type) decl.bases.push({ type, relation: "implements" });
    }
    const isTestCase = decl.bases.some((b) => /TestCase$/.test(b.type.at(-1) ?? ""));
    const classRoute = annotations.find((a) => a.name === "Route");
    const body = field(node, "body");
    for (const member of body ? named(body) : []) {
      const memberDoc = docComment(member);
      switch (member.type) {
        case "use_declaration":
          // `use Greets;` mixes a trait's methods into the class.
          for (const t of named(member)) {
            const type = phpType(t);
            if (type) decl.bases.push({ type, relation: "extends" });
          }
          break;
        case "property_declaration": {
          const type = phpType(field(member, "type"));
          for (const element of childrenOf(member, "property_element")) {
            const nameNode = field(element, "name") ?? childOf(element, "variable_name");
            if (!nameNode) continue;
            const prop = x.declare(
              {
                kind: "property",
                name: variable(nameNode).slice(1),
                node: member,
                exported: visibilityOf(member) === "public",
                ...(type ? { type } : {}),
                ...(memberDoc ? { doc: memberDoc } : {}),
              },
              decl,
            );
            scan(element, prop);
          }
          break;
        }
        case "const_declaration":
          for (const element of childrenOf(member, "const_element")) {
            const n = childOf(element, "name")?.text ?? "";
            x.declare(
              {
                kind: "property",
                name: n,
                node: member,
                exported: visibilityOf(member) === "public",
                static: true,
              },
              decl,
            );
          }
          break;
        case "enum_case": {
          const n = field(member, "name")?.text ?? "";
          x.declare(
            { kind: "property", name: n, node: member, exported: true, type: [name] },
            decl,
          );
          break;
        }
        case "method_declaration": {
          const methodName = field(member, "name")?.text ?? "";
          const methodAnnotations = attributesOf(member);
          const test =
            (isTestCase && /^test/.test(methodName)) ||
            /@test\b/.test(memberDoc ?? "") ||
            methodAnnotations.some((a) => a.name === "Test");
          const returns = phpType(field(member, "return_type"));
          const method = x.declare(
            {
              kind: test ? "test" : "method",
              name: methodName,
              node: member,
              exported: visibilityOf(member) === "public",
              static: !!childOf(member, "static_modifier"),
              annotations: methodAnnotations,
              signature: oneLine(
                `${field(member, "parameters")?.text ?? "()"}${field(member, "return_type") ? `: ${field(member, "return_type")?.text}` : ""}`,
              ),
              ...(returns ? { type: returns } : {}),
              ...(memberDoc ? { doc: memberDoc } : {}),
              ...(methodName === "__construct" ? { meta: { ctor: true } } : {}),
            },
            decl,
          );
          params(method, field(member, "parameters"));
          const fnBody = field(member, "body");
          if (fnBody) scan(fnBody, method);
          // Symfony: #[Route('/x', methods: ['GET'])] (with the class's #[Route] as prefix).
          for (const route of methodAnnotations.filter((a) => a.name === "Route")) {
            const path = joinRoute(
              classRoute?.strings[0] ?? classRoute?.named.path?.[0],
              route.strings[0] ?? route.named.path?.[0],
            );
            for (const verb of route.named.methods?.length ? route.named.methods : ["ANY"]) {
              x.route({
                method: verb.toUpperCase(),
                path,
                node: member,
                framework: "symfony",
                handler: method,
              });
            }
          }
          break;
        }
      }
    }
  };

  const visit = (items: SyntaxNode): void => {
    for (const node of named(items)) {
      switch (node.type) {
        case "namespace_definition": {
          x.model.namespace = field(node, "name")?.text ?? "";
          const body = field(node, "body");
          if (body) visit(body);
          break;
        }
        case "namespace_use_declaration": {
          const group = field(node, "body");
          const prefix = group ? (childOf(node, "namespace_name")?.text ?? "") : "";
          const form = /^use\s+(function|const)\b/.exec(node.text)?.[1];
          for (const clause of [...descendants(node)].filter(
            (n) => n.type === "namespace_use_clause",
          )) {
            const target = childOf(clause, "qualified_name", "name");
            const alias = field(clause, "alias")?.text;
            x.import({
              path: [prefix, target?.text ?? ""].filter(Boolean).join("\\").replace(/^\\/, ""),
              node: clause,
              ...(alias ? { alias } : {}),
              ...(form ? { form } : {}),
            });
          }
          break;
        }
        case "class_declaration":
        case "interface_declaration":
        case "trait_declaration":
        case "enum_declaration":
          visitType(node);
          break;
        case "function_definition": {
          const name = field(node, "name")?.text ?? "";
          const doc = docComment(node);
          const returns = phpType(field(node, "return_type"));
          const decl = x.declare({
            kind: "function",
            name,
            node,
            exported: true,
            signature: oneLine(field(node, "parameters")?.text ?? "()"),
            ...(returns ? { type: returns } : {}),
            ...(doc ? { doc } : {}),
          });
          params(decl, field(node, "parameters"));
          const body = field(node, "body");
          if (body) scan(body, decl);
          break;
        }
        default:
          scan(node, undefined);
      }
    }
  };
  visit(tree.rootNode);
  return x.model;
}

/** PHP: namespaces, `use` of classes, functions and namespaces, and include/require paths. */
function phpRules(): LanguageRules {
  const byPath = new Map<string, FileModel>();
  return {
    language: "php",
    registry: "composer",
    separator: "\\",
    prepare(project: Project) {
      for (const file of project.files) byPath.set(file.path, file);
    },
    namespaceOf: (file) => file.namespace,
    // Unqualified functions and constants fall back to the global namespace.
    implicitNamespaces: (file) => (file.namespace ? [""] : []),
    resolveImport(file, imp, project): ImportResult {
      if (imp.form === "require") {
        const relative = posix.normalize(posix.join(posix.dirname(file.path), imp.path));
        const target =
          byPath.get(relative) ?? byPath.get(posix.normalize(imp.path.replace(/^\//, "")));
        return { files: target ? [target] : [] };
      }
      const segments = imp.path.split("\\");
      const name = imp.alias ?? (segments.at(-1) as string);
      if (project.namespaces.has(imp.path)) {
        return {
          files: project.filesByNamespace.get(imp.path) ?? [],
          bindings: [[name, { kind: "namespace", key: imp.path }]],
        };
      }
      const decl = project.inNamespace(
        segments.slice(0, -1).join("\\"),
        segments.at(-1) as string,
      )[0];
      if (decl) {
        return {
          files: [project.fileOf.get(decl) as FileModel],
          bindings: [[name, { kind: "decls", decls: [decl] }]],
        };
      }
      const bindings: [string, Binding][] = [[name, { kind: "external", name: imp.path }]];
      if (segments.length < 2) return { files: [], bindings };
      return { files: [], external: (segments[0] as string).toLowerCase(), bindings };
    },
  };
}

export const php: LanguageDefinition = {
  name: "php",
  dialects: [
    {
      language: "php",
      extensions: /\.php$/,
      grammar: { package: "tree-sitter-php", file: "tree-sitter-php.wasm" },
      extract: extractPhp,
    },
  ],
  rules: phpRules,
};
