import { analyzeProject } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import { createTypeScriptPlugin } from "../src/index.js";

const analyze = (files: Record<string, string>) => analyzeProject(createTypeScriptPlugin(), files);

describe("framework entry points", () => {
  it("detects express-style routes with named and inline handlers", async () => {
    const g = await analyze({
      "server.ts": `
        import express from "express";
        import { listUsers } from "./handlers";
        const app = express();
        app.get("/users", listUsers);
        app.post("/users/:id", (req: any) => { saveUser(req.params.id); });
        const cache = new Map<string, number>();
        cache.get("/not-a-route");
        function saveUser(id: string) {}
      `,
      "handlers.ts": "export function listUsers() {}\n",
    });
    expect(g.node("ts:server.ts#GET /users")).toMatchObject({
      kind: "route",
      meta: { method: "GET", path: "/users" },
    });
    expect(g.edge("ts:server.ts#GET /users", "handles", "ts:handlers.ts#listUsers")).toBeDefined();
    expect(g.edge("ts:server.ts#POST /users/:id", "calls", "ts:server.ts#saveUser")).toBeDefined();
    expect(g.nodes.filter((n) => n.kind === "route")).toHaveLength(2);
    expect(g.edge("ts:server.ts", "imports", "ext:npm/express")).toBeDefined();
    expect(g.node("ext:npm/express")?.kind).toBe("external");
  });

  it("detects commander and yargs commands", async () => {
    const g = await analyze({
      "cli.ts": `
        import { Command } from "commander";
        const program = new Command();
        program.command("serve <port>").description("start").action(serve);
        program.command("build").action(() => compile());
        function serve() {}
        function compile() {}
      `,
    });
    expect(g.node("ts:cli.ts#command:serve")).toMatchObject({
      kind: "cli-command",
      meta: { usage: "serve <port>" },
    });
    expect(g.edge("ts:cli.ts#command:serve", "handles", "ts:cli.ts#serve")).toBeDefined();
    expect(g.edge("ts:cli.ts#command:build", "calls", "ts:cli.ts#compile")).toBeDefined();
  });

  it("detects Next.js app and pages API routes", async () => {
    const g = await analyze({
      "app/(shop)/api/users/[id]/route.ts":
        "export async function GET() { return list(); }\nfunction list() {}\n",
      "pages/api/health.ts": "export default function handler() {}\n",
    });
    expect(
      g.edge(
        "ts:app/(shop)/api/users/[id]/route.ts#GET /api/users/[id]",
        "handles",
        "ts:app/(shop)/api/users/[id]/route.ts#GET",
      ),
    ).toBeDefined();
    expect(
      g.edge("ts:pages/api/health.ts#ANY /api/health", "handles", "ts:pages/api/health.ts#handler"),
    ).toBeDefined();
  });

  it("marks React components and links JSX usage", async () => {
    const g = await analyze({
      "ui.tsx": `
        export function Button() { return <button>ok</button>; }
        export const Card = () => <div><Button /></div>;
        export function helper() { return 1; }
      `,
    });
    expect(g.node("ts:ui.tsx#Button")?.kind).toBe("component");
    expect(g.node("ts:ui.tsx#Card")?.kind).toBe("component");
    expect(g.node("ts:ui.tsx#helper")?.kind).toBe("function");
    expect(g.edge("ts:ui.tsx#Card", "calls", "ts:ui.tsx#Button")?.detail).toBe("jsx");
  });

  it("turns describe/it blocks in test files into nested test nodes", async () => {
    const g = await analyze({
      "auth.ts": "export function login() {}\n",
      "auth.test.ts": `
        import { describe, it } from "vitest";
        import { login } from "./auth";
        describe("auth", () => {
          it("logs in", () => { login(); });
        });
      `,
      "notatest.ts": 'declare function it(n: string, f: () => void): void;\nit("x", () => {});\n',
    });
    expect(g.node("ts:auth.test.ts#test:auth")).toMatchObject({
      kind: "test",
      meta: { suite: true },
    });
    expect(
      g.edge("ts:auth.test.ts#test:auth", "contains", "ts:auth.test.ts#test:auth > logs in"),
    ).toBeDefined();
    expect(
      g.edge("ts:auth.test.ts#test:auth > logs in", "calls", "ts:auth.ts#login"),
    ).toBeDefined();
    expect(g.nodes.filter((n) => n.kind === "test")).toHaveLength(2);
  });
});

describe("resolution", () => {
  it("follows namespace imports, default exports and dynamic imports", async () => {
    const g = await analyze({
      "m.ts": "export function f() {}\nexport default function main() { f(); }\n",
      "use.ts": `
        import * as m from "./m";
        import run from "./m";
        export async function go() { m.f(); run(); const lazy = await import("./lazy"); lazy.later(); }
      `,
      "lazy.ts": "export function later() {}\n",
    });
    expect(g.keys("calls")).toEqual(
      expect.arrayContaining([
        "ts:use.ts#go -calls-> ts:m.ts#f",
        "ts:use.ts#go -calls-> ts:m.ts#main",
        "ts:use.ts#go -calls-> ts:lazy.ts#later",
      ]),
    );
    expect(g.edge("ts:use.ts", "imports", "ts:lazy.ts")?.detail).toBe("dynamic-import");
  });

  it("models arrow-function class properties as methods and records callback references", async () => {
    const g = await analyze({
      "a.ts": `
        export function helper(x: number) { return x; }
        export class Box {
          handle = (n: number) => helper(n);
          all(xs: number[]) { return xs.map(helper); }
        }
      `,
    });
    expect(g.node("ts:a.ts#Box.handle")?.kind).toBe("method");
    expect(g.edge("ts:a.ts#Box.handle", "calls", "ts:a.ts#helper")).toBeDefined();
    expect(g.edge("ts:a.ts#Box.all", "references", "ts:a.ts#helper")).toBeDefined();
  });

  it("skips node builtins and records docs, signatures and exports", async () => {
    const g = await analyze({
      "a.ts": `
        import { readFileSync } from "node:fs";
        import path from "path";
        /** Reads the config.\n\nMore detail. */
        export function load(file: string): string { return readFileSync(path.join(file), "utf8"); }
        function hidden() {}
      `,
    });
    expect(g.keys("imports")).toEqual([]);
    expect(g.node("ts:a.ts#load")).toMatchObject({
      doc: "Reads the config.",
      signature: "(file: string): string",
      exported: true,
    });
    expect(g.node("ts:a.ts#hidden")?.exported).toBe(false);
  });

  it("resolves calls between workspace packages to their sources", async () => {
    const g = await analyze({
      "packages/core/package.json": JSON.stringify({
        name: "@acme/core",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      }),
      "packages/core/src/index.ts": "export function core() {}\n",
      "packages/app/package.json": JSON.stringify({ name: "@acme/app" }),
      "packages/app/src/main.ts":
        'import { core } from "@acme/core";\nexport function main() { core(); }\n',
    });
    expect(
      g.edge("ts:packages/app/src/main.ts", "imports", "ts:packages/core/src/index.ts"),
    ).toBeDefined();
    expect(
      g.edge("ts:packages/app/src/main.ts#main", "calls", "ts:packages/core/src/index.ts#core"),
    ).toBeDefined();
  });

  it("falls back to unique-name heuristics only for unresolvable receivers", async () => {
    const g = await analyze({
      "a.js": `
        export class Mailer { deliverAll() {} get() {} }
        export function send(thing) { thing.deliverAll(); thing.get(); }
      `,
    });
    expect(g.edge("js:a.js#send", "calls", "js:a.js#Mailer.deliverAll")?.confidence).toBe(
      "heuristic",
    );
    expect(g.edge("js:a.js#send", "calls", "js:a.js#Mailer.get")).toBeUndefined();
  });

  it("does not guess for receivers imported from unresolvable packages", async () => {
    const g = await analyze({
      "mock.ts": "export class Mocker { string() { return ''; } }\n",
      "use.ts": 'import { z } from "zod";\nexport const s = z.string().min(1);\n',
    });
    expect(g.edge("ts:use.ts#s", "calls", "ts:mock.ts#Mocker.string")).toBeUndefined();
  });
});

describe("JavaScript object patterns", () => {
  it("models `obj.method = function` and prototype assignments as methods", async () => {
    const g = await analyze({
      "app.js": `
        var app = exports = module.exports = {};
        app.render = function render(name) { return this.lookup(name); };
        app.lookup = function (name) { return name; };
        function View() {}
        View.prototype.resolve = function resolve() {};
      `,
      "test.js": `
        function render() {}
        module.exports = function use(res) { res.render("x"); };
      `,
    });
    expect(g.node("js:app.js#app.render")?.kind).toBe("method");
    expect(g.edge("js:app.js#app", "contains", "js:app.js#app.render")).toBeDefined();
    expect(g.edge("js:app.js#View", "contains", "js:app.js#View.resolve")).toBeDefined();
    // res is unknown: the guess goes to the method, never to the unrelated function.
    expect(g.edge("js:test.js#use", "calls", "js:app.js#app.render")?.confidence).toBe("heuristic");
    expect(g.edge("js:test.js#use", "calls", "js:test.js#render")).toBeUndefined();
  });

  it("ignores asset imports", async () => {
    const g = await analyze({
      "a.ts":
        'import "./global.css";\nimport logo from "./logo.svg?url";\nexport const x = logo;\n',
    });
    expect(g.diagnostics).toEqual([]);
    expect(g.keys("imports")).toEqual([]);
  });
});

describe("robustness", () => {
  it("never resolves into node_modules above the scanned root", async () => {
    // analyzeProject scans a temp dir; this repo's own node_modules must stay invisible to it.
    const g = await analyze({
      "a.ts": 'import ts from "typescript";\nexport const v = ts.version;\n',
    });
    expect(g.edge("ts:a.ts", "imports", "ext:npm/typescript")).toBeDefined();
    expect(g.edges.some((e) => e.target.includes("node_modules"))).toBe(false);
  });

  it("ignores diagnostic output options in project configs", async () => {
    const log = console.log;
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await analyze({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { traceResolution: true, listFiles: true, extendedDiagnostics: true },
        }),
        "a.ts": 'import { b } from "./b";\nexport const a = b;\n',
        "b.ts": "export const b = 1;\n",
      });
    } finally {
      process.stdout.write = write;
      console.log = log;
    }
    expect(writes.join("")).not.toContain("Resolving module");
  });
});
