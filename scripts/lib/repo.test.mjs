// Run: node --test plugin/scripts/lib/repo.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("gitRoot is the checkout it runs in, and the cwd when there is none", () => {
  // Every case is a checkout this test builds, never the one it happens to sit
  // in. Asserting `gitRoot() === <three levels up>` read as a test of gitRoot
  // and was a test of where this FILE lives: true in the development checkout,
  // false in an install, where `plugin/`'s contents are the root and there may
  // be no enclosing checkout at all. The behaviour is the same either way, so
  // the fixture is built rather than assumed.
  //
  // A child process, because gitRoot() reads the process's own cwd.
  const ask = (cwd) => execFileSync(process.execPath,
    ["-e", `import("${path.join(HERE, "repo.mjs")}").then((m) => console.log(m.gitRoot()))`],
    { cwd, encoding: "utf8" }).trim();
  const outside = mkdtempSync(path.join(tmpdir(), "repo-"));
  assert.equal(ask(outside), realpathSync(outside), "no checkout: the cwd, not a throw");
  const inside = mkdtempSync(path.join(tmpdir(), "repo-"));
  execFileSync("git", ["init", "-q"], { cwd: inside });
  assert.equal(ask(inside), realpathSync(inside));

  // From a subdirectory, which is the shape every real caller runs in: the
  // scripts live under `plugin/scripts/`, never at the root of the checkout.
  const nested = path.join(inside, "plugin", "scripts", "lib");
  mkdirSync(nested, { recursive: true });
  assert.equal(ask(nested), realpathSync(inside), "the checkout root, not the directory it was called from");
});
