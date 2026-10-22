import { analyzeFixture, goldenProblems, listFixtures } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import { createLanguagePlugin } from "../src/core/plugin.js";
import { DEFINITIONS } from "../src/index.js";

/** Fixture prefix → plugin. */
const PLUGINS: Record<string, string> = {
  go: "go",
  jvm: "jvm",
  cs: "csharp",
  rs: "rust",
  php: "php",
  rb: "ruby",
};

const fixtures = listFixtures().filter((name) => (name.split("-")[0] as string) in PLUGINS);

describe.each(fixtures)("golden %s", (name) => {
  it("matches the expected graph exactly", async () => {
    const definition = DEFINITIONS.find((d) => d.name === PLUGINS[name.split("-")[0] as string]);
    const plugin = createLanguagePlugin(definition as (typeof DEFINITIONS)[number]);
    const { graph, diagnostics, expected } = await analyzeFixture(plugin, name);
    expect(goldenProblems(expected, graph)).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

it("covers every language family", () => {
  expect(fixtures.map((name) => name.split("-")[0]).sort()).toEqual([
    "cs",
    "go",
    "jvm",
    "php",
    "rb",
    "rs",
  ]);
});
