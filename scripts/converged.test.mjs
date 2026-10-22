// Run: node --test plugin/scripts/converged.test.mjs   (or ./test.sh for everything)
//
// converged.sh is one of the two convergence markers the Stop gate accepts, so
// two things must hold no matter what: the token line reaches stdout (the gate
// matches the OUTPUT), and the audit log stays one parseable JSON record per
// run. Since the record became typed, a third holds too: a summary typed the
// old way is refused HERE, in the same turn, rather than at the gate a Stop
// cycle later. The grammar itself is tested in lib/marker.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONVERGED = path.join(path.dirname(fileURLToPath(import.meta.url)), "converged.sh");
const freshLogDir = () => mkdtempSync(path.join(tmpdir(), "converged-"));

// SELF_REVIEW_LOG_DIR is always set: unset (or empty) means ~/.claude/self-review,
// and a test must never append to the user's real log.
const run = (args, logDir, cwd = process.cwd()) =>
  spawnSync("bash", [CONVERGED, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SELF_REVIEW_LOG_DIR: logDir },
  });

const records = (logDir) =>
  readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const CONVERGED_ARGS = ["--converged", "--rounds", "2", "--fixed", "3", "--dismissed", "1", "--open", "0", "--intent", "author"];

test("prints the token the gate matches and logs one typed JSON record", () => {
  const logDir = freshLogDir();
  const result = run([...CONVERGED_ARGS, "--tier", "M"], logDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^SELF-REVIEW CONVERGED — outcome=converged rounds=2 fixed=3 dismissed=1 open=0 tier=M intent=author$/m);
  const [record] = records(logDir);
  assert.equal(record.summary, "outcome=converged rounds=2 fixed=3 dismissed=1 open=0 tier=M intent=author");
  assert.equal(record.outcome, "converged");
  assert.equal(record.rounds, 2);          // a number, not the string that used to corrupt the sums
  assert.equal(record.cwd, process.cwd());
  assert.ok(!Number.isNaN(Date.parse(record.ts)), `ts not a date: ${record.ts}`);
});

test("the escape hatch is a marker too — it prints the same token and logs its reason", () => {
  const logDir = freshLogDir();
  const result = run(["--not-applicable", "user-declined", "--note", 'they said "skip it"'], logDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^SELF-REVIEW CONVERGED — outcome=not-applicable reason=user-declined$/m);
  const [record] = records(logDir);
  assert.equal(record.outcome, "not-applicable");
  assert.equal(record.reason, "user-declined");
  assert.equal(record.note, 'they said "skip it"');
  assert.equal(record.rounds, undefined);  // a non-review must not present as rounds=0
});

test("a note with quotes, backslashes and newlines round-trips through the log", () => {
  const logDir = freshLogDir();
  const note = 'he said "no" \\ then: rounds=1\nsecond line';
  assert.equal(run([...CONVERGED_ARGS, "--note", note], logDir).status, 0);
  assert.equal(records(logDir)[0].note, note);
});

test("each run appends; earlier records survive", () => {
  const logDir = freshLogDir();
  run(CONVERGED_ARGS, logDir);
  run(["--not-applicable", "scratch-only"], logDir);
  assert.deepEqual(records(logDir).map((r) => r.outcome), ["converged", "not-applicable"]);
});

test("a summary typed the old way is refused here, with the rewrite in the message", () => {
  const logDir = freshLogDir();
  const result = run(["rounds=2 fixed=3 dismissed=1 open=0"], logDir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /built from flags now/);
  assert.match(result.stderr, /usage: converged\.sh --converged/);
  assert.doesNotMatch(result.stdout, /CONVERGED/);
  assert.equal(existsSync(path.join(logDir, "log.jsonl")), false);
});

test("no arguments is a usage error that writes nothing", () => {
  const logDir = freshLogDir();
  const result = run([], logDir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: converged\.sh/);
  assert.doesNotMatch(result.stdout, /CONVERGED/);
  assert.equal(existsSync(path.join(logDir, "log.jsonl")), false);
});

// Sessions reached for `--help` six times in ten days of field use and got
// "unknown flag" plus the usage — the answer, reported as a failure.
for (const flag of ["--help", "-h"]) {
  test(`${flag} prints the usage and succeeds without marking anything`, () => {
    const logDir = freshLogDir();
    const result = run([flag], logDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /usage: converged\.sh/);
    assert.doesNotMatch(result.stdout, /CONVERGED/);
    assert.equal(existsSync(path.join(logDir, "log.jsonl")), false);
  });
}

test("every defect is listed in one message — three rejections cost a review", () => {
  const result = run(["--converged", "--rounds", "2of3"], freshLogDir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rounds="2of3" is not a non-negative integer/);
  assert.match(result.stderr, /fixed is required/);
  assert.match(result.stderr, /open is required/);
});

test("a flag missing its value does not swallow the next flag", () => {
  const result = run(["--converged", "--rounds", "--fixed", "3"], freshLogDir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--rounds needs a value/);
});

test("an unknown flag is refused rather than ignored", () => {
  const result = run([...CONVERGED_ARGS, "--rounds-ish", "4"], freshLogDir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag: --rounds-ish/);
});

test("an unwritable log dir never holds the marker hostage", () => {
  const logDir = freshLogDir();
  chmodSync(logDir, 0o500);
  try {
    const result = run(CONVERGED_ARGS, logDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^SELF-REVIEW CONVERGED — outcome=converged/m);
    assert.equal(existsSync(path.join(logDir, "log.jsonl")), false);
  } finally {
    chmodSync(logDir, 0o700);
  }
});

test("a tier override reaches the log through the CLI, both halves of it", () => {
  // The flags round 1's blocker was about: a second, stale copy of the flag
  // list refused --forced outright, so the whole marker failed and the gate
  // stayed blocked on a finished review. The grammar's own tests cover the
  // field bag; only this covers the path converged.sh actually takes.
  const logDir = freshLogDir();
  const result = run([...CONVERGED_ARGS, "--tier", "S", "--forced", "S", "--computed", "M"], logDir);
  assert.equal(result.status, 0, `refused the override: ${result.stderr}`);
  assert.match(result.stdout, / tier=S forced=S computed=M intent=author$/m);
  const [record] = records(logDir);
  assert.equal(record.forced, "S");
  assert.equal(record.computed, "M");
});

test("half an override is refused in the same turn, not at the gate", () => {
  const result = run([...CONVERGED_ARGS, "--forced", "S"], freshLogDir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /forced and computed/);
});

test("a note that looks like a flag says so, instead of claiming no value was given", () => {
  // The guard is right — `--note --tier M` must not silently swallow the tier —
  // but the message was wrong: a value WAS given.
  const result = run([...CONVERGED_ARGS, "--note", "--dry-run was skipped"], freshLogDir());
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /--note needs a value/, "a value was given; the message must not deny it");
  assert.match(result.stderr, /looks like another flag/);
  assert.match(result.stderr, /CONVERGED\.json/, "the file form has no such constraint — say so");
});

test("--help anywhere in the arguments prints the usage and exits 0", () => {
  for (const args of [["--help"], ["-h"], [...CONVERGED_ARGS, "--help"], ["--work", "x", "-h"]]) {
    const logDir = freshLogDir();
    const result = run(args, logDir);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /^usage: converged\.sh --converged /m);
    assert.doesNotMatch(result.stdout, /SELF-REVIEW CONVERGED/, "help is not a marker");
    assert.equal(existsSync(path.join(logDir, "log.jsonl")), false, "and it logs nothing");
  }
});

test("--work writes the record to <work>/CONVERGED.json, with the review id round.sh would print", () => {
  const logDir = freshLogDir();
  const work = mkdtempSync(path.join(tmpdir(), "converged-work-"));
  const result = run([...CONVERGED_ARGS, "--work", work], logDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SELF-REVIEW CONVERGED — outcome=converged/m);
  const id = spawnSync("git", ["hash-object", "--stdin"], { input: realpathSync(work), encoding: "utf8" }).stdout.slice(0, 8);
  const record = JSON.parse(readFileSync(path.join(work, "CONVERGED.json"), "utf8"));
  assert.equal(record.outcome, "converged");
  assert.equal(record.review, id);
});

test("a --review that names another review than --work is refused for every outcome, and nothing is written", () => {
  for (const args of [CONVERGED_ARGS, ["--not-applicable", "scratch-only"]]) {
    const logDir = freshLogDir();
    const work = mkdtempSync(path.join(tmpdir(), "converged-work-"));
    const result = run([...args, "--work", work, "--review", "00000000"], logDir);
    assert.equal(result.status, 2, args[0]);
    assert.match(result.stderr, /--review 00000000 is not the review in --work/);
    assert.doesNotMatch(result.stdout, /SELF-REVIEW CONVERGED/);
    assert.equal(existsSync(path.join(work, "CONVERGED.json")), false);
  }
});

test("a --work the record cannot be written to prints no token", () => {
  const logDir = freshLogDir();
  const work = mkdtempSync(path.join(tmpdir(), "converged-work-"));
  // A directory where the record goes makes the rename fail for any user, root included.
  mkdirSync(path.join(work, "CONVERGED.json"));
  const result = run([...CONVERGED_ARGS, "--work", work], logDir);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SELF-REVIEW CONVERGED/);
  assert.match(result.stderr, /no marker was made/);
  assert.equal(existsSync(path.join(work, "CONVERGED.json.tmp")), false, "the half-written record is cleaned up");
});

test("--work writes the record for the other two outcomes too, and an escape hatch carries no review id", () => {
  for (const args of [["--not-converged", "--rounds", "2", "--fixed", "1", "--dismissed", "0", "--open", "1", "--intent", "author"], ["--not-applicable", "scratch-only"]]) {
    const work = mkdtempSync(path.join(tmpdir(), "converged-work-"));
    const result = run([...args, "--work", work], freshLogDir());
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(path.join(work, "CONVERGED.json"), "utf8"));
    assert.equal(record.outcome, args[0].slice(2));
    assert.equal("review" in record, args[0] !== "--not-applicable");
  }
});

test("a --work that is missing or names no directory is refused, and prints no token", () => {
  for (const tail of [["--work"], ["--work", path.join(tmpdir(), "no-such-review-dir-xyz")]]) {
    const result = run([...CONVERGED_ARGS, ...tail], freshLogDir());
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--work/);
    assert.doesNotMatch(result.stdout, /SELF-REVIEW CONVERGED/);
  }
});
