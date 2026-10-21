import { describe, expect, it } from "vitest";
import { FeatureIndex, stem, tokenize } from "../src/index.js";
import { graph } from "./helpers.js";

const app = graph(({ n, e }) => {
  n("ts:src/auth/routes.ts#POST /login", "route", { meta: { method: "POST", path: "/login" } });
  n("ts:src/auth/handlers.ts#loginHandler");
  n("ts:src/auth/password.ts#validatePassword", "function", {
    doc: "Checks a password against its hash.",
  });
  n("ts:src/auth/password.ts#hashSecret");
  n("ts:src/auth/service.ts#AuthService", "class");
  n("ts:src/auth/service.ts#AuthService.signIn", "method", {
    doc: "Signs a user in and returns a session.",
  });
  n("ts:src/billing/invoice.ts#createInvoice");
  n("ts:src/util/date.ts#formatDate");
  n("ts:src/auth/login.test.ts#test:logs in", "test");
  e("ts:src/auth/routes.ts#POST /login", "handles", "ts:src/auth/handlers.ts#loginHandler");
  e("ts:src/auth/handlers.ts#loginHandler", "calls", "ts:src/auth/service.ts#AuthService.signIn");
  e(
    "ts:src/auth/service.ts#AuthService.signIn",
    "calls",
    "ts:src/auth/password.ts#validatePassword",
  );
  e("ts:src/auth/password.ts#validatePassword", "calls", "ts:src/auth/password.ts#hashSecret");
  e("ts:src/auth/login.test.ts#test:logs in", "calls", "ts:src/auth/handlers.ts#loginHandler");
  e("ts:src/billing/invoice.ts#createInvoice", "calls", "ts:src/util/date.ts#formatDate");
});

describe("tokenize and stem", () => {
  it("drops question words and normalizes forms", () => {
    expect(tokenize("Where is the login handled?")).toEqual(["login"]);
    // Stems need only be consistent between queries and code, not real words.
    expect(tokenize("getUserSettings")).toEqual(["get", "user", "sett"]);
    expect(["users", "caches", "queries", "logging", "saved", "status", "class"].map(stem)).toEqual(
      ["user", "cach", "query", "logg", "sav", "status", "class"],
    );
  });
});

describe("FeatureIndex", () => {
  const features = new FeatureIndex(app);

  it("finds a feature's code and its territory", () => {
    const result = features.search("where is login handled");
    const ids = result.hits.map((h) => h.id);
    expect(ids.slice(0, 3)).toEqual(
      expect.arrayContaining([
        "ts:src/auth/routes.ts#POST /login",
        "ts:src/auth/handlers.ts#loginHandler",
      ]),
    );
    expect(ids).toContain("ts:src/auth/password.ts#validatePassword"); // through the graph
    expect(ids.indexOf("ts:src/util/date.ts#formatDate")).toBe(-1);
    expect(result.territory.entryPoints).toEqual(["ts:src/auth/routes.ts#POST /login"]);
    expect(result.territory.tests).toEqual(["ts:src/auth/login.test.ts#test:logs in"]);
    expect(result.territory.modules[0]?.id.startsWith("ts:src/auth/")).toBe(true);
  });

  it("matches split identifiers, docs and synonyms", () => {
    expect(features.search("sign in")?.hits[0]?.id).toBe(
      "ts:src/auth/service.ts#AuthService.signIn",
    );
    expect(features.search("password hash")?.hits[0]?.id).toBe(
      "ts:src/auth/password.ts#validatePassword",
    );
    const auth = features.search("authentication").hits.map((h) => h.id);
    expect(auth).toContain("ts:src/auth/handlers.ts#loginHandler");
    expect(features.search("invoices").hits[0]?.id).toBe("ts:src/billing/invoice.ts#createInvoice");
  });

  it("records which query terms each hit matched", () => {
    const hit = features
      .search("login password")
      .hits.find((h) => h.id.endsWith("#validatePassword"));
    expect(hit?.matched).toEqual(["password"]);
  });

  it("returns nothing for empty or unmatched queries", () => {
    expect(features.search("where is the").hits).toEqual([]);
    expect(features.search("kubernetes").hits).toEqual([]);
  });
});
