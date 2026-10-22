import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GraphStore } from "@xray/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/index.js";

describe("HTTP links between languages", () => {
  let dir: string;
  let store: GraphStore;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xray-http-"));
    store = GraphStore.open(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links requests in any language to the routes that serve them", async () => {
    write(
      "api/main.py",
      [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "",
        '@app.get("/api/users/{user_id}")',
        "def get_user(user_id: int):",
        "    return {}",
        "",
        '@app.post("/api/users")',
        "def create_user():",
        "    return {}",
        "",
        '@app.get("/health")',
        "def health():",
        "    return {}",
        "",
      ].join("\n"),
    );
    write(
      "api/test_users.py",
      [
        "from fastapi.testclient import TestClient",
        "from api.main import app",
        "client = TestClient(app)",
        "",
        "def test_get_user():",
        '    client.get("/api/users/1")',
        "",
      ].join("\n"),
    );
    write(
      "web/src/UserCard.tsx",
      [
        "export function UserCard({ id }: { id: number }) {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source code with a template literal
        "  fetch(`/api/users/${id}`).then((r) => r.json());",
        "  return null;",
        "}",
        "",
        "export async function save(name: string) {",
        '  await fetch("/api/users", { method: "POST", body: name });',
        "}",
        "",
      ].join("\n"),
    );
    write(
      "web/src/client.ts",
      [
        'import axios from "axios";',
        "const api = axios.create();",
        'export const load = (id: number) => api.get("/api/users/" + id);',
        "",
      ].join("\n"),
    );
    write(
      "ops/check.go",
      [
        "package ops",
        "",
        'import "net/http"',
        "",
        "func Check(base string) {",
        '\thttp.Get(base + "/health")',
        "}",
        "",
      ].join("\n"),
    );
    // An Express server's own routes are definitions, not requests.
    write(
      "web/server.js",
      [
        'const app = require("express")();',
        'app.get("/health", (req, res) => res.send("ok"));',
        "",
      ].join("\n"),
    );
    await new Engine({ root: dir, store }).scan();
    const links = store
      .exportGraph()
      .edges.filter((e) => e.detail === "http")
      .map((e) => `${e.source} -> ${e.target} (${e.confidence})`)
      .sort();
    // Both servers serve /health, so the check may reach either.
    expect(links).toEqual([
      "go:ops/check.go#Check -> js:web/server.js#GET /health (inferred)",
      "go:ops/check.go#Check -> py:api/main.py#GET /health (inferred)",
      "py:api/test_users.py#test_get_user -> py:api/main.py#GET /api/users/{user_id} (inferred)",
      "ts:web/src/UserCard.tsx#UserCard -> py:api/main.py#GET /api/users/{user_id} (inferred)",
      "ts:web/src/UserCard.tsx#save -> py:api/main.py#POST /api/users (inferred)",
      "ts:web/src/client.ts#load -> py:api/main.py#GET /api/users/{user_id} (inferred)",
    ]);
  });

  it("matches routes mounted under a prefix it cannot see, as a guess", async () => {
    write(
      "server/routes.js",
      [
        'const router = require("express").Router();',
        'router.get("/orders/:id", (req, res) => res.json({}));',
        "module.exports = router;",
        "",
      ].join("\n"),
    );
    write("web/orders.js", 'export const order = (id) => fetch("/api/v1/orders/" + id);\n');
    await new Engine({ root: dir, store }).scan();
    const link = store.exportGraph().edges.find((e) => e.detail === "http");
    expect(link).toMatchObject({
      source: "js:web/orders.js#order",
      target: "js:server/routes.js#GET /orders/:id",
      confidence: "heuristic",
    });
  });

  it("does not read bare words as URLs", async () => {
    write(
      "api.js",
      'const app = require("express")();\napp.get("/tree", (req, res) => res.json([]));\n',
    );
    write("ui.js", 'export const view = (params) => params.get("tree");\n');
    write(
      "client.cs",
      'class C { async void Run(HttpClient http) { await http.GetAsync("tree"); } }\n',
    );
    await new Engine({ root: dir, store }).scan();
    const links = store.exportGraph().edges.filter((e) => e.detail === "http");
    // Only the .NET client, which takes paths relative to its base address.
    expect(links.map((e) => e.source)).toEqual(["cs:client.cs#C.Run"]);
  });

  it("leaves out catch-all routes and requests to the bare root", async () => {
    write(
      "server.js",
      [
        'const app = require("express")();',
        'app.get("/*path", (req, res) => res.send("spa"));',
        'app.post("/", (req, res) => res.send("ok"));',
        "",
      ].join("\n"),
    );
    write(
      "client.js",
      'export const a = () => fetch("/anything");\nexport const b = () => fetch("/", { method: "POST" });\n',
    );
    await new Engine({ root: dir, store }).scan();
    expect(store.exportGraph().edges.filter((e) => e.detail === "http")).toEqual([]);
  });

  it("does not add links twice when nothing changed", async () => {
    write(
      "a.py",
      'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/x")\ndef x():\n    pass\n',
    );
    write("b.js", 'export const go = () => fetch("/x");\n');
    const engine = new Engine({ root: dir, store });
    await engine.scan();
    await engine.scan({ force: true });
    expect(store.exportGraph().edges.filter((e) => e.detail === "http")).toHaveLength(1);
  });
});
