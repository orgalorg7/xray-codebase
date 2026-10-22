import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { Workspace } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "xray-polyglot-"));
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("follows a change in a Go handler to the React component that requests it", async () => {
  write("go.mod", "module example.com/shop\n");
  write(
    "api/users.go",
    [
      "package api",
      "",
      "func Routes(mux *http.ServeMux) {",
      '\tmux.HandleFunc("GET /api/users/{id}", getUser)',
      "}",
      "",
      'func getUser(w http.ResponseWriter, r *http.Request) { load(r.PathValue("id")) }',
      "",
      "func load(id string) {}",
      "",
    ].join("\n"),
  );
  write(
    "web/User.tsx",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code with a template literal
    "export function User({ id }: { id: string }) {\n  fetch(`/api/users/${id}`);\n  return null;\n}\n",
  );
  const workspace = new Workspace({ root: dir, git: false });
  const service = await workspace.service();
  const report = service.impact(["go:api/users.go#load"]);
  const reached = report.impacted.map((n) => n.node.id);
  expect(reached).toEqual(
    expect.arrayContaining([
      "go:api/users.go#getUser",
      "go:api/users.go#GET /api/users/{id}",
      "ts:web/User.tsx#User",
    ]),
  );
  expect(report.entryPoints.map((e) => e.node.id)).toContain("go:api/users.go#GET /api/users/{id}");
  expect(service.meta().stats.languages).toMatchObject({ go: 1, ts: 1 });
  workspace.close();
});
