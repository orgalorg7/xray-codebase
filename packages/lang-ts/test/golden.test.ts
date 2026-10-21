import { analyzeFixture, goldenProblems, listFixtures } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import { createTypeScriptPlugin } from "../src/index.js";

describe.each(listFixtures().filter((name) => /^(ts|js)-/.test(name)))("golden %s", (name) => {
  it("matches the expected graph exactly", async () => {
    const { graph, diagnostics, expected } = await analyzeFixture(createTypeScriptPlugin(), name);
    expect(goldenProblems(expected, graph)).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
