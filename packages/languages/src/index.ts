import type { LanguagePlugin } from "@xray/parser";
import { createLanguagePlugin, type LanguageDefinition } from "./core/plugin.js";
import { csharp } from "./csharp.js";
import { go } from "./go.js";
import { jvm } from "./jvm.js";
import { php } from "./php.js";
import { ruby } from "./ruby.js";
import { rust } from "./rust.js";

export { createLanguagePlugin, type LanguageDefinition } from "./core/plugin.js";

/** Every language this package adds, by plugin name. */
export const DEFINITIONS: readonly LanguageDefinition[] = [go, jvm, csharp, rust, php, ruby];

export const createGoPlugin = (): LanguagePlugin => createLanguagePlugin(go);
export const createJvmPlugin = (): LanguagePlugin => createLanguagePlugin(jvm);
export const createCSharpPlugin = (): LanguagePlugin => createLanguagePlugin(csharp);
export const createRustPlugin = (): LanguagePlugin => createLanguagePlugin(rust);
export const createPhpPlugin = (): LanguagePlugin => createLanguagePlugin(php);
export const createRubyPlugin = (): LanguagePlugin => createLanguagePlugin(ruby);

/** Every grammar the plugins load, for bundles that ship them (`grammars/<file>`). */
export const GRAMMARS: readonly { package: string; file: string }[] = DEFINITIONS.flatMap((d) =>
  d.dialects.map((dialect) => dialect.grammar),
);

/** Plugins for all of this package's languages. */
export function createLanguagePlugins(): LanguagePlugin[] {
  return DEFINITIONS.map(createLanguagePlugin);
}
