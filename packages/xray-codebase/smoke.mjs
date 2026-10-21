// Packs the package, installs the tarball in a scratch project and runs the real binary
// against a fixture: the closest check to `npx xray-codebase` short of publishing.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "xray-smoke-"));
const run = (cmd, args, cwd = work) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
try {
  const tarball = run("npm", ["pack", "--silent", "--pack-destination", work], here)
    .trim()
    .split("\n")
    .at(-1);
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }),
  );
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", join(work, tarball)]);
  const xray = join(work, "node_modules", ".bin", "xray");
  const repo = join(work, "repo");
  for (const name of ["ts-classes", "py-packages"]) {
    cpSync(join(here, "..", "..", "fixtures", name), join(repo, name), { recursive: true });
  }
  const check = (label, ok) => {
    if (!ok) throw new Error(`smoke: ${label} failed`);
    console.log(`ok - ${label}`);
  };
  check(
    "version",
    run(xray, ["--version"]).trim() ===
      JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version,
  );
  check("scan", /✓ repo: 10 files/.test(run(xray, ["scan", repo, "--no-git"])));
  check(
    "where",
    run(xray, ["where", "create user", "-C", repo, "--no-git"]).includes("create_user"),
  );
  check(
    "impact",
    run(xray, ["impact", "UserRepo.find", "-C", repo, "--no-git"]).includes("AdminRepo.find"),
  );
  run(xray, ["export", "-f", "html", "-o", join(work, "map.html"), "-C", repo, "--no-git"]);
  check("export html", readFileSync(join(work, "map.html"), "utf8").includes('id="xray-snapshot"'));
} finally {
  rmSync(work, { recursive: true, force: true });
}
