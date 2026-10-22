# Golden fixtures

Each directory is a tiny repository plus `expected.json`, its hand-written ground-truth graph.
Language plugins are scored against these with `scoreGraph` from `@xray/testkit`: precision
and recall per edge kind. Only the kinds listed in a fixture's `edgeKinds` are scored.

## Conventions extractors must follow

- **IDs** follow `@xray/schema` (`ts:src/a.ts`, `py:app/models.py#User.save`). Paths are
  relative to the fixture root.
- **contains:** module → top-level symbol, class/interface → member.
- **imports:** module → imported module, once per pair. `detail` is `type-only` for
  TS `import type`, and `deferred` for Python imports inside a function. Imports of builtins
  and the standard library are not module edges.
- **re-exports:** barrel module → the original symbol (not the intermediate barrel).
  `detail` is `alias:<name>` for renamed re-exports and `star` for `export *`.
- **calls / instantiates:** the source is the innermost enclosing function or method. For a
  top-level variable initializer it is that variable; for any other top-level code it is the
  module. Calls into builtins (`console.log`, `len`) produce no edge.
- **overrides:** method → the method it overrides; `detail` is `implements` when the target is
  an interface member.
- **cycles:** each import cycle as a sorted list of module IDs. Type-only and deferred
  imports still count.

| Fixture | Exercises |
| --- | --- |
| `ts-reexports` | Named, aliased and star re-exports through barrels |
| `ts-classes` | implements, extends, overrides, super/this calls, interface dispatch |
| `js-commonjs` | `require`, `module.exports`, calls through a module object |
| `py-packages` | Absolute and relative imports, `__init__` re-exports, constructor inference |
| `py-classes` | Inheritance, overrides, self calls, `classmethod`/`cls()` |
| `ts-cycles` | 3-module cycle, cycle closed by a type-only import |
| `py-cycles` | 2-module cycle through a deferred import |
| `go-modules` | go.mod packages, a package alias, embedding, implicit interfaces, gin and net/http routes |
| `jvm-mixed` | Java and Kotlin together: imports, constructors, overrides, inference, Spring routes, JUnit |
| `cs-aspnet` | Namespaces, `using`, `base()`, return-type inference, ASP.NET routes, xUnit |
| `rs-workspace` | Two crates: module tree, `crate::`/`super::`, `pub use`, impl blocks, actix and axum routes |
| `php-laravel` | Namespaces, grouped `use`, traits, `parent::`/`self::`, Laravel routes, PHPUnit |
| `rb-rails` | Reopened classes, mixins, instance variables, Rails routes and autoloading, Sinatra, RSpec |
