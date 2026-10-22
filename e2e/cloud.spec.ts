import { expect, test } from "@playwright/test";

// The hosted xray, started by the global setup with two local stand-ins for GitHub repositories.
test.use({ baseURL: "http://127.0.0.1:4498" });

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  // Content Security Policy violations are reported as console errors.
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("maps a pasted repository and opens its map", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("X-ray vision for any codebase");
  await page.getByLabel("GitHub repository").fill("https://github.com/acme/shop");
  await page.getByRole("button", { name: "Map it" }).click();
  await expect(page.locator(".progress h2")).toContainText("acme/shop");
  await page.waitForURL(/\/github\/acme\/shop\/[0-9a-f]{40}$/);
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".brand-name")).toHaveText("acme/shop");
  await expect(page.locator(".statusbar .origin")).toHaveText(
    /github\.com\/acme\/shop · main @ [0-9a-f]{7}/,
  );
  await expect(page).toHaveTitle("acme/shop · xray");

  // Symbols link to their source on GitHub, at the mapped commit.
  await page.keyboard.press("/");
  await page.keyboard.type("admin lookup");
  await page.keyboard.press("Enter");
  await page.locator(".panel .node-link", { hasText: "adminLookup" }).first().click();
  await expect(page.locator(".node-title")).toHaveText("adminLookup");
  const github = page.getByRole("link", { name: "View on GitHub" }).first();
  await expect(github).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/acme\/shop\/blob\/[0-9a-f]{40}\/src\/service\.ts#L\d+$/,
  );
  await expect(github).toHaveAttribute("target", "_blank");
});

test("maps a repository from a swapped GitHub link and lists recent maps", async ({ page }) => {
  await page.goto("/github.com/acme/tools");
  await page.waitForURL(/\/github\/acme\/tools\/[0-9a-f]{40}$/);
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".statusbar")).toContainText("files");

  await page.goto("/");
  await expect(page.locator(".recent")).toContainText("acme/tools");
  await expect(page.locator(".recent")).toContainText("Python");
  await page.locator(".recent a", { hasText: "tools" }).click();
  await expect(page.locator(".brand-name")).toHaveText("acme/tools");
});

test("explains repositories it cannot map", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("GitHub repository").fill("acme/missing");
  await page.getByRole("button", { name: "Map it" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "github.com/acme/missing was not found, or it is private",
  );
  // The failed request itself is logged by the browser; it is expected here.
  errors.length = 0;
});
