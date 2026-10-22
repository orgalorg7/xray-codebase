import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkout, receivedBytes, TooLargeError } from "../src/clone.js";
import { NotFoundError, parseRepo, resolveRepo } from "../src/github.js";
import { Remotes } from "./remotes.js";

const SHA = "4ff48cec099f0514c3e9bbca18706c9c21122bfb";

describe("parseRepo", () => {
  it.each([
    ["vercel/ms", { owner: "vercel", repo: "ms" }],
    ["  Vercel/MS  ", { owner: "vercel", repo: "ms" }],
    ["github.com/vercel/ms", { owner: "vercel", repo: "ms" }],
    ["https://github.com/vercel/ms", { owner: "vercel", repo: "ms" }],
    ["https://www.github.com/vercel/ms.git", { owner: "vercel", repo: "ms" }],
    ["git@github.com:vercel/ms.git", { owner: "vercel", repo: "ms" }],
    ["https://github.com/vercel/ms/issues?q=1#top", { owner: "vercel", repo: "ms" }],
    [
      "https://github.com/vercel/next.js/tree/canary",
      { owner: "vercel", repo: "next.js", path: "canary" },
    ],
    [
      "https://github.com/a/b/tree/feature/x/src/app",
      { owner: "a", repo: "b", path: "feature/x/src/app" },
    ],
    [
      "https://github.com/a/b/blob/v1.2.0/README.md",
      { owner: "a", repo: "b", path: "v1.2.0/README.md" },
    ],
    [`https://github.com/vercel/ms/commit/${SHA}`, { owner: "vercel", repo: "ms", sha: SHA }],
    [
      `https://github.com/vercel/ms/tree/${SHA.toUpperCase()}`,
      { owner: "vercel", repo: "ms", sha: SHA },
    ],
  ])("reads %s", (input, expected) => {
    expect(parseRepo(input)).toEqual(expected);
  });

  it.each([
    "",
    "vercel",
    "https://gitlab.com/a/b",
    "example.com/a/b",
    "file:///etc/passwd",
    "-x/repo",
    "a/..",
    "owner_with_underscore/repo",
    "a/b/tree/--upload-pack=evil",
    "a/b/tree/x/../../y",
    "a/b c",
  ])("rejects %j", (input) => {
    expect(parseRepo(input)).toBeUndefined();
  });
});

describe("git access", () => {
  const remotes = new Remotes();
  const sha = remotes.create("acme", "shop", "ts-classes");
  remotes.git("acme", "shop", "branch", "feature/login");
  const tagged = remotes.commit("acme", "shop", { "src/extra.ts": "export const extra = 1;\n" });
  remotes.git("acme", "shop", "tag", "-a", "v1.0", "-m", "release");
  const head = remotes.commit("acme", "shop", {
    "src/more.ts": "export const more = 2;\n",
    "src/leak.ts": { link: "/etc/hostname" },
  });
  const options = {
    remote: (owner: string, repo: string) =>
      remotes.remote.replace("{owner}", owner).replace("{repo}", repo),
    protocols: "file",
  };
  const work = mkdtempSync(join(tmpdir(), "xray-checkout-"));

  afterAll(() => {
    remotes.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("pins the default branch, branches with slashes, tags and SHAs to commits", async () => {
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, options)).toEqual({
      owner: "acme",
      repo: "shop",
      sha: head,
      ref: "main",
    });
    // The longest branch the path starts with wins; the rest is a directory.
    expect(
      await resolveRepo({ owner: "acme", repo: "shop", path: "feature/login/src/app" }, options),
    ).toMatchObject({ sha, ref: "feature/login" });
    // Annotated tags resolve to the commit, not the tag object.
    expect(await resolveRepo({ owner: "acme", repo: "shop", path: "v1.0" }, options)).toMatchObject(
      { sha: tagged, ref: "v1.0" },
    );
    expect(await resolveRepo({ owner: "acme", repo: "shop", sha }, options)).toMatchObject({
      sha,
      ref: sha,
    });
  });

  it("says when a repository or branch does not exist", async () => {
    await expect(resolveRepo({ owner: "acme", repo: "nope" }, options)).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      resolveRepo({ owner: "acme", repo: "shop", path: "missing/branch" }, options),
    ).rejects.toThrow('has no branch or tag "missing"');
  });

  it("refuses protocols that are not allowed", async () => {
    await expect(
      resolveRepo({ owner: "acme", repo: "shop" }, { ...options, protocols: "https" }),
    ).rejects.toThrow();
  });

  it("checks out one commit, with symbolic links as plain files", async () => {
    const dir = join(work, "head");
    const progress: number[] = [];
    await checkout({
      remote: options.remote("acme", "shop"),
      sha: head,
      dir,
      protocols: "file",
      depth: 1,
      maxBytes: 10 * 1024 ** 2,
      timeoutMs: 30_000,
      onProgress: (bytes) => progress.push(bytes),
    });
    expect(readFileSync(join(dir, "src", "more.ts"), "utf8")).toContain("more = 2");
    expect(lstatSync(join(dir, "src", "leak.ts")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "src", "leak.ts"), "utf8")).toBe("/etc/hostname");
    expect(progress.at(-1)).toBeGreaterThan(0);
    // Shallow: just the one commit, and no hooks directory from a template.
    expect(
      execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }),
    ).toBe("1\n");
    expect(existsSync(join(dir, ".git", "hooks"))).toBe(false);
  });

  it("stops downloads past the size limit", async () => {
    await expect(
      checkout({
        remote: options.remote("acme", "shop"),
        sha: head,
        dir: join(work, "small"),
        protocols: "file",
        depth: 1,
        maxBytes: 10,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(TooLargeError);
  });

  it("reads byte counts from git's progress output", () => {
    expect(receivedBytes("Receiving objects: 100% (4/4), 253 bytes | 253.00 KiB/s, done.")).toBe(
      253,
    );
    expect(
      receivedBytes(
        "Receiving objects:  45% (450/1000), 1.50 MiB | 1.00 MiB/s\rReceiving objects:  46% (460/1000), 2.00 MiB | 1.00 MiB/s",
      ),
    ).toBe(2 * 1024 ** 2);
    expect(receivedBytes("remote: Counting objects: 100% (4/4)")).toBeUndefined();
  });
});
