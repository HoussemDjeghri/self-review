import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unverifiedChecks } from "./preflight-report.mjs";

const PREFLIGHT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "preflight.sh");

// Lines exactly as preflight.sh prints them.
const PASS = "PASS  test    pnpm test";
const FAIL = "FAIL  test    pnpm test   (exit 1)";
const UNFINISHED = "INFRA test    pnpm test   (did not finish in 300s — no verdict on the code; re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged)";
const SPENT = "SKIP  lint    pnpm lint   (pre-flight budget spent — re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged)";
const NOT_STARTED = "INFRA types   tsc --noEmit   (exit 127 — the command could not be run; the check never started)";
const SKIPPED = "SKIP  format  (preflight.skip)";

function review(reports) {
  const work = mkdtempSync(path.join(tmpdir(), "pf-report-"));
  let t = 1_700_000_000;
  for (const [rel, lines] of reports) {
    const file = path.join(work, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `# pre-flight\n${lines.join("\n")}\n`);
    utimesSync(file, t, t);
    t += 60;
  }
  return work;
}

test("a check stopped at its cap, or never started for want of budget, has no verdict", () => {
  const work = review([["round-1/preflight.txt", [UNFINISHED, SPENT, PASS.replace("test ", "build").replace("pnpm test", "pnpm build")]]]);
  assert.deepEqual(unverifiedChecks(work).map((c) => [c.kind, c.cmd, c.why]), [
    ["test", "pnpm test", "did not finish in 300s"],
    ["lint", "pnpm lint", "pre-flight budget spent"],
  ]);
});

test("a check that could not start, one skipped on purpose, and a FAIL are verdicts or decisions, not gaps", () => {
  const work = review([["round-1/preflight.txt", [NOT_STARTED, SKIPPED, FAIL]]]);
  assert.deepEqual(unverifiedChecks(work), []);
});

test("a newer report's real verdict clears the check; an older one does not", () => {
  const cleared = review([["round-1/preflight.txt", [UNFINISHED]], ["preflight-rerun.txt", [PASS]]]);
  assert.deepEqual(unverifiedChecks(cleared), []);
  const stale = review([["preflight-rerun.txt", [PASS]], ["round-1/preflight.txt", [UNFINISHED]]]);
  assert.equal(unverifiedChecks(stale).length, 1);
});

test("a re-run that names only one check leaves the others as they were", () => {
  const work = review([["round-1/preflight.txt", [UNFINISHED, SPENT]], ["preflight-rerun.txt", [PASS]]]);
  assert.deepEqual(unverifiedChecks(work).map((c) => c.cmd), ["pnpm lint"]);
});

test("a newer could-not-start line is not a verdict: the unfinished check stays unverified", () => {
  const work = review([["round-1/preflight.txt", [UNFINISHED]], ["preflight-rerun.txt", ["INFRA test    pnpm test   (exit 127 — the command could not be run; the check never started)"]]]);
  assert.deepEqual(unverifiedChecks(work).map((c) => [c.kind, c.cmd, c.why]), [["test", "pnpm test", "did not finish in 300s"]]);
});

test("a newer preflight.skip for a kind clears every earlier entry of that kind", () => {
  const work = review([["round-1/preflight.txt", [UNFINISHED]], ["preflight-rerun.txt", ["SKIP  test    (preflight.skip)"]]]);
  assert.deepEqual(unverifiedChecks(work), []);
});

test("only the status block is read: a quoted tail below a `--- ` line is never parsed", () => {
  const work = review([["round-1/preflight.txt", [PASS, "--- FAIL test: pnpm test (last lines) ---", "INFRA test    pnpm test   (did not finish in 300s — quoted output)"]]]);
  assert.deepEqual(unverifiedChecks(work), []);
});

test("a report the real preflight.sh writes for a hanging check reads as unverified", () => {
  // The fixture of scripts/preflight.test.mjs's hanging-check test, inlined: a
  // package.json test script and an `npm` stub on PATH that never finishes.
  const root = mkdtempSync(path.join(tmpdir(), "pf-report-run-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  const bin = path.join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nsleep 30\n");
  chmodSync(path.join(bin, "npm"), 0o755);
  const work = mkdtempSync(path.join(tmpdir(), "pf-report-work-"));
  const result = spawnSync("bash", [PREFLIGHT, "--root", root, "--out", path.join(work, "round-1", "preflight.txt")], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SELF_REVIEW_CONFIG: path.join(tmpdir(), "preflight-test-no-such-config.json"),
      SELF_REVIEW_PREFLIGHT_TIMEOUT: "1", SELF_REVIEW_PREFLIGHT_GRACE: "1" },
  });
  assert.equal(result.status, 0, `preflight exited ${result.status}: ${result.stderr}`);
  assert.deepEqual(unverifiedChecks(work).map((c) => [c.kind, c.cmd, c.why]), [["test", "npm test", "did not finish in 1s"]]);
});

test("no work dir, or one with no reports, has nothing unverified", () => {
  assert.deepEqual(unverifiedChecks(path.join(tmpdir(), "no-such-review-dir")), []);
  assert.deepEqual(unverifiedChecks(review([])), []);
});

test("a newer report that detects a different command for the same kind still decides it", () => {
  const work = review([["round-1/preflight.txt", [UNFINISHED]], ["preflight-rerun.txt", ["PASS  test    npm test"]]]);
  assert.deepEqual(unverifiedChecks(work), []);
});

test("a report that is listed but cannot be read blocks rather than passing", () => {
  const work = review([]);
  mkdirSync(path.join(work, "round-1", "preflight.txt"), { recursive: true });
  assert.deepEqual(unverifiedChecks(work).map((c) => c.why), ["report unreadable"]);
  // The re-run every message prescribes supersedes it.
  const rerun = path.join(work, "preflight-rerun.txt");
  writeFileSync(rerun, "# pre-flight\nPASS  test    pnpm test\n");
  utimesSync(rerun, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  assert.deepEqual(unverifiedChecks(work), []);
});
