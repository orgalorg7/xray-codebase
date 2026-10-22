import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function ready(page: Page, hash = "") {
  await page.goto(`/${hash}`);
  await expect(page.locator(".map-canvas")).toBeVisible();
}

test("shows the overview of the repository", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".panel")).toContainText("Load-bearing code");
  await expect(page.locator(".statusbar")).toContainText("files");
  await expect(page.locator(".statusbar")).toContainText("live");
});

test("finds a feature and opens a symbol with its source", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toBeFocused();
  await page.keyboard.type("admin lookup");
  await expect(page.locator(".search-results")).toContainText("adminLookup");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toContainText("Feature search");
  await page.locator(".panel .node-link", { hasText: "adminLookup" }).first().click();
  await expect(page.locator(".node-title")).toHaveText("adminLookup");
  await expect(page.locator(".signature")).toContainText("(id: string)");
  await expect(page.locator(".code-line-focus").first()).toContainText("adminLookup");
  await expect(page.locator(".panel")).toContainText("Calls");
  await expect(page).toHaveURL(/node=ts%3Ats-classes%2Fsrc%2Fservice\.ts%23adminLookup/);
});

test("opens deep links and walks up with U", async ({ page }) => {
  await ready(
    page,
    `#node=${encodeURIComponent("ts:ts-classes/src/admin-repo.ts#AdminRepo.find")}`,
  );
  await expect(page.locator(".node-title")).toHaveText("AdminRepo.find");
  await expect(page.locator(".panel")).toContainText("Inherits from");
  await page
    .locator(".map-canvas")
    .click({ position: { x: 5, y: 5 } })
    .catch(() => {});
  await page.keyboard.press("Escape");
  await ready(
    page,
    `#node=${encodeURIComponent("ts:ts-classes/src/admin-repo.ts#AdminRepo.find")}`,
  );
  await page.locator("body").press("u");
  await expect(page.locator(".node-title")).toHaveText("AdminRepo");
});

test("computes a blast radius", async ({ page }) => {
  await ready(page, `#node=${encodeURIComponent("ts:ts-classes/src/user-repo.ts#UserRepo.find")}`);
  await page.locator(".actions button", { hasText: "Blast radius" }).click();
  await expect(page.locator(".risk")).toBeVisible();
  await expect(page.locator(".panel")).toContainText("Direct dependents");
  await expect(page.locator(".panel")).toContainText("AdminRepo.find");
});

test("finds directions between two symbols", async ({ page }) => {
  const from = encodeURIComponent("ts:ts-classes/src/service.ts#adminLookup");
  const to = encodeURIComponent("ts:ts-classes/src/repository.ts#Repository.find");
  await ready(page, `#mode=directions&from=${from}&to=${to}`);
  await expect(page.locator(".route li")).toHaveCount(3);
  await expect(page.locator(".route")).toContainText("lookup");
});

test("lists import cycles with suggested cuts", async ({ page }) => {
  await ready(page);
  await page.locator(".modes button", { hasText: "Cycles" }).click();
  // ts-cycles has a three-file loop and a two-file loop closed by a type-only import.
  await expect(page.locator(".cycle-row")).toHaveCount(2);
  await page.locator(".cycle-row").first().click();
  await expect(page.locator(".focus-graph")).toBeVisible();
  await expect(page.locator(".cut-list li").first()).toBeVisible();
  await page.getByLabel("ignore type-only imports").check();
  await expect(page.locator(".cycle-row")).toHaveCount(1);
});

test("shows insights and the dependency matrix", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toContainText("Hotspot files");
  await page.keyboard.press("m");
  await expect(page.locator(".matrix canvas")).toBeVisible();
  await page.locator(".segmented button", { hasText: "Directories" }).click();
  await expect(page).toHaveURL(/level=directory/);
});

test("toggles theme and help from the keyboard", async ({ page }) => {
  await ready(page);
  const before = await page.locator("html").getAttribute("data-theme");
  await page.keyboard.press("t");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", before ?? "");
  await page.keyboard.press("?");
  await expect(page.locator("dialog.help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.help")).toBeHidden();
});

test("selects nodes by clicking the map", async ({ page }) => {
  await ready(page);
  const box = await page.locator(".map-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  // Zoom into the middle until something smaller than a directory is under the cursor.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -400);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".node-kind")).toBeVisible();
});

test("the HTML export works offline", async ({ page }) => {
  const file = readFileSync(join(import.meta.dirname, ".export-path"), "utf8");
  await page.route("**/*", (route) =>
    route.request().url().startsWith("file:") ? route.continue() : route.abort(),
  );
  await page.goto(`file://${file}`);
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".statusbar")).toContainText("snapshot");
  await page.locator(".search input").fill("create user");
  await page.keyboard.press("Enter");
  await page.locator(".panel .node-link", { hasText: "create_user" }).first().click();
  await expect(page.locator(".code-line-focus").first()).toContainText("def create_user");
});

test("compares the architecture with an earlier commit", async ({ page }) => {
  await ready(page, "#mode=changes&base=HEAD~1");
  await expect(page.locator(".node-title")).toHaveText("Since HEAD~1");
  await expect(page.locator(".stats")).toContainText("files", { timeout: 20_000 });
  const added = page.locator(".section", { hasText: "Added files" });
  await expect(added).toContainText("py-packages/app/main.py");
  // A revision that does not exist is explained.
  await page.getByLabel("Git revision to compare with").fill("no-such-branch");
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator(".panel")).toContainText(
    '"no-such-branch" is not a commit, branch or tag',
  );
});
