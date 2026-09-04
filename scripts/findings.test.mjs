// Run: node --test plugin/scripts/findings.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  convergence, findingsFile, main, normaliseRemote, priorCiteOf, priorId, priorLines, rankPrior, readRecords, recordFindings, recordProblem, repoId, reviewFromWork, toRecords,
} from "./findings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "findings.mjs");
const BRIEF = path.join(HERE, "brief.mjs");
// A user config that does not exist keeps loadConfig() on the shipped defaults.
process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "findings-test-no-such-config.json");

const workdir = () => mkdtempSync(path.join(tmpdir(), "findings-"));

function gitRepo({ origin } = {}) {
  const dir = workdir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

// A stored record, as `record` writes it: every field the schema needs, so a
// test can name the one it is corrupting instead of restating all nine.
const kept = (over = {}) => ({
  ts: "2026-08-23T00:00:00.000Z", review: "r", round: 1, angle: "A", class: "correctness",
  severity: "major", verdict: "fixed", file: "src/a.ts", line: 10, summary: "s", mechanism: "", proof: "", ...over,
});

const candidate = (over = {}) => ({
  verdict: "fixed", file: "src/a.ts", line: 10, severity: "major", class: "correctness",
  angle: "A", summary: "null deref on empty list", mechanism: "local defect", proof: "a.ts:10 quoted", ...over,
});

const stored = (dir, repoRoot) =>
  readFileSync(findingsFile(repoRoot, { logDir: dir }), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("remote URLs normalise so ssh, https and .git forms are one repository", () => {
  assert.equal(normaliseRemote("https://GitHub.com/Owner/Repo.git"), "github.com/Owner/Repo");
  assert.equal(normaliseRemote("git@github.com:Owner/Repo.git"), "github.com/Owner/Repo");
  assert.equal(normaliseRemote("ssh://git@GITHUB.com/Owner/Repo/"), "github.com/Owner/Repo");
  assert.equal(normaliseRemote("https://user:token@github.com/Owner/Repo"), "github.com/Owner/Repo");
  assert.equal(normaliseRemote("/srv/git/thing.git"), "/srv/git/thing", "a path remote keeps its case");
  // A colon after a scheme is a port; scp syntax is scheme-less by definition,
  // which is why git only accepts a port in the ssh:// form.
  assert.equal(normaliseRemote("ssh://git@example.com:2222/Owner/Repo.git"), "example.com/Owner/Repo");
  assert.equal(normaliseRemote("ssh://git@GitHub.com:22/Owner/Repo"), "github.com/Owner/Repo");
  assert.equal(normaliseRemote("git@example.com:2222/Owner/Repo.git"), "example.com/2222/Owner/Repo",
    "scp-style has no port to strip: `2222` there is a directory");
});

test("a self-hosted clone on a non-default ssh port is the same repository", () => {
  const ssh = gitRepo({ origin: "ssh://git@example.com:2222/Owner/Repo.git" });
  const https = gitRepo({ origin: "https://example.com/Owner/Repo.git" });
  assert.equal(repoId(ssh), repoId(https));
});

test("a repo id is the hashed origin, so clones share one memory file", () => {
  const a = gitRepo({ origin: "https://github.com/Owner/Repo.git" });
  const b = gitRepo({ origin: "git@github.com:Owner/Repo" });
  assert.match(repoId(a), /^[0-9a-f]{64}$/);
  assert.equal(repoId(a), repoId(b), "two clones of one project remember together");
  const c = gitRepo();
  assert.notEqual(repoId(c), repoId(a), "no remote falls back to the repo path");
  assert.equal(repoId(c), repoId(c), "and that fallback is stable");
});

test("records carry the whole §4.4 schema and append across rounds", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const at = (ts) => () => ts;
  recordFindings([candidate()], { review: "rev-1", round: 1, repoRoot: repo, logDir, now: at("2026-08-23T10:00:00.000Z") });
  recordFindings([candidate({ verdict: "dismissed", file: "src/b.ts", line: 4, severity: "minor", class: "pitfall", summary: "race" })],
    { review: "rev-1", round: 2, repoRoot: repo, logDir, now: at("2026-08-23T11:00:00.000Z") });
  const rows = stored(logDir, repo);
  assert.equal(rows.length, 2, "the second round appends, it does not replace");
  assert.deepEqual(rows[0], {
    ts: "2026-08-23T10:00:00.000Z", review: "rev-1", round: 1, angle: "A", class: "correctness",
    severity: "major", verdict: "fixed", file: "src/a.ts", line: 10, prior_id: null,
    summary: "null deref on empty list", mechanism: "local defect", proof: "a.ts:10 quoted",
  });
  assert.equal(rows[1].round, 2);
  assert.equal(rows[1].verdict, "dismissed");
});

test("a finding may cite the prior line it is re-raising, and only in the right shape", () => {
  const logDir = workdir(), repo = gitRepo();
  const cite = priorId({ file: "src/a.ts", line: 10, class: "correctness", summary: "null deref on empty list" });
  recordFindings([candidate({ prior_id: cite })], { review: "r", round: 1, repoRoot: repo, logDir });
  assert.equal(stored(logDir, repo)[0].prior_id, cite, "the finder's own answer, carried to the eval");
  // A malformed cite is a typo, and a typo that scored as a citation is the one
  // failure mode this field adds.
  assert.throws(() => recordFindings([candidate({ prior_id: "p3" })], { review: "r", round: 1, repoRoot: repo, logDir }),
    /prior_id/, "an index-shaped id is not an id");
  // `prior.md` shows `[83de6191]`, and three files tell the finder to copy that
  // line's id: a finder that copies what it sees is following instructions, and
  // the whole batch used to be discarded for it — including the findings that
  // cite nothing, since the batch is validated before any of it is written.
  recordFindings([candidate({ prior_id: `[${cite}]` }), candidate({ summary: "cites nothing" })],
    { review: "r2", round: 1, repoRoot: repo, logDir });
  const written = stored(logDir, repo).filter((row) => row.review === "r2");
  assert.deepEqual(written.map((row) => row.prior_id), [cite, null], "brackets are stripped, never stored");
  assert.equal(priorCiteOf("nope"), false, "and anything else is still an error, not a silent drop");
});

test("a prior line gives up its summary before its verdict", () => {
  // `clean` truncates from the end and the verdict is last, so the `[id] `
  // prefix pushed the field §4.4 scores on off the end of the 200-char cap. A
  // line ending `· dismiss…` still reads plausibly, which is how it would go
  // unnoticed.
  const row = { file: `src/${"deep/".repeat(12)}handlers.ts`, line: 4210, class: "correctness",
    summary: "x".repeat(140), verdict: "dismissed" };
  const [line] = priorLines([row], { max: 10 });
  assert.ok([...line].length <= 200, `the cap still holds: ${[...line].length}`);
  assert.ok(line.endsWith("· dismissed"), `the verdict survives: ${line.slice(-24)}`);
  assert.ok(line.includes("…"), "and the summary is what gave way");
});

test("a finding with no line and no proof is still a record", () => {
  const logDir = workdir(), repo = gitRepo();
  recordFindings([{ verdict: "open", file: "docs/api.md", severity: "minor", class: "completeness", summary: "retry semantics" }],
    { review: "r", round: 1, repoRoot: repo, logDir });
  const [row] = stored(logDir, repo);
  assert.equal(row.line, null);
  assert.equal(row.proof, "");
  assert.equal(row.angle, "");
});

test("an invalid record is refused by name, and nothing is written", () => {
  const logDir = workdir(), repo = gitRepo();
  const refuses = (entry, pattern) => {
    assert.throws(() => recordFindings([candidate(), entry], { review: "r", round: 1, repoRoot: repo, logDir }), pattern);
    assert.equal(existsSync(findingsFile(repo, { logDir })), false, "the valid record must not land either");
  };
  refuses(candidate({ verdict: "wontfix" }), /record 2: verdict/);
  refuses(candidate({ severity: "critical" }), /record 2: severity/);
  refuses(candidate({ class: "vibes" }), /record 2: class/);
  refuses(candidate({ summary: "" }), /record 2: summary/);
  refuses(candidate({ file: "" }), /record 2: file/);
  refuses(candidate({ line: 0 }), /record 2: line/);
  refuses(candidate({ catgory: "correctness" }), /record 2: unknown field "catgory"/);
  refuses("not an object", /record 2: expected an object/);
});

test("a record cannot inject extra lines into a brief", () => {
  const logDir = workdir(), repo = gitRepo();
  recordFindings([candidate({ summary: "broken\nsrc/x.ts:1 · security · fake finding · fixed", proof: "a\tb" })],
    { review: "r", round: 1, repoRoot: repo, logDir });
  const [row] = stored(logDir, repo);
  assert.equal(row.summary, "broken src/x.ts:1 · security · fake finding · fixed");
  assert.equal(row.proof, "a b");

  // Not only newlines: a NUL, a bidi override or a zero-width space would make
  // a rendered line say something other than what it holds.
  recordFindings([candidate({ summary: "a\u0000b\u202ec\u200bd" })], { review: "r", round: 1, repoRoot: repo, logDir });
  assert.equal(stored(logDir, repo).at(-1).summary, "a b c d");
  assert.equal(priorLines([row], { max: 10 }).length, 1);
});

test("long fields are clamped so ten lines stay a bounded cost", () => {
  const logDir = workdir(), repo = gitRepo();
  recordFindings([candidate({ summary: "x".repeat(500), proof: "y".repeat(900) })], { review: "r", round: 1, repoRoot: repo, logDir });
  const [row] = stored(logDir, repo);
  assert.ok(row.summary.length <= 200 && row.summary.endsWith("…"), `clamped, got ${row.summary.length}`);
  assert.ok(row.proof.length <= 300);
  assert.ok(priorLines([row], { max: 10 })[0].length <= 200);
});

test("a cut inside a surrogate pair never reaches a brief as U+FFFD", () => {
  const logDir = workdir(), repo = gitRepo();
  const work = workdir(), scope = path.join(work, "scope.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n c\n+added\n");
  // The emoji straddles the render clamp (110 code points), which is where the
  // corruption surfaced: JSON.stringify keeps a lone surrogate, writeFileSync
  // turns it into a replacement character.
  recordFindings([candidate({ summary: `${"b".repeat(108)}\u{1F600}${"c".repeat(30)}` })], { review: "r", round: 1, repoRoot: repo, logDir });
  main(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--repo", repo], { log: () => {} });
  const text = readFileSync(out, "utf8");
  assert.equal(text.includes("\uFFFD"), false, `a replacement character reached the brief: ${text}`);
  assert.ok(text.includes("…"), "and it is still clamped");
  assert.equal(stored(logDir, repo).at(-1).summary.includes("\uFFFD"), false);
});

test("prior classifies changed files with the same exempt lists as tier and impact", () => {
  const rows = [
    { file: "deploy/values.yaml", line: 1, class: "config", summary: "config finding", verdict: "fixed" },
    { file: "src/x.ts", line: 2, class: "correctness", summary: "code finding", verdict: "fixed" },
  ];
  const exempt = { extensions: [".json", ".yaml"], names: [] };
  // package.json is "config" to tier.mjs and impact.mjs on a stock install, so
  // a past config finding is what a change to it should recall.
  assert.deepEqual(rankPrior(rows, ["package.json"], { max: 10, exempt }).map((r) => r.summary), ["config finding"]);
  assert.deepEqual(rankPrior(rows, ["package.json"], { max: 10 }).map((r) => r.summary), ["code finding"],
    "without the lists it would read package.json as code — the divergence this argument closes");
});

test("prior ranks same file over same directory over same class, ties by recency", () => {
  const rows = [
    { file: "lib/y.ts", line: 1, class: "correctness", summary: "old same-class", verdict: "fixed", review: "old" },
    { file: "src/a/other.ts", line: 2, class: "pitfall", summary: "same dir", verdict: "fixed", review: "old" },
    { file: "lib/x.ts", line: 3, class: "correctness", summary: "newer same-class", verdict: "open", review: "old" },
    { file: "src/a/b.ts", line: 4, class: "security", summary: "the file itself", verdict: "dismissed", review: "old" },
    { file: "assets/logo.png", line: 5, class: "reader-fit", summary: "unrelated", verdict: "fixed", review: "old" },
  ];
  const ranked = rankPrior(rows, ["src/a/b.ts"], { max: 10 });
  assert.deepEqual(ranked.map((r) => r.summary), ["the file itself", "same dir", "newer same-class", "old same-class"]);
  assert.equal(ranked.length, 4, "a finding related to nothing that changed is not context, it is noise");
  assert.deepEqual(rankPrior(rows, ["src/a/b.ts"], { max: 2 }).map((r) => r.summary), ["the file itself", "same dir"]);
});

test("prior hides the review that is running, so a finder is never told what was just fixed", () => {
  const rows = [
    { file: "src/a.ts", line: 1, class: "correctness", summary: "from an old review", verdict: "fixed", review: "old" },
    { file: "src/a.ts", line: 2, class: "correctness", summary: "round 1 of this one", verdict: "fixed", review: "now" },
  ];
  assert.deepEqual(rankPrior(rows, ["src/a.ts"], { max: 10, exclude: "now" }).map((r) => r.summary), ["from an old review"]);
});

test("an id that needed cleaning still excludes its own review", () => {
  const logDir = workdir(), repo = gitRepo();
  const work = workdir(), scope = path.join(work, "scope.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n c\n+added\n");
  // The operator pasted the whole scratchpad path instead of the UUID: record
  // stores the cleaned form, so a raw comparison in prior matched nothing and
  // handed the running review its own findings.
  const messy = `  /private/tmp/claude-501/${"x".repeat(140)}/self-review\t`;
  const cli = (extra) => main(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--repo", repo, ...extra], { log: () => {} });
  recordFindings([candidate()], { review: messy, round: 1, repoRoot: repo, logDir });
  cli([]);
  assert.match(readFileSync(out, "utf8"), /null deref/, "no --review: everything is prior");
  cli(["--review", messy]);
  assert.equal(readFileSync(out, "utf8").trim(), "", "the same id, cleaned on both sides, excludes the running review");
});

test("the same finding recorded twice shows once, with its latest verdict", () => {
  const rows = [
    { file: "src/a.ts", line: 7, class: "correctness", summary: "null deref", verdict: "open", review: "r1" },
    { file: "src/a.ts", line: 7, class: "correctness", summary: "null deref", verdict: "fixed", review: "r2" },
  ];
  const ranked = rankPrior(rows, ["src/a.ts"], { max: 10 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].verdict, "fixed");
});

test("a prior line leads with the id a finder cites it by", () => {
  const one = { file: "src/a.ts", line: 7, class: "correctness", summary: "null deref", verdict: "fixed" };
  assert.deepEqual(priorLines([one], { max: 10 }), [`[${priorId(one)}] src/a.ts:7 · correctness · null deref · fixed`]);
  const noLine = { file: "docs/a.md", line: null, class: "accuracy", summary: "stale path", verdict: "open" };
  assert.deepEqual(priorLines([noLine], { max: 10 }), [`[${priorId(noLine)}] docs/a.md · accuracy · stale path · open`]);
  assert.match(priorId(one), /^[0-9a-f]{8}$/);
});

test("a prior id names the finding, not its place in the list", () => {
  // `rankPrior` orders by score then recency, so an index would name a
  // different finding from one round to the next; and the same finding recorded
  // twice — open, then fixed — is one line in prior.md and must keep one id.
  const row = { file: "src/a.ts", line: 7, class: "correctness", summary: "null deref", verdict: "open" };
  assert.equal(priorId({ ...row, verdict: "fixed", round: 4, angle: "S" }), priorId(row));
  assert.notEqual(priorId({ ...row, line: 8 }), priorId(row));
  assert.notEqual(priorId({ ...row, summary: "null deref in the loader" }), priorId(row));
});

test("readRecords: a line that will not parse is skipped, one that parses but is off-schema is malformed", () => {
  const dir = workdir();
  const file = path.join(dir, "f.jsonl");
  const row = (over) => JSON.stringify(kept(over));
  writeFileSync(file, [row({ summary: "one" }), "not json", "", "[1,2]", row({ summary: "two", verdict: "Fixed" }), row({ summary: "three" })].join("\n") + "\n");
  const { records, skipped, malformed } = readRecords(file);
  assert.deepEqual(records.map((r) => r.summary), ["one", "three"]);
  assert.equal(skipped, 2, "the unparseable line and the array — neither is a record at all");
  assert.equal(malformed, 1, "`Fixed` parses fine and is still not a verdict this schema has");
  assert.deepEqual(readRecords(path.join(dir, "missing.jsonl")), { records: [], skipped: 0, malformed: 0 });

  const big = path.join(dir, "big.jsonl");
  const filler = `${row({ file: "old.ts", summary: "x".repeat(180) })}\n`;
  for (let i = 0; i < 4000; i += 1) appendFileSync(big, filler);
  appendFileSync(big, `${row({ file: "new.ts", summary: "newest" })}\n`);
  const tail = readRecords(big, { maxBytes: 64 * 1024 });
  assert.ok(tail.records.length > 0 && tail.records.length < 4000, `bounded, got ${tail.records.length}`);
  assert.equal(tail.records.at(-1).summary, "newest", "the newest records are the ones that survive the bound");
  assert.equal(tail.skipped, 0, "the partial first line is dropped, not counted as corruption");
  assert.equal(tail.malformed, 0);
});

test("recordProblem names the field, and one gate answers for every reader", () => {
  assert.equal(recordProblem(kept()), null);
  assert.equal(recordProblem(kept({ angle: "" })), null, "a run that named no angle wrote an empty one — present, not corrupt");
  assert.equal(recordProblem(kept({ line: null })), null);
  const named = (over) => recordProblem(kept(over));
  assert.match(named({ round: "2" }), /round/);
  assert.match(named({ round: 0 }), /round/);
  assert.match(named({ verdict: "Fixed" }), /verdict/);
  assert.match(named({ verdict: "resolved" }), /verdict/);
  assert.match(named({ severity: "catastrophic" }), /severity/);
  assert.match(named({ class: "vibes" }), /class/);
  assert.match(named({ review: "" }), /review/);
  assert.match(named({ file: "" }), /file/);
  assert.match(named({ summary: "" }), /summary/);
  assert.match(named({ line: 0 }), /line/);
});

test("CLI: record reads stdin, prior writes a file brief.mjs can consume", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });

  const rec = run(["record", "--review", "rev-9", "--round", "1", "--log-dir", logDir],
    JSON.stringify([candidate({ file: "src/pay.ts", summary: "double charge on retry" }), candidate({ verdict: "open", file: "src/pay.ts", line: 20, summary: "cap unclear" })]));
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /2 findings/);
  assert.equal(stored(logDir, repo).length, 2);

  const work = workdir();
  const scope = path.join(work, "scope.diff");
  writeFileSync(scope, "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
  const out = path.join(work, "prior.md");
  const prior = run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir]);
  assert.equal(prior.status, 0, prior.stderr);
  const text = readFileSync(out, "utf8");
  assert.match(text, /src\/pay\.ts:10 · correctness · double charge on retry · fixed/);
  assert.equal(text.split("\n").filter(Boolean).length, 2);

  const excluded = run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--review", "rev-9"]);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.equal(readFileSync(out, "utf8").trim(), "", "the running review is excluded, and the file still exists");

  writeFileSync(path.join(work, "intent.md"), "INTENT\nUser asked: \"pay\"\n");
  run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir]);
  const brief = spawnSync(process.execPath, [BRIEF, "--tier", "S", "--intent", path.join(work, "intent.md"),
    "--scope", scope, "--prior", out, "--out", path.join(work, "briefs")], { encoding: "utf8", cwd: repo });
  assert.equal(brief.status, 0, brief.stderr);
  const briefText = readFileSync(path.join(work, "briefs", "self-review-finder-r1-compact.md"), "utf8");
  assert.match(briefText, /PRIOR FINDINGS IN THIS REPO/);
  assert.match(briefText, /double charge on retry/);
});

test("CLI: a missing subcommand, a bad flag and unreadable input are usage errors, not crashes", () => {
  const logDir = workdir();
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });
  assert.equal(run([]).status, 2);
  assert.match(run([]).stderr, /record|prior/);
  assert.equal(run(["sing"]).status, 2);
  assert.equal(run(["record", "--log-dir", logDir], "[]").status, 2, "--work or --review is required");
  assert.equal(run(["prior", "--log-dir", logDir]).status, 2, "--scope is required");
  assert.equal(run(["prior", "--scope", "/no/such/scope.diff", "--log-dir", logDir]).status, 3);
  assert.equal(run(["record", "--review", "r", "--log-dir", logDir], "{oops").status, 3);
  assert.match(run(["record", "--review", "r", "--log-dir", logDir], "{oops").stderr, /findings.mjs:/);
});

test("CLI: --round is validated, defaults to 1, and the error names what was typed", () => {
  const logDir = workdir(), repo = gitRepo();
  const run = (args, input = "[]") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const record = JSON.stringify([candidate()]);
  for (const round of ["abc", "0", "-1", "1.5"]) {
    const bad = run(["record", "--review", "r", "--round", round, "--log-dir", logDir], record);
    assert.equal(bad.status, 2, `--round ${round}`);
    assert.match(bad.stderr, new RegExp(`not "${round}"`), "the message quotes the value the user typed");
  }
  assert.equal(existsSync(findingsFile(repo, { logDir })), false, "a rejected round writes nothing");
  assert.equal(run(["record", "--review", "r", "--log-dir", logDir], record).status, 0);
  assert.equal(stored(logDir, repo)[0].round, 1, "an omitted --round is round 1");
});

test("prior reads the config even when --max is passed — the path the skill uses", () => {
  const logDir = workdir(), repo = gitRepo();
  const work = workdir(), scope = path.join(work, "scope.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n c\n+added\n");
  recordFindings([candidate({ file: "deploy/values.yaml", line: 3, class: "config", summary: "a config finding" })],
    { review: "r", round: 1, repoRoot: repo, logDir });
  main(["prior", "--scope", scope, "--out", out, "--max", "5", "--log-dir", logDir, "--repo", repo], { log: () => {} });
  assert.match(readFileSync(out, "utf8"), /a config finding/,
    "a lazily-evaluated config load is skipped by --max, and the exempt lists with it");
});

test("record accepts JSONL as well as a JSON array — the state files are JSONL", () => {
  const logDir = workdir(), repo = gitRepo();
  const jsonl = `${JSON.stringify(candidate())}\n${JSON.stringify(candidate({ verdict: "open", summary: "second" }))}\n`;
  const written = recordFindings(toRecords(jsonl), { review: "r", round: 3, repoRoot: repo, logDir });
  assert.equal(written.count, 2);
  assert.equal(stored(logDir, repo).length, 2);
});

test("main() returns what it wrote, so the loop's one call is one line of output", () => {
  const logDir = workdir(), repo = gitRepo();
  const lines = [];
  const result = main(["record", "--review", "r", "--round", "1", "--log-dir", logDir, "--repo", repo, "--in", "-"],
    { log: (l) => lines.push(l), stdin: JSON.stringify([candidate()]) });
  assert.equal(result.count, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 finding .*fixed/);
});

test("the review identity comes from the work dir, and two sessions are not one review", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  // Every session's work dir ends in the same two components. Only the full
  // path tells two reviews apart, so a tail-only id would exclude everyone's
  // records from everyone's briefs.
  const sessionA = path.join(workdir(), "scratchpad", "self-review");
  const sessionB = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(sessionA, { recursive: true });
  mkdirSync(sessionB, { recursive: true });
  assert.notEqual(reviewFromWork(sessionA), reviewFromWork(sessionB), "same tail, different review");
  assert.equal(reviewFromWork(sessionA), reviewFromWork(`${sessionA}${path.sep}`), "one dir is one id, however it is spelled");

  assert.equal(run(["record", "--work", sessionA, "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);
  const scope = path.join(sessionA, "scope.diff");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
  const out = path.join(sessionA, "prior.md");
  run(["prior", "--scope", scope, "--out", out, "--work", sessionA, "--log-dir", logDir]);
  assert.equal(readFileSync(out, "utf8").trim(), "", "its own round is excluded with no id retyped anywhere");
  run(["prior", "--scope", scope, "--out", out, "--work", sessionB, "--log-dir", logDir]);
  assert.match(readFileSync(out, "utf8"), /null deref/, "another session's review is prior work");

  const both = run(["record", "--work", sessionA, "--review", "r", "--log-dir", logDir], "[]");
  assert.equal(both.status, 2, "two spellings of one identity is a usage error");
  assert.match(both.stderr, /not both/);
});

test("convergence: W is computed from the records, over the angles two rounds share", () => {
  const rec = (round, angle, severity, verdict = "fixed") =>
    ({ round, angle, severity, verdict, review: "r", file: "a.ts", line: 1, class: "correctness", summary: "s" });
  // The case that broke the prose rule on this repo: angle S enters at round 3
  // and files blockers by construction, so unrestricted W rose 4 -> 9.
  const rounds = [
    rec(2, "compact", "major"), rec(2, "compact", "minor"),
    rec(3, "compact", "minor"), rec(3, "S", "blocker"), rec(3, "S", "blocker"),
  ];
  const at2 = convergence(rounds, 2), at3 = convergence(rounds, 3);
  assert.equal(at2.w, 3, "3 = one major + one minor");
  assert.equal(at3.w, 7, "the round's own W counts every angle it ran");
  assert.deepEqual(at3.shared, ["compact"], "S ran in round 3 only");
  assert.deepEqual([at3.previousShared, at3.currentShared], [3, 1], "compared over compact alone");
  assert.equal(at3.verdict, "CONTINUE");
  assert.match(at3.reason, /1 < 3/);

  const plateau = [rec(2, "compact", "major"), rec(3, "compact", "major")];
  assert.equal(convergence(plateau, 3).verdict, "ESCALATE", "a plateau over the shared angle stops the loop");
  assert.equal(convergence(plateau, 2).verdict, "CONTINUE", "the first change-round has no predecessor");
  assert.equal(convergence([rec(3, "S", "blocker"), rec(2, "compact", "minor")], 3).verdict, "CONTINUE",
    "no shared angle means nothing to compare, not a stall");
  assert.equal(convergence([rec(2, "compact", "blocker", "dismissed"), rec(3, "compact", "minor")], 3).previousShared, 0,
    "W scores what a round fixed; a dismissal cost no fix");
});

test("CLI: converge reads this review's own records and names the rule it did not check", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(work, { recursive: true });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const fill = (round, entries) => run(["record", "--work", work, "--round", String(round), "--log-dir", logDir], JSON.stringify(entries));
  assert.equal(fill(1, [candidate({ severity: "blocker", angle: "A" }), candidate({ severity: "major", angle: "A" })]).status, 0);
  assert.equal(fill(2, [candidate({ severity: "minor", angle: "A" })]).status, 0);

  const out = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /CONTINUE/);
  assert.match(out.stdout, /round cap|oscillation/, "it says which parts of §3 it does not decide");
  // Another review's records must not move this review's arithmetic.
  const other = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(other, { recursive: true });
  // Enough weight on the same round and angle to flip the verdict if it counted.
  run(["record", "--work", other, "--round", "2", "--log-dir", logDir],
    JSON.stringify([candidate({ severity: "blocker", angle: "A" }), candidate({ severity: "blocker", angle: "A" })]));
  const after = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.match(after.stdout, /CONTINUE/, "another review sharing this repo's memory file does not move this review's W");
  assert.match(after.stdout, /round 2  W=1/, "and does not inflate the round's own score");
});

// The call site, not the pure function. `auditEngagement("")` was already
// covered in engagement.test.mjs and already returned `opened: false` — but
// converge gated the whole audit behind `engagement ? … : null`, so the line
// for the case SKILL.md §3 names could not be reached from the only caller
// that has one. A unit test on the function passes either way; that is the
// gap this closes.
test("CLI: converge says the guard proved nothing when no engagement log was opened", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(work, { recursive: true });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  assert.equal(run(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);

  const silent = run(["converge", "--work", work, "--round", "1", "--log-dir", logDir]);
  assert.equal(silent.status, 0, silent.stderr);
  assert.match(silent.stdout, /no engagement log was opened for this round/,
    "an absent log is the absence, not a pass — and converge is the only place that says so");

  // And with one open, the same call site reports what the round proved,
  // which is what makes the assertion above about the branch and not the CLI.
  assert.equal(run(["engagement", "--work", work, "--round", "1", "--log-dir", logDir]).status, 0);
  const opened = run(["converge", "--work", work, "--round", "1", "--log-dir", logDir]);
  assert.doesNotMatch(opened.stdout, /no engagement log was opened/);
  assert.match(opened.stdout, /# tree-guard/, "an open log still gets a line of its own");
});

test("CLI: converge logs its decision, so a granted round leaves a trace", () => {
  // `earned` is the one rule that grants a round past the budget, and it was
  // only ever printed: afterwards, a review that ran round budget+1 looked
  // exactly like one that overran.
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(work, { recursive: true });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const fill = (round, entries) => run(["record", "--work", work, "--round", String(round), "--log-dir", logDir], JSON.stringify(entries));
  fill(1, [candidate({ severity: "blocker", angle: "A" }), candidate({ severity: "major", angle: "A" })]);
  fill(2, [candidate({ severity: "blocker", angle: "A" })]);
  assert.equal(run(["converge", "--work", work, "--round", "2", "--budget", "2", "--log-dir", logDir]).status, 0);
  // The decision on the granted round itself: granted-and-ran, not granted-and-abandoned.
  fill(3, [candidate({ severity: "minor", angle: "A" })]);
  assert.equal(run(["converge", "--work", work, "--round", "3", "--budget", "2", "--log-dir", logDir]).status, 0);

  const rows = readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2, "one row per decision");
  assert.deepEqual(rows.map((r) => [r.round, r.earned, r.tail, r.verdict]),
    [[2, true, "blocker", "CONTINUE"], [3, false, "minor", "STOP"]]);
  // The kind is what keeps these out of the audit's marker fallback, which
  // reads the same file and would otherwise adopt one as a review's marker.
  assert.ok(rows.every((r) => r.kind === "converge" && !("summary" in r)));
  assert.ok(rows.every((r) => r.review === reviewFromWork(work) && r.ts && r.w >= 0));
});

test("convergence: an unvetted record is refused by name, not silently weighed", () => {
  const good = (round, severity) => kept({ round, severity });
  assert.equal(convergence([good(1, "blocker"), good(2, "minor")], 2).currentShared, 1);
  // The hole angle S found in round 8: `Fixed` passed every check this loop had
  // and was scored as not-fixed, so a genuinely fixed blocker left W with
  // nothing said. Weighing an unknown severity is the same class of silence —
  // it yields NaN. Both are now one question, asked once, at the entrance.
  for (const bad of [{ round: "2" }, { round: 0 }, { verdict: "Fixed" }, { severity: "catastrophic" }]) {
    assert.throws(() => convergence([good(1, "blocker"), kept(bad)], 2), /vetted/, JSON.stringify(bad));
  }
});

test("convergence: the round budget can stop the loop, never bless it", () => {
  const rec = (round, severity, verdict = "fixed") => kept({ round, angle: "A", severity, verdict });
  const at = (round, ...severities) => severities.map((severity) => rec(round, severity));
  // Two blockers fixed, then one: W drops, so only the budget can stop it.
  const closing = [...at(1, "blocker", "blocker"), ...at(2, "blocker")];

  assert.equal(convergence(closing, 2, { budget: 6 }).verdict, "CONTINUE", "inside the budget the W rule is the only rule");

  // A round that closed only minors leaves nothing a cap must not leave unread.
  const minorTail = [...at(1, "minor", "minor"), ...at(2, "minor")];
  const spent = convergence(minorTail, 2, { budget: 2 });
  assert.equal(spent.verdict, "STOP");
  assert.equal(spent.tail, "minor");
  assert.match(spent.reason, /budget of 2 is spent/, spent.reason);
  assert.ok(!/\bclean\b|converged|\bdone\b/i.test(spent.reason), "a spent budget is a cost bound, not a finding of health");

  // A blocker or a major closed on the last affordable round buys exactly one
  // more — that fix is the kind a cap must not leave unread — and only one.
  const earned = convergence(closing, 2, { budget: 2 });
  assert.equal(earned.verdict, "CONTINUE");
  assert.deepEqual([earned.earned, earned.tail], [true, "blocker"]);
  assert.equal(convergence([...closing, ...at(3, "minor")], 3, { budget: 2 }).verdict, "STOP",
    "the extension is single-shot: the round it bought cannot buy another");
  assert.equal(convergence([...at(1, "blocker", "blocker"), ...at(2, "major")], 2, { budget: 2 }).earned, true);

  // Dismissals and open items buy nothing: nothing changed, so nothing ships
  // unreviewed.
  for (const verdict of ["dismissed", "open"]) {
    const bought = convergence([...at(1, "minor", "minor"), ...at(2, "minor"), rec(2, "blocker", verdict)], 2, { budget: 2 });
    assert.equal(bought.verdict, "STOP", verdict);
    assert.equal(bought.tail, "minor", verdict);
  }

  // A stall outranks a spent budget: it is the part the reader must decide on.
  assert.equal(convergence([...at(1, "minor"), ...at(2, "minor")], 2, { budget: 2 }).verdict, "ESCALATE");
  // With no budget given, nothing stops the loop but the W rule.
  const unbounded = convergence(closing, 2);
  assert.deepEqual([unbounded.verdict, unbounded.budget], ["CONTINUE", null]);
});

test("convergence: a taper that merges angles still compares like with like", () => {
  const rec = (round, angle, severity) => kept({ round, angle, severity });
  // SKILL §2a tapers by merging angle groups and never dropping one, so round
  // 1's `B` and `C` are round 2's `B+C`. Compared as strings those rounds share
  // no angle, every later round answers "nothing comparable", and W — the only
  // rule that can stop the loop on evidence — never runs.
  const merged = [rec(1, "B", "blocker"), rec(1, "C", "major"), rec(2, "B+C", "major")];
  const at2 = convergence(merged, 2);
  assert.deepEqual(at2.angles, ["B", "C"], "a merged finder ran both of the angles it covered");
  assert.deepEqual(at2.shared, ["B", "C"]);
  assert.equal(at2.previousShared, 5, "round 1's blocker and major, both inside the shared set");
  assert.equal(at2.currentShared, 2);
  assert.equal(at2.verdict, "CONTINUE", "2 < 5 — the comparison the string form could never make");

  // Merging is not a discount: a plateau still has to show as one.
  assert.equal(convergence([rec(1, "B", "major"), rec(1, "C", "minor"), rec(2, "B+C", "blocker")], 2).verdict, "ESCALATE");

  // Weight only joins the comparison when every angle it covered is shared —
  // otherwise a round is credited for coverage the other round never had.
  const partial = [rec(1, "B", "major"), rec(2, "B+Z", "blocker"), rec(2, "B", "minor")];
  const at2p = convergence(partial, 2);
  assert.deepEqual(at2p.shared, ["B"]);
  assert.equal(at2p.currentShared, 1, "the B+Z blocker is outside the shared coverage; the B minor is inside");
  assert.equal(at2p.verdict, "CONTINUE");
  assert.equal(at2p.w, 4, "the round's own W still counts everything it fixed");

  // A record that named no angle covered no angle, so it is not part of any
  // shared-angle comparison. "Every angle it covered is shared" is vacuously
  // true of nothing, which let an untagged blocker count at full weight and
  // stop a loop that was closing.
  const untagged = [rec(1, "B", "blocker"), rec(2, "B", "minor"), rec(2, "", "blocker")];
  const at2u = convergence(untagged, 2);
  assert.deepEqual(at2u.angles, ["B"], "an empty angle adds nothing to the set either");
  assert.equal(at2u.currentShared, 1, "the untagged blocker is outside the comparison, not inside it at weight 3");
  assert.equal(at2u.verdict, "CONTINUE", "1 < 3");
  assert.equal(at2u.w, 4, "and it still counts toward the round's own W — it was fixed");
});

test("CLI: converge says on stderr when the memory file holds rows it cannot use", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = path.join(workdir(), "scratchpad", "self-review");
  mkdirSync(work, { recursive: true });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  run(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()]));
  const file = findingsFile(repo, { logDir });
  const line = JSON.parse(readFileSync(file, "utf8").split("\n").filter(Boolean)[0]);
  appendFileSync(file, `${JSON.stringify({ ...line, round: "1" })}\n`);
  const out = run(["converge", "--work", work, "--round", "1", "--log-dir", logDir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /1 record did not match the record schema/);
  assert.match(out.stdout, /round 1  W=2/, "and the number it prints is the one it could score");
});


// --- F3: every problem in one pass ------------------------------------------
// D3, 2026-08-30: `record` rejected one payload three times, one field per
// turn, at ~200k of context each. The loop that calls this can fix its JSON
// and call again — but only if it is told everything that is wrong, and the
// schema, the first time.
const problems = (entries, over = {}) => {
  const logDir = workdir(), repo = gitRepo();
  try {
    recordFindings(entries, { review: "r", round: 1, repoRoot: repo, logDir, ...over });
    return null;
  } catch (error) {
    assert.equal(existsSync(findingsFile(repo, { logDir })), false, "atomicity: nothing is written when anything is wrong");
    return error.message;
  }
};

test("F3: three problems in two records are reported once, with the schema", () => {
  const message = problems([
    candidate({ title: "not a field", severity: "high" }),
    candidate({ class: "maintainability" }),
  ]);
  assert.match(message, /^3 problems in 2 records — nothing recorded$/m);
  assert.match(message, /^ {2}record 1: unknown field "title" — did you mean summary\?$/m);
  assert.match(message, /^ {2}record 1: severity — one of blocker, major, minor, got "high" — did you mean major\?$/m);
  assert.match(message, /^ {2}record 2: class — one of the class vocabulary in the schema line below, got "maintainability" — did you mean reuse\?$/m);
  assert.match(message, /^schema: verdict fixed\|dismissed\|open · severity blocker\|major\|minor · class /m);
  assert.match(message, /· file · line · summary · mechanism · proof · angle · prior_id$/m);
});

test("F3: one problem still reads as one, and every field is checked in the same pass", () => {
  assert.match(problems([candidate({ verdict: "wontfix" })]), /^1 problem in 1 record — nothing recorded$/m);

  // Every check in toRecord, all reported together: the old version stopped at
  // the first, so a payload with five mistakes cost five turns.
  const all = problems([candidate({
    verdict: "wontfix", severity: "critical", class: "vibes", summary: "", file: "", line: 0, prior_id: "p3", extra: 1,
  })]);
  for (const field of ["verdict", "severity", "class", "summary", "file", "line", "prior_id"]) {
    assert.match(all, new RegExp(`^ {2}record 1: ${field} —`, "m"), field);
  }
  assert.match(all, /^ {2}record 1: unknown field "extra"/m);
  assert.match(all, /^8 problems in 1 record/m);
});

test("F3: a hint is offered where one is unambiguous, and never accepted as input", () => {
  assert.match(problems([candidate({ severity: "high" })]), /did you mean major\?/);
  assert.match(problems([candidate({ class: "maintainability" })]), /did you mean reuse\?/);
  assert.match(problems([candidate({ sumary: "typo" })]), /did you mean summary\?/);
  // `medium` has no unambiguous target on a blocker/major/minor scale, so it
  // gets the vocabulary and no guess.
  const medium = problems([candidate({ severity: "medium" })]);
  assert.match(medium, /severity — one of blocker, major, minor, got "medium"/);
  assert.doesNotMatch(medium, /did you mean/);
  // And the hint is only ever a message: the vocabulary is what the per-repo
  // memory file is keyed on, and an alias accepted once is a second spelling
  // in that memory forever.
  assert.ok(problems([candidate({ severity: "high" })]), "high is still refused");
});

test("F3: a non-object entry is one problem, not a crash on the rest of them", () => {
  const message = problems(["not an object", candidate({ severity: "high" }), 42]);
  assert.match(message, /^ {2}record 1: expected an object, got "not an object"$/m);
  assert.match(message, /^ {2}record 2: severity —/m);
  assert.match(message, /^ {2}record 3: expected an object, got 42$/m);
});
