import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Remotes } from "../../cloud/test/remotes.js";
import { addRepo, buildSite, type MapEntry } from "../src/build.js";
import { renderIndex, siteBase } from "../src/page.js";

const dir = mkdtempSync(join(tmpdir(), "xray-site-"));
const remotes = new Remotes();
remotes.create("acme", "shop", "ts-classes");
remotes.create("acme", "tools", "py-packages");

// A stand-in for the built UI, in the shape the HTML export inlines.
const uiDir = join(dir, "ui");
mkdirSync(join(uiDir, "assets"), { recursive: true });
writeFileSync(
  join(uiDir, "index.html"),
  '<!doctype html><html><head><title>xray</title><script type="module" crossorigin src="./assets/a.js"></script><link rel="stylesheet" crossorigin href="./assets/a.css"></head><body><div id="root"></div></body></html>',
);
writeFileSync(join(uiDir, "assets", "a.js"), "console.log('map');\n");
writeFileSync(join(uiDir, "assets", "a.css"), "body{}\n");

afterAll(() => {
  remotes.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("the gallery site", () => {
  it("maps each repository into a page and lists them, leaving out failures", async () => {
    const out = join(dir, "site");
    const lines: string[] = [];
    const result = await buildSite({
      repos: [{ repo: "acme/shop" }, { repo: "acme/missing" }, { repo: "acme/tools", ref: "main" }],
      outDir: out,
      uiDir,
      workDir: join(dir, "work"),
      home: "orgalorg7/xray-codebase",
      remote: (owner, repo) => remotes.remote.replace("{owner}", owner).replace("{repo}", repo),
      protocols: "file",
      log: (line) => lines.push(line),
    });
    expect(result.maps.map((m) => `${m.owner}/${m.repo}`)).toEqual(["acme/shop", "acme/tools"]);
    expect(result.failed).toEqual([
      { repo: "acme/missing", error: "github.com/acme/missing was not found, or it is private" },
    ]);
    expect(lines.some((l) => l.startsWith("mapped acme/shop (4 files"))).toBe(true);

    const shop = result.maps[0] as MapEntry;
    expect(shop).toMatchObject({ ref: "main", files: 4, path: "maps/acme/shop/" });
    const page = readFileSync(join(out, "maps/acme/shop/index.html"), "utf8");
    expect(page).toContain('<script id="xray-snapshot"');
    expect(page).toContain("<title>acme/shop · xray</title>");
    expect(page).not.toContain('src="./assets');

    const index = readFileSync(join(out, "index.html"), "utf8");
    expect(index).toContain('<a href="maps/acme/shop/">');
    expect(index).toContain(
      "https://github.com/orgalorg7/xray-codebase/issues/new?template=map-request.yml",
    );
    expect(readFileSync(join(out, "404.html"), "utf8")).toContain('href="/xray-codebase/"');
    expect(JSON.parse(readFileSync(join(out, "maps.json"), "utf8"))).toHaveLength(2);
    expect(existsSync(join(out, ".nojekyll"))).toBe(true);
    // Checkouts are cleaned up.
    expect(existsSync(join(dir, "work", "acme-shop"))).toBe(false);
  });

  it("adds requested repositories once", () => {
    const list = join(dir, "repos.json");
    writeFileSync(list, '[{ "repo": "acme/shop" }]\n');
    expect(addRepo(list, "https://github.com/Acme/Tools/tree/v2/src")).toEqual({
      entry: { repo: "acme/tools", ref: "v2" },
      added: true,
    });
    expect(addRepo(list, "github.com/ACME/shop")).toEqual({
      entry: { repo: "acme/shop" },
      added: false,
    });
    expect(() => addRepo(list, "not a repo")).toThrow("not a GitHub repository");
    expect(JSON.parse(readFileSync(list, "utf8"))).toEqual([
      { repo: "acme/shop" },
      { repo: "acme/tools", ref: "v2" },
    ]);
  });

  it("escapes what it shows and knows where Pages serves it", () => {
    const html = renderIndex([
      {
        owner: "a",
        repo: "<b>",
        sha: "f".repeat(40),
        ref: "main",
        files: 12_345,
        symbols: 1500,
        edges: 9,
        languages: { ts: 1, py: 1 },
        bytes: 1,
        path: "maps/a/b/",
        mappedAt: "2026-10-22T00:00:00.000Z",
      },
    ]);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("12k files · 1.5k symbols · 9 links");
    expect(html).toContain('TypeScript</span><span class="chip">Python');
    expect(siteBase("orgalorg7/xray-codebase")).toBe("/xray-codebase/");
    expect(siteBase("orgalorg7/orgalorg7.github.io")).toBe("/");
  });
});
