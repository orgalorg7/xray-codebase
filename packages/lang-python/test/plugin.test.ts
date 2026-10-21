import { analyzeProject } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import { createPythonPlugin } from "../src/index.js";

const analyze = (files: Record<string, string>) => analyzeProject(createPythonPlugin(), files);
const py = (code: string): string => `${code.replace(/^\n/, "").replace(/^ {8}/gm, "")}\n`;

describe("framework entry points", () => {
  it("detects FastAPI and Flask routes", async () => {
    const g = await analyze({
      "api.py": py(`
        from fastapi import FastAPI
        app = FastAPI()

        @app.get("/items/{id}")
        def get_item(id: int):
            return load(id)

        @app.route("/legacy", methods=["GET", "POST"])
        def legacy():
            pass

        def load(id):
            pass
      `),
    });
    expect(g.node("py:api.py#GET /items/{id}")).toMatchObject({
      kind: "route",
      meta: { path: "/items/{id}" },
    });
    expect(g.edge("py:api.py#GET /items/{id}", "handles", "py:api.py#get_item")).toBeDefined();
    expect(g.edge("py:api.py#GET /legacy", "handles", "py:api.py#legacy")).toBeDefined();
    expect(g.edge("py:api.py#POST /legacy", "handles", "py:api.py#legacy")).toBeDefined();
    expect(g.edge("py:api.py#get_item", "calls", "py:api.py#load")).toBeDefined();
    expect(g.edge("py:api.py", "imports", "ext:pypi/fastapi")).toBeDefined();
  });

  it("detects click commands and groups", async () => {
    const g = await analyze({
      "cli.py": py(`
        import click

        @click.group()
        def cli():
            pass

        @cli.command("sync")
        def sync_cmd():
            pass

        @cli.command()
        def clean_all():
            pass
      `),
    });
    expect(g.node("py:cli.py#command:cli")).toMatchObject({
      kind: "cli-command",
      meta: { group: true },
    });
    expect(g.edge("py:cli.py#command:sync", "handles", "py:cli.py#sync_cmd")).toBeDefined();
    expect(g.edge("py:cli.py#command:clean-all", "handles", "py:cli.py#clean_all")).toBeDefined();
  });

  it("detects Django url patterns", async () => {
    const g = await analyze({
      "urls.py": py(`
        from django.urls import path
        from views import ItemView, index

        urlpatterns = [path("", index), path("items/<int:pk>/", ItemView.as_view())]
      `),
      "views.py": py(`
        def index(request):
            pass

        class ItemView:
            pass
      `),
    });
    expect(g.edge("py:urls.py#ANY /", "handles", "py:views.py#index")).toBeDefined();
    expect(
      g.edge("py:urls.py#ANY /items/<int:pk>/", "handles", "py:views.py#ItemView"),
    ).toBeDefined();
  });

  it("marks pytest tests", async () => {
    const g = await analyze({
      "api.py": "def load(x):\n    pass\n",
      "tests/test_api.py": py(`
        from api import load

        def test_load():
            load(1)

        def helper():
            pass

        class TestThing:
            def test_x(self):
                pass
      `),
    });
    expect(g.node("py:tests/test_api.py#test_load")?.kind).toBe("test");
    expect(g.node("py:tests/test_api.py#helper")?.kind).toBe("function");
    expect(g.node("py:tests/test_api.py#TestThing.test_x")?.kind).toBe("test");
    expect(g.edge("py:tests/test_api.py#test_load", "calls", "py:api.py#load")).toBeDefined();
  });
});

describe("resolution", () => {
  it("resolves dotted imports, aliases and star imports", async () => {
    const g = await analyze({
      "a/__init__.py": "",
      "a/b.py": "def f():\n    pass\n",
      "c.py": '__all__ = ["g"]\n\ndef g():\n    pass\n\ndef hidden():\n    pass\n',
      "use.py": py(`
        import a.b
        import a.b as ab
        from c import *

        def run():
            a.b.f()
            ab.f()
            g()
            hidden()
      `),
    });
    // Two call sites of f (a.b.f() and ab.f()), one of g; hidden is not star-exported.
    expect([...new Set(g.keys("calls"))].sort()).toEqual([
      "py:use.py#run -calls-> py:a/b.py#f",
      "py:use.py#run -calls-> py:c.py#g",
    ]);
    expect(g.keys("imports").sort()).toEqual([
      "py:use.py -imports-> py:a/b.py",
      "py:use.py -imports-> py:c.py",
    ]);
  });

  it("infers types from annotations, return types and instance attributes", async () => {
    const g = await analyze({
      "repo.py": py(`
        class Repo:
            def save(self):
                pass

        def make() -> Repo:
            return Repo()

        def by_param(r: Repo):
            r.save()

        def by_return():
            make().save()

        class Service:
            def __init__(self):
                self.repo = Repo()

            def run(self):
                self.repo.save()
      `),
    });
    for (const source of ["by_param", "by_return", "Service.run"]) {
      expect(
        g.edge(`py:repo.py#${source}`, "calls", "py:repo.py#Repo.save")?.confidence,
        source,
      ).toBe("inferred");
    }
  });

  it("resolves super() and respects local shadowing", async () => {
    const g = await analyze({
      "m.py": py(`
        class Base:
            def __init__(self):
                pass

        class Child(Base):
            def __init__(self):
                super().__init__()

        def create():
            pass

        def shadow():
            create = make_other()
            create()
      `),
    });
    expect(g.edge("py:m.py#Child.__init__", "calls", "py:m.py#Base.__init__")?.detail).toBe(
      "super-call",
    );
    expect(g.edge("py:m.py#Child.__init__", "overrides", "py:m.py#Base.__init__")).toBeDefined();
    expect(g.edge("py:m.py#shadow", "calls", "py:m.py#create")).toBeUndefined();
  });

  it("marks TYPE_CHECKING imports type-only and resolves `from . import x`", async () => {
    const g = await analyze({
      "pkg/__init__.py": "",
      "pkg/models.py": "class Model:\n    pass\n",
      "pkg/sibling.py": "def helper():\n    pass\n",
      "pkg/use.py": py(`
        from typing import TYPE_CHECKING
        from . import sibling

        if TYPE_CHECKING:
            from .models import Model

        def run(m: "Model"):
            sibling.helper()
      `),
    });
    expect(g.edge("py:pkg/use.py", "imports", "py:pkg/models.py")?.detail).toBe("type-only");
    expect(g.edge("py:pkg/use.py", "imports", "py:pkg/sibling.py")?.detail).toBeUndefined();
    expect(g.edge("py:pkg/use.py#run", "calls", "py:pkg/sibling.py#helper")).toBeDefined();
    expect(g.edge("py:pkg/use.py#run", "references", "py:pkg/models.py#Model")).toBeUndefined();
  });

  it("records docstrings, signatures, decorators and callback references", async () => {
    const g = await analyze({
      "m.py": py(`
        import functools

        def worker(item):
            """Process one item.

            Longer description."""
            return item

        @functools.cache
        def run_all(items: list) -> list:
            return list(map(worker, items))
      `),
    });
    expect(g.node("py:m.py#worker")).toMatchObject({
      doc: "Process one item.",
      signature: "(item)",
    });
    expect(g.node("py:m.py#run_all")).toMatchObject({
      signature: "(items: list) -> list",
      meta: { decorators: ["functools.cache"] },
    });
    expect(g.edge("py:m.py#run_all", "references", "py:m.py#worker")).toBeDefined();
    expect(g.keys("imports")).toEqual([]);
  });
});

describe("heuristics", () => {
  it("guesses only for unknown receivers, and only methods", async () => {
    const g = await analyze({
      "m.py": py(`
        import click

        class Group(click.Group):
            def make_context(self, name):
                return super().make_context(name)

        cmd = click.Command("x")

        def use(thing):
            thing.make_context("a")
            cmd.make_context("b")

        def make_report():
            pass

        def other(x):
            x.make_report()
      `),
    });
    expect(g.edge("py:m.py#use", "calls", "py:m.py#Group.make_context")?.confidence).toBe(
      "heuristic",
    );
    expect(
      g.edges.filter((e) => e.target === "py:m.py#Group.make_context" && e.kind === "calls"),
    ).toHaveLength(1);
    expect(g.edge("py:m.py#other", "calls", "py:m.py#make_report")).toBeUndefined();
  });
});

describe("robustness", () => {
  it("terminates on self-referential assignments", async () => {
    const g = await analyze({
      "m.py": py(`
        class Node:
            def walk(self):
                node = self
                node = node.parent
                node = node.parent.parent
                node.walk()

        config = config.child
        config.load()
      `),
    });
    expect(g.diagnostics).toEqual([]);
    expect(g.node("py:m.py#Node.walk")).toBeDefined();
  });
});
