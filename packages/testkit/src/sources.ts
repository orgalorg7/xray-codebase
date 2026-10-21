import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "@xray/parser";
import type { Language } from "@xray/schema";

/** Reads every file under `dir` that `languageOf` accepts, as plugin input. */
export function loadSources(
  dir: string,
  languageOf: (path: string) => Language | undefined,
): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(absolutePath);
        continue;
      }
      const path = relative(dir, absolutePath).replaceAll("\\", "/");
      const language = languageOf(path);
      if (language === undefined) continue;
      const text = readFileSync(absolutePath, "utf8");
      const hash = createHash("sha1").update(text).digest("hex");
      files.push({ path, absolutePath, language, text, hash });
    }
  };
  walk(dir);
  return files;
}
