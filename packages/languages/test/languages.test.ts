import { analyzeProject } from "@xray/testkit";
import { describe, expect, it } from "vitest";
import {
  createCSharpPlugin,
  createGoPlugin,
  createJvmPlugin,
  createPhpPlugin,
  createRubyPlugin,
  createRustPlugin,
} from "../src/index.js";

const code = (text: string): string => `${text.replace(/^\n/, "").replace(/^ {6}/gm, "")}\n`;

describe("Go", () => {
  it("resolves packages without go.mod, dot imports and method-value handlers", async () => {
    const g = await analyzeProject(createGoPlugin(), {
      "util/strings.go": code(`
      package util

      // Clean trims a string.
      func Clean(s string) string { return s }

      const Limit = 10
      `),
      "api/server.go": code(`
      package api

      import (
        . "github.com/acme/app/util"
        _ "github.com/lib/pq"
      )

      type Server struct{}

      func (s *Server) handle(id string) (string, error) { return Clean(id), nil }

      func (s *Server) Routes(mux *http.ServeMux) {
        mux.HandleFunc("/users/{id}", s.handle)
      }
      `),
    });
    expect(
      g.edge("go:api/server.go#Server.handle", "calls", "go:util/strings.go#Clean"),
    ).toBeDefined();
    expect(g.edge("go:api/server.go", "imports", "go:util/strings.go")).toBeDefined();
    expect(g.edge("go:api/server.go", "imports", "ext:go/github.com/lib/pq")).toBeDefined();
    expect(
      g.edge("go:api/server.go#ANY /users/{id}", "handles", "go:api/server.go#Server.handle"),
    ).toBeDefined();
    expect(g.node("go:util/strings.go#Clean")).toMatchObject({
      doc: "Clean trims a string.",
      signature: "(s string) string",
      exported: true,
    });
    expect(g.node("go:api/server.go#Server.handle")?.exported).toBe(false);
    expect(g.node("go:util/strings.go#Limit")).toMatchObject({
      kind: "variable",
      meta: { constant: true },
    });
  });
});

describe("Go module state", () => {
  it("tells reads of package variables from writes, and skips shadowing locals", async () => {
    const g = await analyzeProject(createGoPlugin(), {
      "state/state.go": code(`
      package state

      var count int
      var cache = map[string]int{}
      var cfg = Config{}

      type Config struct{ Debug bool }

      func Bump() {
        count++
        cache["a"] = count
        cfg.Debug = true
      }

      func Show() int { return count + cache["a"] }

      func Local() int {
        count := 5
        return count
      }
      `),
    });
    const access = (from: string, to: string) =>
      g.edges
        .filter(
          (e) =>
            e.source === `go:state/state.go#${from}` &&
            e.target === `go:state/state.go#${to}` &&
            e.kind === "references",
        )
        .map((e) => e.detail)
        .sort();
    expect(access("Bump", "count")).toEqual(["reads", "writes"]);
    expect(access("Bump", "cache")).toEqual(["writes"]);
    expect(access("Bump", "cfg")).toEqual(["writes"]);
    expect(access("Show", "cache")).toEqual(["reads"]);
    expect(access("Local", "count")).toEqual([]);
  });
});

describe("Java and Kotlin", () => {
  it("handles static wildcard imports, JAX-RS and RequestMapping routes, enums and records", async () => {
    const g = await analyzeProject(createJvmPlugin(), {
      "src/main/java/a/Util.java": code(`
      package a;
      public class Util {
        public static int twice(int x) { return x * 2; }
      }
      `),
      "src/main/java/a/Color.java": "package a;\npublic enum Color { RED, GREEN }\n",
      "src/main/java/a/Point.java": "package a;\npublic record Point(int x, int y) {}\n",
      "src/main/java/b/Api.java": code(`
      package b;

      import static a.Util.*;
      import java.util.Collections;

      @Path("/api")
      public class Api {
        @GET
        @Path("/twice")
        public int get() { Collections.sort(null); return twice(2); }

        @RequestMapping(value = "/legacy", method = RequestMethod.POST)
        public void legacy() {}

        public static void main(String[] args) {}
      }
      `),
      "src/main/java/b/Sorter.java": "package b;\nclass Sorter { void sort(Object o) {} }\n",
    });
    expect(
      g.edge(
        "java:src/main/java/b/Api.java#Api.get",
        "calls",
        "java:src/main/java/a/Util.java#Util.twice",
      ),
    ).toBeDefined();
    // Collections is a library class: no guess at a project method named sort.
    expect(
      g.edge(
        "java:src/main/java/b/Api.java#Api.get",
        "calls",
        "java:src/main/java/b/Sorter.java#Sorter.sort",
      ),
    ).toBeUndefined();
    expect(g.node("java:src/main/java/b/Api.java#GET /api/twice")).toMatchObject({
      kind: "route",
      meta: { framework: "jax-rs" },
    });
    // The class-level @Path prefixes every route of the class.
    expect(g.node("java:src/main/java/b/Api.java#POST /api/legacy")).toBeDefined();
    expect(g.node("java:src/main/java/b/Api.java#Api.main")?.meta).toEqual({ entry: "main" });
    expect(g.node("java:src/main/java/a/Color.java#Color.RED")?.kind).toBe("property");
    expect(g.node("java:src/main/java/a/Point.java#Point.x")?.kind).toBe("property");
  });

  it("resolves Kotlin aliases, wildcard package imports, top-level functions and data classes", async () => {
    const g = await analyzeProject(createJvmPlugin(), {
      "src/util/Text.kt": code(`
      package acme.util

      fun shout(s: String): String = s.uppercase()
      `),
      "src/model/User.kt": code(`
      package acme.model

      data class User(val id: String, val name: String) {
          fun greet(): String {
              return "hi"
          }
      }
      `),
      "src/app/Main.kt": code(`
      package acme.app

      import acme.model.User as Person
      import acme.util.*

      fun main() {
          val p = Person("1", "Ada")
          p.greet()
          shout(p.name)
      }
      `),
    });
    expect(
      g.edge("kt:src/app/Main.kt#main", "instantiates", "kt:src/model/User.kt#User"),
    ).toBeDefined();
    expect(
      g.edge("kt:src/app/Main.kt#main", "calls", "kt:src/model/User.kt#User.greet")?.confidence,
    ).toBe("inferred");
    expect(g.edge("kt:src/app/Main.kt#main", "calls", "kt:src/util/Text.kt#shout")).toBeDefined();
    expect(g.node("kt:src/model/User.kt#User.name")?.kind).toBe("property");
    expect(g.node("kt:src/app/Main.kt#main")?.meta).toEqual({ entry: "main" });
  });
});

describe("C#", () => {
  it("handles using static and aliases, parent namespaces, foreach locals and method routes", async () => {
    const g = await analyzeProject(createCSharpPlugin(), {
      "Core/Math.cs": code(`
      namespace Acme.Core
      {
          public static class MathX { public static int Twice(int x) => x * 2; }
          public class Item { public void Ship() { } }
      }
      `),
      "Core/Orders/Order.cs": code(`
      using static Acme.Core.MathX;
      using Things = Acme.Core.Item;

      namespace Acme.Core.Orders;

      [Route("orders")]
      public class OrdersController
      {
          [HttpGet]
          [Route("{id}")]
          public int Get(List<Item> items)
          {
              foreach (Item item in items) { item.Ship(); }
              var t = new Things();
              return Twice(1);
          }
      }
      `),
    });
    const order = "cs:Core/Orders/Order.cs#OrdersController.Get";
    expect(g.edge(order, "calls", "cs:Core/Math.cs#MathX.Twice")).toBeDefined();
    // Item comes from the enclosing namespace Acme.Core, without a using.
    expect(g.edge(order, "calls", "cs:Core/Math.cs#Item.Ship")).toBeDefined();
    expect(g.edge(order, "instantiates", "cs:Core/Math.cs#Item")).toBeDefined();
    expect(g.node("cs:Core/Orders/Order.cs#GET /orders/{id}")).toBeDefined();
  });
});

describe("Rust", () => {
  it("resolves mod.rs modules, trait default methods, Self and enum variants", async () => {
    const g = await analyzeProject(createRustPlugin(), {
      "src/main.rs": code(`
      mod shapes;
      use shapes::{Shape, Circle, Kind};

      fn main() {
          let c = Circle::new(1.0);
          c.describe();
          let k = Kind::Round;
      }
      `),
      "src/shapes/mod.rs": code(`
      pub trait Shape {
          fn area(&self) -> f64;
          fn describe(&self) -> String { format!("{}", self.area()) }
      }

      pub enum Kind { Round, Square }

      pub struct Circle { r: f64 }

      impl Circle {
          pub fn new(r: f64) -> Self { Self { r } }
      }

      impl Shape for Circle {
          fn area(&self) -> f64 { self.r * self.r }
      }
      `),
    });
    expect(g.edge("rs:src/main.rs", "imports", "rs:src/shapes/mod.rs")).toBeDefined();
    expect(g.edge("rs:src/main.rs#main", "calls", "rs:src/shapes/mod.rs#Circle.new")).toBeDefined();
    // describe is a default method of the Shape trait Circle implements.
    expect(
      g.edge("rs:src/main.rs#main", "calls", "rs:src/shapes/mod.rs#Shape.describe")?.confidence,
    ).toBe("inferred");
    expect(
      g.edge("rs:src/shapes/mod.rs#Circle.area", "overrides", "rs:src/shapes/mod.rs#Shape.area"),
    ).toMatchObject({ detail: "implements" });
    expect(
      g.edge("rs:src/shapes/mod.rs#Circle.new", "instantiates", "rs:src/shapes/mod.rs#Circle"),
    ).toBeDefined();
    expect(g.node("rs:src/shapes/mod.rs#Kind.Round")?.kind).toBe("property");
  });
});

describe("PHP", () => {
  it("follows require_once, global functions, Symfony routes and enum cases", async () => {
    const g = await analyzeProject(createPhpPlugin(), {
      "lib/helpers.php": "<?php\nfunction slug(string $s): string { return $s; }\n",
      "src/Status.php": "<?php\nnamespace App;\n\nenum Status: string { case Active = 'a'; }\n",
      "src/Controller/Pages.php": code(`
      <?php
      namespace App\\Controller;

      require_once __DIR__ . '/../../lib/helpers.php';
      require_once 'lib/helpers.php';

      #[Route('/pages')]
      class Pages
      {
          #[Route('/{id}', methods: ['GET', 'HEAD'])]
          public function show(string $id): string { return slug($id); }
      }
      `),
    });
    expect(g.edge("php:src/Controller/Pages.php", "imports", "php:lib/helpers.php")).toBeDefined();
    expect(
      g.edge("php:src/Controller/Pages.php#Pages.show", "calls", "php:lib/helpers.php#slug"),
    ).toBeDefined();
    expect(
      g.edge(
        "php:src/Controller/Pages.php#GET /pages/{id}",
        "handles",
        "php:src/Controller/Pages.php#Pages.show",
      ),
    ).toBeDefined();
    expect(g.node("php:src/Controller/Pages.php#HEAD /pages/{id}")).toBeDefined();
    expect(g.node("php:src/Status.php#Status.Active")?.kind).toBe("property");
  });
});

describe("Ruby", () => {
  it("guesses only unique, distinctive method names and knows gems from the standard library", async () => {
    const g = await analyzeProject(createRubyPlugin(), {
      "lib/report.rb": code(`
      require "json"
      require "nokogiri"

      class Report
        attr_accessor :title

        def render_pdf; end
        def save; end
      end
      `),
      "lib/job.rb": code(`
      class Job
        def run(report)
          report.render_pdf
          report.save
        end
      end
      `),
      "test/job_test.rb": code(`
      class JobTest < Minitest::Test
        def test_run
          Job.new.run(nil)
        end
      end
      `),
    });
    expect(
      g.edge("rb:lib/job.rb#Job.run", "calls", "rb:lib/report.rb#Report.render_pdf")?.confidence,
    ).toBe("heuristic");
    // `save` is too common a name to guess.
    expect(
      g.edge("rb:lib/job.rb#Job.run", "calls", "rb:lib/report.rb#Report.save"),
    ).toBeUndefined();
    expect(g.edge("rb:lib/report.rb", "imports", "ext:gem/nokogiri")).toBeDefined();
    expect(g.keys("imports").some((k) => k.includes("json"))).toBe(false);
    expect(g.node("rb:lib/report.rb#Report.title")?.kind).toBe("property");
    expect(g.node("rb:test/job_test.rb#JobTest.test_run")?.kind).toBe("test");
    // Job.new certainly builds a Job.
    expect(
      g.edge("rb:test/job_test.rb#JobTest.test_run", "calls", "rb:lib/job.rb#Job.run")?.confidence,
    ).toBe("exact");
  });
});

describe("shared plugin behavior", () => {
  it("reports syntax errors but keeps what it can read", async () => {
    const g = await analyzeProject(createGoPlugin(), {
      "a.go": "package a\n\nfunc Good() {}\n\nfunc Broken( {\n",
    });
    expect(g.node("go:a.go#Good")).toBeDefined();
    expect(g.diagnostics).toEqual([
      { severity: "warning", file: "a.go", message: "syntax errors; results may be partial" },
    ]);
  });

  it("reuses unchanged results and re-resolves after a change", async () => {
    const plugin = createGoPlugin();
    const file = (text: string) => ({
      path: "a.go",
      absolutePath: "/a.go",
      language: "go" as const,
      text,
      hash: String(text.length),
    });
    const first = await plugin.analyze({ root: "/", files: [file("package a\nfunc A() {}\n")] });
    const again = await plugin.analyze({ root: "/", files: [file("package a\nfunc A() {}\n")] });
    expect(again).toBe(first);
    const changed = await plugin.analyze({
      root: "/",
      files: [file("package a\nfunc A() { B() }\nfunc B() {}\n")],
    });
    expect(
      changed.files[0]?.edges.some((e) => e.kind === "calls" && e.target === "go:a.go#B"),
    ).toBe(true);
  });
});
