// Run: node --test plugin/scripts/lib/repo.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitRoot } from "./repo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("gitRoot is the checkout it runs in, and the cwd when there is none", () => {
  // Three levels, not two: the plugin is a subdirectory of the checkout
  // (`<repo>/plugin/scripts/lib`), because only `plugin/` is what gets installed.
  assert.equal(gitRoot(), realpathSync(path.join(HERE, "..", "..", "..")));

  // A child process, because gitRoot() reads the process's own cwd.
  const ask = (cwd) => execFileSync(process.execPath,
    ["-e", `import("${path.join(HERE, "repo.mjs")}").then((m) => console.log(m.gitRoot()))`],
    { cwd, encoding: "utf8" }).trim();
  const outside = mkdtempSync(path.join(tmpdir(), "repo-"));
  assert.equal(ask(outside), realpathSync(outside), "no checkout: the cwd, not a throw");
  const inside = mkdtempSync(path.join(tmpdir(), "repo-"));
  execFileSync("git", ["init", "-q"], { cwd: inside });
  assert.equal(ask(inside), realpathSync(inside));
});
