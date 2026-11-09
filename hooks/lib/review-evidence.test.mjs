import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidateDirs, convergedProblems, isEvidenceOf, resolveReviewDir } from "./review-evidence.mjs";

const idOf = (p) => spawnSync("git", ["hash-object", "--stdin"], { input: p, encoding: "utf8" }).stdout.slice(0, 8);
function reviews(n) {
  const base = mkdtempSync(path.join(tmpdir(), "rev-ev-"));
  return Array.from({ length: n }, (_, i) => { const d = path.join(base, `review-${i + 1}`); mkdirSync(d); return d; });
}

test("an id resolves to the review dir whose path round.sh hashed, in either spelling", () => {
  const [a, b] = reviews(2);
  assert.equal(resolveReviewDir(idOf(b), candidateDirs([a])), b, "a sibling of an announced dir is a candidate");
  const real = realpathSync(a);
  const link = path.join(mkdtempSync(path.join(tmpdir(), "rev-ln-")), "review-1");
  symlinkSync(real, link);
  assert.equal(resolveReviewDir(idOf(real), [link]), link, "a hash of the resolved spelling still finds the given one");
  assert.equal(resolveReviewDir("0000beef", candidateDirs([a])), null);
  assert.equal(resolveReviewDir(null, candidateDirs([a])), null);
});

test("evidence is a preflight*.txt in the review dir or one of its round dirs, nothing else", () => {
  const [dir] = reviews(1);
  assert.ok(isEvidenceOf(path.join(dir, "preflight-rerun.txt"), dir));
  assert.ok(isEvidenceOf(path.join(dir, "round-2", "preflight.txt"), dir));
  assert.ok(!isEvidenceOf(path.join(dir, "round-2", "x", "preflight.txt"), dir));
  assert.ok(!isEvidenceOf(path.join(dir, "notes.txt"), dir));
  assert.ok(!isEvidenceOf(path.join(path.dirname(dir), "review-9", "preflight.txt"), dir));
});

test("with no dir and no id, only open review dirs are judged", () => {
  const [open, closed] = reviews(2);
  for (const d of [open, closed]) {
    mkdirSync(path.join(d, "round-1"));
    writeFileSync(path.join(d, "round-1", "preflight.txt"), "# pre-flight\nINFRA test    pnpm test   (did not finish in 300s)\n");
  }
  writeFileSync(path.join(closed, "CONVERGED.json"), "{}");
  const problems = convergedProblems({ openBases: [path.dirname(open)] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`in ${open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
});
