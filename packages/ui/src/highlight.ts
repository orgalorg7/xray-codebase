import type { Language } from "@xray/schema";
import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | undefined;

/** Loads the syntax highlighter once, with only the grammars and themes xray needs. */
function load(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
      langs: [
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/javascript"),
        import("@shikijs/langs/python"),
      ],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

const LANG: Record<Language, string> = { ts: "tsx", js: "javascript", py: "python" };

export type Token = { content: string; color?: string };

/** Highlighted lines of code; falls back to plain text when highlighting fails. */
export async function highlight(
  code: string,
  language: Language | undefined,
  theme: "light" | "dark",
): Promise<Token[][]> {
  try {
    const shiki = await load();
    const result = shiki.codeToTokensBase(code, {
      lang: language ? LANG[language] : "text",
      theme: theme === "dark" ? "github-dark" : "github-light",
    });
    return result.map((line) =>
      line.map((token) => ({
        content: token.content,
        ...(token.color ? { color: token.color } : {}),
      })),
    );
  } catch {
    return code.split("\n").map((line) => [{ content: line }]);
  }
}
