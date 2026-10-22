/** Shiki grammars without their embedded languages (see vite.config.ts). */
declare module "slim-grammar:*" {
  import type { LanguageRegistration } from "shiki/core";

  const grammar: LanguageRegistration[];
  export default grammar;
}
