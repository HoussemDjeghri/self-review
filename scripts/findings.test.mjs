// Run: node --test plugin/scripts/findings.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  convergence, findingsFile, main, nextAction, normaliseRemote, priorCiteOf, priorId, priorLines, rankPrior, readRecords, recordFindings, recordProblem, repoId, reviewFromWork, toRecords,
} from "./findings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "findings.mjs");
const BRIEF = path.join(HERE, "brief.mjs");
// A user config that does not exist keeps loadConfig() on the shipped defaults.
process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "findings-test-no-such-config.json");
// Spawned findings.mjs and brief.mjs append to the log dir; the suite must not
// write into the developer's own memory.
process.env.SELF_REVIEW_LOG_DIR = mkdtempSync(path.join(tmpdir(), "sr-log-"));

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

// A review dir as round.sh leaves it: round 1's scope names the repository the
// review keys its memory on, and a round `record` writes into has a plan.
const planned = (work, round) => {
  const plan = path.join(work, `round-${round}`, "tier.json");
  mkdirSync(path.dirname(plan), { recursive: true });
  if (!existsSync(plan)) writeFileSync(plan, "{}\n");
};
const scoped = (work, repo, rounds = [1]) => {
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  writeFileSync(path.join(work, "round-1", "scope.diff"), `# self-review scope\n# repo: ${repo}\n`);
  for (const round of rounds) planned(work, round);
  return work;
};

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
  const work = scoped(workdir(), repo), scope = path.join(work, "scope.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n c\n+added\n");
  // The emoji straddles the render clamp (110 code points), which is where the
  // corruption surfaced: JSON.stringify keeps a lone surrogate, writeFileSync
  // turns it into a replacement character.
  recordFindings([candidate({ summary: `${"b".repeat(108)}\u{1F600}${"c".repeat(30)}` })], { review: "r", round: 1, repoRoot: repo, logDir });
  main(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--work", work], { log: () => {} });
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

  const mine = scoped(workdir(), repo), other = scoped(workdir(), repo);
  const rec = run(["record", "--work", mine, "--round", "1", "--log-dir", logDir],
    JSON.stringify([candidate({ file: "src/pay.ts", summary: "double charge on retry" }), candidate({ verdict: "open", file: "src/pay.ts", line: 20, summary: "cap unclear" })]));
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /2 findings/);
  assert.equal(stored(logDir, repo).length, 2);

  const work = workdir();
  const scope = path.join(work, "scope.diff");
  writeFileSync(scope, "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
  const out = path.join(work, "prior.md");
  const prior = run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--work", other]);
  assert.equal(prior.status, 0, prior.stderr);
  const text = readFileSync(out, "utf8");
  assert.match(text, /src\/pay\.ts:10 · correctness · double charge on retry · fixed/);
  assert.equal(text.split("\n").filter(Boolean).length, 2);

  const excluded = run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--work", mine]);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.equal(readFileSync(out, "utf8").trim(), "", "the running review is excluded, and the file still exists");

  writeFileSync(path.join(work, "intent.md"), "INTENT\nUser asked: \"pay\"\n");
  run(["prior", "--scope", scope, "--out", out, "--log-dir", logDir, "--work", other]);
  const brief = spawnSync(process.execPath, [BRIEF, "--tier", "S", "--intent", path.join(work, "intent.md"),
    "--scope", scope, "--prior", out, "--out", path.join(work, "briefs")], { encoding: "utf8", cwd: repo });
  assert.equal(brief.status, 0, brief.stderr);
  const briefText = readFileSync(path.join(work, "briefs", "self-review-finder-r1-compact.md"), "utf8");
  assert.match(briefText, /PRIOR FINDINGS IN THIS REPO/);
  assert.match(briefText, /double charge on retry/);
});

test("CLI: a missing subcommand, a bad flag and unreadable input are usage errors, not crashes", () => {
  const logDir = workdir(), work = scoped(workdir(), gitRepo());
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });
  assert.equal(run([]).status, 2);
  assert.match(run([]).stderr, /record|prior/);
  assert.equal(run(["sing"]).status, 2);
  assert.match(run(["record", "--log-dir", logDir], "[]").stderr, /pass --work <this review's work dir>/, "--work is required");
  assert.equal(run(["prior", "--work", work, "--log-dir", logDir]).status, 2, "--scope is required");
  assert.equal(run(["prior", "--scope", "/no/such/scope.diff", "--work", work, "--log-dir", logDir]).status, 3);
  assert.equal(run(["record", "--work", work, "--log-dir", logDir], "{oops").status, 3);
  assert.match(run(["record", "--work", work, "--log-dir", logDir], "{oops").stderr, /findings.mjs:/);
});

test("CLI: --round is validated, defaults to 1, and the error names what was typed", () => {
  const logDir = workdir(), repo = gitRepo(), work = scoped(workdir(), repo);
  const run = (args, input = "[]") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const record = JSON.stringify([candidate()]);
  for (const round of ["abc", "0", "-1", "1.5"]) {
    const bad = run(["record", "--work", work, "--round", round, "--log-dir", logDir], record);
    assert.equal(bad.status, 2, `--round ${round}`);
    assert.match(bad.stderr, new RegExp(`not "${round}"`), "the message quotes the value the user typed");
  }
  assert.equal(existsSync(findingsFile(repo, { logDir })), false, "a rejected round writes nothing");
  assert.equal(run(["record", "--work", work, "--log-dir", logDir], record).status, 0);
  assert.equal(stored(logDir, repo)[0].round, 1, "an omitted --round is round 1");
});

test("prior reads the config even when --max is passed — the path the skill uses", () => {
  const logDir = workdir(), repo = gitRepo();
  const work = scoped(workdir(), repo), scope = path.join(work, "scope.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n c\n+added\n");
  recordFindings([candidate({ file: "deploy/values.yaml", line: 3, class: "config", summary: "a config finding" })],
    { review: "r", round: 1, repoRoot: repo, logDir });
  main(["prior", "--scope", scope, "--out", out, "--max", "5", "--log-dir", logDir, "--work", work], { log: () => {} });
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

test("main() returns what it wrote, and the loop's one call says it first, then the verdict and next:", () => {
  const logDir = workdir(), work = scoped(workdir(), gitRepo());
  const lines = [];
  const result = main(["record", "--work", work, "--round", "1", "--log-dir", logDir, "--in", "-"],
    { log: (l) => lines.push(l), stdin: JSON.stringify([candidate()]) });
  assert.equal(result.count, 1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /1 finding .*fixed/);
  assert.match(lines[1], /^CONTINUE — /);
  assert.match(lines[2], /^next: /);
});

test("the review identity comes from the work dir, and two sessions are not one review", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  // Every session's work dir ends in the same two components. Only the full
  // path tells two reviews apart, so a tail-only id would exclude everyone's
  // records from everyone's briefs.
  const sessionA = path.join(workdir(), "scratchpad", "self-review");
  const sessionB = path.join(workdir(), "scratchpad", "self-review");
  scoped(sessionA, repo);
  scoped(sessionB, repo);
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
  assert.equal(both.status, 2, "there is no second spelling of the identity");
  assert.match(both.stderr, /unknown argument --review/);
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
  const work = scoped(path.join(workdir(), "scratchpad", "self-review"), repo, [1, 2]);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const fill = (round, entries) => run(["record", "--work", work, "--round", String(round), "--log-dir", logDir], JSON.stringify(entries));
  assert.equal(fill(1, [candidate({ severity: "blocker", angle: "A" }), candidate({ severity: "major", angle: "A" })]).status, 0);
  assert.equal(fill(2, [candidate({ severity: "minor", angle: "A" })]).status, 0);

  const out = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /CONTINUE/);
  assert.match(out.stdout, /round cap|oscillation/, "it says which parts of §3 it does not decide");
  // Another review's records must not move this review's arithmetic.
  const other = scoped(path.join(workdir(), "scratchpad", "self-review"), repo, [2]);
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
  const work = scoped(path.join(workdir(), "scratchpad", "self-review"), repo);
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

// D1 (docs/design-notes/questions/review-identity-answer.md). A session's
// reviews used to share one work dir, so the third review of a session opened
// at "round 7": converge compared it against another review's last round, found
// its budget spent at every round, and said STOP from its first look. Each
// review now gets `<base>/review-<k>/`, and the identity is that directory.
const reviewDirs = (repo, rounds = [1]) => {
  const base = path.join(workdir(), "scratchpad", "self-review");
  const [one, two] = ["review-1", "review-2"].map((name) => path.join(base, name));
  for (const dir of [one, two]) scoped(dir, repo, rounds);
  return { one, two };
};

test("D1: a second review in the same session starts at its own round 1, with its budget unspent", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const { one, two } = reviewDirs(repo, [1, 2, 3, 4, 5]);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  for (let round = 1; round <= 5; round += 1) {
    run(["record", "--work", one, "--round", String(round), "--log-dir", logDir], JSON.stringify([candidate({ severity: "minor" })]));
  }
  run(["record", "--work", two, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate({ severity: "major" })]));
  writeFileSync(path.join(two, "round-1", "tier.json"), JSON.stringify({ tier: "S", round: 1, roundsCap: 2 }));

  const out = run(["converge", "--work", two, "--round", "1", "--log-dir", logDir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^CONTINUE — round 1 is the first change-round/m, "review 1's five rounds are not review 2's predecessors");
  assert.doesNotMatch(out.stdout, /budget of \d+ is spent/, "and review 2 has spent none of its own budget");
});

test("D1: prior for review 2 carries review 1's records; each review hides only its own", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const { one, two } = reviewDirs(repo);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  assert.notEqual(reviewFromWork(one), reviewFromWork(two), "sibling review dirs are two reviews");
  run(["record", "--work", one, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()]));
  const scope = path.join(two, "scope.diff");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
  const out = path.join(two, "prior.md");

  run(["prior", "--scope", scope, "--out", out, "--work", two, "--log-dir", logDir]);
  assert.match(readFileSync(out, "utf8"), /null deref/, "an earlier review of the session is prior work to the next");
  run(["prior", "--scope", scope, "--out", out, "--work", one, "--log-dir", logDir]);
  assert.equal(readFileSync(out, "utf8").trim(), "", "and still hidden from the review that recorded it");
});

test("CLI: converge takes the round cap from tier.json, so forgetting a flag cannot disable it", () => {
  // The cap already existed — tier.mjs computes it and writes `roundsCap` into
  // the round's plan. Requiring it to be retyped as `--budget` meant that
  // forgetting the flag silently answered on W alone and reported nothing about
  // a spent budget, which is the only bound on cost the loop has.
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = scoped(path.join(workdir(), "scratchpad", "self-review"), repo, [1, 2]);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const fill = (round, entries) => run(["record", "--work", work, "--round", String(round), "--log-dir", logDir], JSON.stringify(entries));
  fill(1, [candidate({ severity: "blocker", angle: "A" }), candidate({ severity: "major", angle: "A" })]);
  fill(2, [candidate({ severity: "minor", angle: "A" })]);

  const blind = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.match(blind.stdout, /none found: W only/, "no plan for the round means the cap is genuinely unknown, and it says so");

  writeFileSync(path.join(work, "round-2", "tier.json"), JSON.stringify({ tier: "M", round: 2, roundsCap: 2 }));
  const read = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.match(read.stdout, /round 2's tier\.json/, "the cap is read from the plan the round already wrote");
  assert.match(read.stdout, /STOP|ESCALATE/, "and it is actually applied, not merely printed");

  const given = run(["converge", "--work", work, "--round", "2", "--budget", "6", "--log-dir", logDir]);
  assert.match(given.stdout, /budget \(given\)/, "an explicit --budget still wins, so forcing a cap stays possible");
});

test("CLI: converge logs its decision, so a granted round leaves a trace", () => {
  // `earned` is the one rule that grants a round past the budget, and it was
  // only ever printed: afterwards, a review that ran round budget+1 looked
  // exactly like one that overran.
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = scoped(path.join(workdir(), "scratchpad", "self-review"), repo, [1, 2, 3]);
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
  const work = scoped(path.join(workdir(), "scratchpad", "self-review"), repo);
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
  assert.match(message, /^schema: verdict fixed\|dismissed\|open\|unfixed · severity blocker\|major\|minor · class /m);
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

// The class vocabulary lives in three places that are edited separately: this
// map, the finder's output block, and the cold grader's. It drifted once — the
// grader's `cold-run` was never added here, so `record` refused every angle-X
// finding with "class is not one the finders use" and the round's own ledger
// disagreed with the repository's. Deriving the vocabulary from the shipped
// agent files is what makes the next added class fail here instead of there.
test("every class the shipped reviewers can emit is one `record` accepts", () => {
  const agentDir = path.join(HERE, "..", "agents");
  const emitted = new Set();
  for (const file of ["self-review-finder.md", "self-review-cold-grader.md"]) {
    const text = readFileSync(path.join(agentDir, file), "utf8");
    const line = text.split("\n").find((l) => l.includes('"category":'));
    assert.ok(line, `${file}: no "category" line — the output block moved, and this test is now blind`);
    for (const value of line.replace(/.*"category":\s*"/, "").replace(/",?\s*$/, "").split("|")) {
      emitted.add(value.trim());
    }
  }
  assert.ok(emitted.size >= 20, `only ${emitted.size} classes parsed — the parse is wrong, not the vocabulary`);
  for (const cls of emitted) {
    assert.equal(recordProblem({ round: 1, verdict: "fixed", severity: "major", class: cls, angle: "X", summary: "s", review: "r", file: "a.mjs" }), null,
      `class "${cls}" is emitted by a shipped reviewer and refused by record`);
  }
});

// Severity had no such test, and it drifted further than class ever did.
// Measured across 76 field candidates from three days of use: `blocker`,
// `blocking`, `major`, `high`, `moderate`, `medium`, `minor` and `low` — eight
// spellings of three ranks, four synonym pairs, none of them collapsed by
// anything. The ledger refuses the synonyms, which means the lead retypes each
// one by hand and picks the rank itself; the whole point of the reviewer being
// a fresh reader is lost at the moment the author re-grades its severity.
// Same derivation as the class test above, for the same reason: the vocabulary
// is stated in the shipped agent files, so a rank added there fails HERE.
test("every severity the shipped reviewers can emit is one `record` accepts", () => {
  const agentDir = path.join(HERE, "..", "agents");
  const emitted = new Set();
  for (const file of ["self-review-finder.md", "self-review-cold-grader.md"]) {
    const text = readFileSync(path.join(agentDir, file), "utf8");
    const line = text.split("\n").find((l) => l.includes('"severity":'));
    assert.ok(line, `${file}: no "severity" line — the output block moved, and this test is now blind`);
    for (const value of line.replace(/.*"severity":\s*"/, "").replace(/",?\s*$/, "").split("|")) {
      emitted.add(value.trim());
    }
  }
  assert.equal(emitted.size, 3, `expected the three ranks, parsed ${[...emitted].join(", ")}`);
  for (const severity of emitted) {
    assert.equal(recordProblem({ round: 1, verdict: "fixed", severity, class: "correctness", angle: "X", summary: "s", review: "r", file: "a.mjs" }), null,
      `severity "${severity}" is emitted by a shipped reviewer and refused by record`);
  }
});

test("a dismissal without a quoted counter-proof is refused at the ledger", () => {
  const logDir = workdir(), repo = gitRepo();
  const dismissal = (over = {}) => candidate({ verdict: "dismissed", ...over });
  // Measured 2026-09-07 over 8 loops: 76 candidates, 3 verifiers. SKILL.md §2d
  // has said "a dismissal without a quoted counter-proof is not a dismissal"
  // since the loop shipped, and nothing checked it — so the field the whole
  // rule rests on could be absent.
  assert.throws(() => recordFindings([dismissal({ proof: "" })], { review: "r", round: 1, repoRoot: repo, logDir }),
    /proof — a dismissal needs the counter-proof quoted/);
  assert.throws(() => recordFindings([dismissal({ proof: "   \t " })], { review: "r", round: 1, repoRoot: repo, logDir }),
    /proof — a dismissal needs the counter-proof quoted/, "whitespace is not a proof");
  // The other two verdicts are untouched: an `open` finding has nothing to
  // quote yet, and a `fixed` one is proved by the diff.
  recordFindings([candidate({ verdict: "open", proof: "" }), candidate({ verdict: "fixed", proof: "" })],
    { review: "r", round: 1, repoRoot: repo, logDir });
  recordFindings([dismissal({ proof: "line 46 already guards it" })], { review: "r", round: 2, repoRoot: repo, logDir });
  assert.deepEqual(stored(logDir, repo).map((row) => [row.verdict, row.proof]),
    [["open", ""], ["fixed", ""], ["dismissed", "line 46 already guards it"]]);
});

test("`recordProblem` does NOT apply the dismissal-proof rule to stored rows", () => {
  // Write-time only. Rows written before 2026-09-07 carry no proof, and
  // failing them here would make `convergence`, `rankPrior` and `priorLines`
  // drop them — the loop forgetting what it once found, which is the thing the
  // rule exists to prevent.
  assert.equal(recordProblem(kept({ verdict: "dismissed", proof: "" })), null);
});

// --- the interface, discoverable without failing (field report 2026-10-14 B9) --
// `--help` answered "pass a command" 45 times in 18 sessions, and each refusal
// was followed by three to six calls grepping this file for the schema.
const cli = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: gitRepo() });

test("--help prints the usage and the whole record vocabulary, and exits 0", () => {
  for (const args of [["--help"], ["-h"], ["help"], ["record", "--help"], ["record", "--work", "/x", "-h"]]) {
    const out = cli(args);
    assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}`);
    assert.match(out.stdout, /findings\.mjs record --work <dir> /, args.join(" "));
    for (const word of ["fixed", "dismissed", "open", "blocker", "major", "minor", "correctness", "cold-run", "pre-existing"]) {
      assert.match(out.stdout, new RegExp(`\\b${word}\\b`), `${args.join(" ")}: ${word}`);
    }
    assert.match(out.stdout, /^ {2}angle\b.*\bcompact\b.*\+/m, "angle is free text, so its shape is described with examples");
  }
  for (const command of ["prior", "converge", "engagement"]) {
    const out = cli([command, "--help"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`findings\\.mjs ${command} `));
  }
});

test("--help advertises neither --review nor --repo, which main() rejects as unknown", () => {
  for (const args of [["--help"], ["converge", "--help"], ["record", "--help"], ["prior", "--help"], ["engagement", "--help"]]) {
    const out = cli(args);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /--review|--repo/, args.join(" "));
  }
});

test("an unknown flag names the flags the command does take", () => {
  const out = cli(["record", "--rounds", "2"], "[]");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown argument --rounds — record takes --work, --round, --in, --log-dir/);
});

test("a candidate exactly as SKILL.md §2c/§2e tells the lead to write it is accepted", () => {
  // §2c gives every candidate an id (`r1-1`…); `record` refused the field, six
  // times in the field. It is the lead's handle for one round's merge and
  // verify, not part of what a later review should remember — accepted, not
  // stored.
  const skill = readFileSync(path.join(HERE, "..", "skills", "self-review", "SKILL.md"), "utf8");
  const example = /findings\.mjs" record [^\n]*<<'JSON'\n([\s\S]*?)\nJSON/.exec(skill);
  assert.ok(example, "SKILL.md's record example moved, and this test is now blind");
  const [entry] = JSON.parse(example[1]);
  const logDir = workdir(), repo = gitRepo();
  recordFindings([{ id: "r1-1", ...entry }], { review: "r", round: 1, repoRoot: repo, logDir });
  const [row] = stored(logDir, repo);
  assert.equal(row.summary, entry.summary);
  assert.equal(Object.hasOwn(row, "id"), false, "the id is a handle for this round, not memory");
});

test("hints cover the invented words the field actually used", () => {
  assert.match(problems([candidate({ severity: "nit" })]), /got "nit" — did you mean minor\?/);
  assert.match(problems([candidate({ class: "test-coverage" })]), /got "test-coverage" — did you mean verification\?/);
});

// --- converge on the rounds the W rule has nothing to say about (B11) --------
test("convergence: a round that fixed nothing is clean, whatever the angles", () => {
  const rec = (round, angle, severity, verdict = "fixed") => kept({ round, angle, severity, verdict, proof: "p" });
  // Round 3 found nothing at all: it used to answer CONTINUE "nothing comparable"
  // because an empty round shares no angle with anything.
  const empty = convergence([rec(2, "A+B", "major")], 3);
  assert.equal(empty.verdict, "CLEAN", empty.reason);
  assert.match(empty.reason, /round 3 fixed nothing/);
  // Everything dismissed or left open is clean too (SKILL §3: open and
  // dismissed items do not count) — and it used to ESCALATE on "0 did not drop
  // below 0".
  const quiet = convergence([rec(1, "A", "minor", "dismissed"), rec(2, "A", "major", "dismissed"), rec(2, "A", "minor", "open")], 2);
  assert.equal(quiet.verdict, "CLEAN", quiet.reason);
  assert.match(quiet.reason, /1 open/, "the open item is named, because the report must carry it");
  // A clean round on the last affordable round is still clean: nothing it did
  // ships unreviewed.
  assert.equal(convergence([rec(1, "A", "major"), rec(2, "A", "minor", "dismissed")], 2, { budget: 2 }).verdict, "CLEAN");
  assert.equal(convergence([], 1).verdict, "CLEAN", "a first round that found nothing");
});

test("convergence: an unrecorded round is not a clean one", () => {
  const unrecorded = convergence([kept({ round: 1 })], 2, { recorded: false });
  assert.equal(unrecorded.verdict, "UNRECORDED", unrecorded.reason);
  assert.match(unrecorded.reason, /record step/);
  assert.equal(convergence([kept({ round: 1 }), kept({ round: 2, verdict: "open" })], 2, { recorded: false }).verdict, "CLEAN",
    "a round that has records was recorded, receipt or not");
});

test("convergence: W with nothing on the shared angles in either round is vacuous, not a stall", () => {
  const rec = (round, angle, severity, verdict = "fixed") => kept({ round, angle, severity, verdict, proof: "p" });
  // Both rounds ran A; round 1 only dismissed there, round 2 fixed on S alone.
  const vacuous = convergence([rec(1, "A", "major", "dismissed"), rec(2, "A", "minor", "dismissed"), rec(2, "S", "blocker")], 2);
  assert.equal(vacuous.verdict, "CONTINUE", vacuous.reason);
  assert.match(vacuous.reason, /neither a stall nor a pass/);
  assert.match(vacuous.reason, /run round 3/);
  assert.equal(convergence([rec(1, "A", "minor"), rec(2, "A", "minor")], 2).verdict, "ESCALATE", "a real plateau still escalates");
  // The no-shared-angle case says what to do next, too.
  const apart = convergence([rec(2, "A+B", "major"), rec(3, "compact", "minor"), rec(3, "S", "blocker")], 3);
  assert.equal(apart.verdict, "CONTINUE");
  assert.match(apart.reason, /no angle ran in both round 2 and round 3.*run round 4/);
});

test("CLI: record leaves a receipt, so converge tells a clean round from an unrecorded one", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = scoped(path.join(workdir(), "scratchpad", "self-review", "review-1"), repo, [1, 2]);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  assert.equal(run(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);

  // Round 2's record failed (or never ran): no verdict may be printed as if W
  // had been weighed, and the line says exactly what to run.
  assert.equal(run(["record", "--work", work, "--round", "2", "--log-dir", logDir], JSON.stringify([{ id: "r2-1", class: "docs" }])).status, 3);
  const missing = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^round 2 {2}W=0 {2}angles: none$/m);
  assert.match(missing.stdout, /^UNRECORDED — /m);
  // The script path is shell-quoted when it holds a space; compare the call unquoted.
  assert.ok(missing.stdout.replaceAll("'", "").includes(`findings.mjs record --work ${work} --round 2 --in <findings.json>`), missing.stdout);
  assert.doesNotMatch(missing.stdout, /^(CONTINUE|ESCALATE|STOP|CLEAN) — /m);

  // An empty batch is the record of a round that found nothing.
  const none = run(["record", "--work", work, "--round", "2", "--log-dir", logDir], "[]");
  assert.equal(none.status, 0, none.stderr);
  assert.ok(existsSync(path.join(work, "round-2", "recorded.json")));
  const clean = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.match(clean.stdout, /^CLEAN — round 2 fixed nothing/m, clean.stdout);
  // And without --round, the newest round is the one just recorded — empty or not.
  assert.match(run(["converge", "--work", work, "--log-dir", logDir]).stdout, /^CLEAN — round 2 /m);
});

// --- R3: the verdict names the exact next call -------------------------------
// The verdict used to reach the lead at the top of the NEXT round, so the final
// round's was never computed: 104 converged reviews ended on CONTINUE. Each
// branch prints the one call that acts on it, counts filled in.

const COUNTS = { rounds: 2, fixed: 3, dismissed: 1, open: 2 };
const SCRIPTS = "/plug/scripts";
const verdictOf = (verdict, over = {}) => ({ round: 2, verdict, earned: false, tail: "minor", ...over });
const nextFor = (verdict, over = {}) => nextAction(verdictOf(verdict, over), COUNTS, { work: "/w/review-1", tier: "M", scripts: SCRIPTS });

test("nextAction: a clean round prints the converged marker, counts and tier filled in", () => {
  assert.equal(nextFor("CLEAN", { tail: null }),
    "next: /plug/scripts/converged.sh --converged --rounds 2 --fixed 3 --dismissed 1 --open 2 --tier M --intent <validated|author|skipped>");
});

test("nextAction: a clean round on the last affordable round converges — it does not read as STOP", () => {
  const records = [kept({ round: 1, severity: "major" }), kept({ round: 2, verdict: "dismissed", proof: "p" })];
  const result = convergence(records, 2, { budget: 2 });
  const next = nextAction(result, COUNTS, { work: "/w/review-1", tier: "S", scripts: SCRIPTS });
  assert.match(next, /^next: (?:'[^']*converged\.sh'|\S*converged\.sh) --converged /);
  assert.doesNotMatch(`${result.reason}\n${next}`, /unreviewed|STOP/);
});

test("nextAction: an earned extension prints the one round it buys, forced to S and audited", () => {
  assert.equal(nextFor("CONTINUE", { earned: true, tail: "major" }),
    'next: /plug/scripts/round.sh --work /w/review-1 --round 3 --intent /w/review-1/intent.md --force S --reason "extension round: round 2 fixed a major"');
  assert.match(nextFor("ESCALATE", { earned: true, tail: "blocker" }), /--force S --reason "extension round: round 2 fixed a blocker"/,
    "an earned round outranks the stall");
});

test("nextAction: STOP prints not-converged with the counts, and says that is the honest end", () => {
  const next = nextFor("STOP").split("\n");
  assert.equal(next[0],
    "next: /plug/scripts/converged.sh --not-converged --rounds 2 --fixed 3 --dismissed 1 --open 2 --tier M --intent <validated|author|skipped>");
  assert.match(next.slice(1).join("\n"), /^ {2}round 2's fixes ship unreviewed: list them in the report\. This is the correct end of a capped review; a new review to turn it into converged is not\.$/);
});

test("nextAction: ESCALATE prints not-converged and the round to run if the user says continue", () => {
  const next = nextFor("ESCALATE");
  assert.match(next, /^next: \/plug\/scripts\/converged\.sh --not-converged --rounds 2 /);
  assert.match(next, /\n {2}put the stall to the user; if they say continue, run \/plug\/scripts\/round\.sh --work \/w\/review-1 --round 3 --intent \/w\/review-1\/intent\.md as usual\.$/);
});

test("nextAction: CONTINUE prints the next round", () => {
  assert.equal(nextFor("CONTINUE"), "next: /plug/scripts/round.sh --work /w/review-1 --round 3 --intent /w/review-1/intent.md");
});

test("nextAction: UNRECORDED prints the record call, and a path with a space is quoted so it runs as printed", () => {
  const next = nextAction(verdictOf("UNRECORDED"), COUNTS, { work: "/w/cold run/review-1", tier: null, scripts: SCRIPTS });
  assert.match(next, /^next: \/plug\/scripts\/findings\.mjs record --work '\/w\/cold run\/review-1' --round 2 --in <findings\.json>\n/);
  assert.match(nextFor("CLEAN"), /--tier M /);
  assert.match(nextAction(verdictOf("CLEAN"), COUNTS, { work: null, tier: null, scripts: SCRIPTS }), /--tier <S\|M\|L> /,
    "an unknown tier is a placeholder, never a guess");
  assert.match(nextAction(verdictOf("CONTINUE"), COUNTS, { work: null, tier: null, scripts: SCRIPTS }), /--work <work> --round 3 --intent <work>\/intent\.md$/,
    "an unknown work dir is a placeholder");
});

/** A review dir with a round-N plan, recorded through the CLI. */
const reviewCli = (cap) => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = scoped(path.join(workdir(), "scratchpad", "self-review", "review-1"), repo);
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd: repo });
  const plan = (round, tier) => {
    mkdirSync(path.join(work, `round-${round}`), { recursive: true });
    writeFileSync(path.join(work, `round-${round}`, "tier.json"), JSON.stringify({ tier, round, roundsCap: cap }));
  };
  const record = (round, entries) => run(["record", "--work", work, "--round", String(round), "--log-dir", logDir], JSON.stringify(entries));
  return { logDir, work, run, plan, record };
};

test("CLI: record --work prints the verdict on the round it just recorded, and the next call", () => {
  const { work, plan, record } = reviewCli(2);
  plan(1, "M");
  const first = record(1, [candidate({ severity: "major" }), candidate({ severity: "minor", verdict: "dismissed" })]);
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split("\n");
  assert.match(lines[0], /^# 2 findings recorded/);
  assert.match(lines[1], /^CONTINUE — round 1 is the first change-round/);
  assert.ok(lines[2].replaceAll("'", "").endsWith(`round.sh --work ${work} --round 2 --intent ${work}/intent.md`), lines[2]);
  assert.match(lines[2], /^next: /);

  plan(2, "M");
  const capped = record(2, [candidate({ severity: "minor" })]);
  assert.match(capped.stdout, /^STOP — round budget of 2 is spent/m, capped.stdout);
  assert.match(capped.stdout.replaceAll("'", ""), /converged\.sh --not-converged --rounds 2 --fixed 2 --dismissed 1 --open 0 --tier M /,
    "the counts are this review's, summed across its rounds");
  assert.equal(existsSync(path.join(work, "round-2", "recorded.json")), true);
});

test("CLI: the marker's tier is round 1's, not an extension round's forced S", () => {
  const { plan, record, work } = reviewCli(3);
  for (const round of [1, 2, 3]) { plan(round, "M"); assert.equal(record(round, round === 3 ? [candidate({ severity: "major" })] : []).status, 0); }
  mkdirSync(path.join(work, "round-4"), { recursive: true });
  writeFileSync(path.join(work, "round-4", "tier.json"), JSON.stringify({ tier: "S", forced: "S", round: 4, roundsCap: 4 }));
  const done = record(4, []);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout.replaceAll("'", ""), /converged\.sh --converged .*--tier M /, done.stdout);
});

test("CLI: converge prints the next call just before the tree-guard line", () => {
  const { work, run, plan, record, logDir } = reviewCli(6);
  plan(1, "L");
  record(1, [candidate({ severity: "major" })]);
  planned(work, 2);
  record(2, []);
  const out = run(["converge", "--work", work, "--round", "2", "--log-dir", logDir]);
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  const next = lines.findIndex((line) => line.startsWith("next: "));
  assert.ok(next > 0, out.stdout);
  assert.match(lines[next].replaceAll("'", ""), /converged\.sh --converged --rounds 2 --fixed 1 --dismissed 0 --open 0 --tier L /,
    "the review's tier is round 1's plan, whatever round 2 holds");
  assert.equal(next, lines.length - 2, "the tree-guard line is last");
});

test("convergence: no STOP reason calls a round that fixed nothing unreviewed", () => {
  for (const budget of [1, 2, 3]) {
    const result = convergence([kept({ round: 1, severity: "major" }), kept({ round: 2, verdict: "open" })], 2, { budget });
    assert.doesNotMatch(result.reason, /unreviewed/, `budget ${budget}: ${result.reason}`);
  }
});

// --- `unfixed`: a CONFIRMED defect left standing is not a convergence --------
// (docs/design-notes/questions/unfixed-answer.md). A round whose applier came
// back `blocked` fixed nothing, so it read CLEAN and printed `--converged`
// over a known defect.
const unfixedRow = (over = {}) => kept({ verdict: "unfixed", summary: "confirmed, not fixed", ...over });

test("unfixed: record accepts it, tally prints it, and the applier's word is hinted to it", () => {
  const logDir = workdir(), work = scoped(workdir(), gitRepo());
  const lines = [];
  main(["record", "--work", work, "--round", "1", "--log-dir", logDir, "--in", "-"],
    { log: (l) => lines.push(l), stdin: JSON.stringify([candidate({ verdict: "unfixed" })]) });
  assert.match(lines[0], /1 finding recorded \(1 unfixed\)/);
  assert.match(problems([candidate({ verdict: "blocked" })]), /got "blocked" — did you mean unfixed\?/);
  assert.equal(recordProblem(unfixedRow()), null, "a stored unfixed row is a row every reader can use");
});

test("unfixed: a round that fixed nothing and left one unfixed escalates, never CLEAN", () => {
  const row = unfixedRow({ round: 1 });
  const result = convergence([row], 1);
  assert.equal(result.verdict, "ESCALATE", result.reason);
  assert.equal(result.reason, `1 CONFIRMED finding(s) left unfixed: [${priorId(row)}]`);
  const next = nextAction(result, COUNTS, { work: "/w/review-1", tier: "M", scripts: SCRIPTS });
  assert.match(next, /^next: \/plug\/scripts\/converged\.sh --not-converged /);
  assert.match(next, new RegExp(`\\n {2}round 1 leaves 1 CONFIRMED finding\\(s\\) unfixed \\[${priorId(row)}\\]: put each to the user`));
  assert.match(next, /record --work \/w\/review-1 --round 1 with prior_id <id> on the fixed row, and run \/plug\/scripts\/round\.sh --work \/w\/review-1 --round 2 /);
  assert.match(next, /\n {2}A defect they accept as-is is not a convergence: the marker above is the end\.$/);
});

test("unfixed: it outranks a W CONTINUE and an earned extension", () => {
  const fixed = (round, severity) => kept({ round, angle: "A", severity });
  const closing = [fixed(1, "blocker"), fixed(2, "minor"), unfixedRow({ round: 2, angle: "A" })];
  assert.equal(convergence(closing.slice(0, 2), 2).verdict, "CONTINUE", "without it, W drops");
  assert.equal(convergence(closing, 2).verdict, "ESCALATE");
  const earning = [fixed(1, "blocker"), fixed(1, "blocker"), fixed(2, "blocker"), unfixedRow({ round: 2, angle: "A" })];
  assert.equal(convergence(earning.slice(0, 3), 2, { budget: 2 }).earned, true, "without it, the round earns one more");
  const result = convergence(earning, 2, { budget: 2 });
  assert.deepEqual([result.verdict, result.earned], ["ESCALATE", false]);
  assert.doesNotMatch(nextAction(result, COUNTS, { work: "/w/review-1", scripts: SCRIPTS }), /--force S/);
});

test("unfixed: a spent budget with one left unfixed is a STOP that names it", () => {
  const fixed = (round) => kept({ round, angle: "A", severity: "minor" });
  const row = unfixedRow({ round: 2 });
  const result = convergence([fixed(1), fixed(1), fixed(2), row], 2, { budget: 2 });
  assert.equal(result.verdict, "STOP", result.reason);
  assert.match(result.reason, /1 CONFIRMED finding\(s\) left unfixed/);
  const next = nextAction(result, COUNTS, { work: "/w/review-1", tier: "M", scripts: SCRIPTS });
  assert.match(next, /^next: \/plug\/scripts\/converged\.sh --not-converged /);
  assert.match(next, new RegExp(`\\n {2}round 2 leaves 1 CONFIRMED finding\\(s\\) unfixed \\[${priorId(row)}\\]: list them in the report\\.$`));
});

test("unfixed: it carries forward — a later round recorded empty still escalates", () => {
  assert.equal(convergence([unfixedRow({ round: 1 })], 2).verdict, "ESCALATE",
    "round 2's finders not refiling a defect the ledger lists is not round 2 being clean");
});

test("unfixed: a later row citing it resolves it; a citation on the wrong id does not", () => {
  const row = unfixedRow({ round: 1 });
  const fix = kept({ round: 1, verdict: "fixed", summary: "the fix the user ruled on", prior_id: priorId(row) });
  assert.equal(convergence([row, fix], 1).verdict, "CONTINUE", "round 1 now fixed something, so round 2 reviews it");
  const clean = convergence([row, fix], 2);
  assert.equal(clean.verdict, "CLEAN", clean.reason);
  assert.match(nextAction(clean, COUNTS, { work: "/w/review-1", scripts: SCRIPTS }), /converged\.sh --converged /);
  const wrong = kept({ round: 1, verdict: "fixed", summary: "a fix of something else", prior_id: priorId(row) === "deadbeef" ? "cafef00d" : "deadbeef" });
  assert.equal(convergence([row, wrong], 2).verdict, "ESCALATE");
  assert.equal(convergence([fix, row], 2).verdict, "ESCALATE", "a citation must come after the row it cites");
});

test("unfixed: an open-only round is still CLEAN, so PLAUSIBLE/design behaves as before", () => {
  const result = convergence([kept({ round: 1, verdict: "open" })], 1);
  assert.equal(result.verdict, "CLEAN", result.reason);
  assert.match(nextAction(result, COUNTS, { work: "/w/review-1", scripts: SCRIPTS }), /converged\.sh --converged /);
});

test("unfixed: UNRECORDED still outranks it", () => {
  assert.equal(convergence([unfixedRow({ round: 1 })], 2, { recorded: false }).verdict, "UNRECORDED");
});

test("unfixed: the marker's --open excludes it, no count is NaN, and the converge row carries it", () => {
  const logDir = workdir(), work = scoped(workdir(), gitRepo());
  const lines = [];
  const entries = [candidate({ verdict: "unfixed", summary: "left" }), candidate({ verdict: "open", summary: "asked" })];
  main(["record", "--work", work, "--round", "1", "--log-dir", logDir, "--in", "-"], { log: () => {}, stdin: JSON.stringify(entries) });
  main(["converge", "--work", work, "--round", "1", "--log-dir", logDir], { log: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.match(out, /^ESCALATE — 1 CONFIRMED finding\(s\) left unfixed/m, out);
  assert.match(out, /--fixed 0 --dismissed 0 --open 1 /, out);
  assert.doesNotMatch(out, /NaN/);
  const [row] = readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(row.unfixed.length, 1);
  assert.match(row.unfixed[0], /^[0-9a-f]{8}$/);
});

// --- one repository per review (docs/design-notes/questions/record-repo-answer.md)
// `record --work` keyed on the cwd while round.sh's converge keyed on the scope,
// so a lead in repo A reviewing repo B wrote B's findings into A's memory and
// converge read B's empty file as CLEAN.
const cliIn = (cwd) => (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", cwd });
const rowsIn = (logDir, repo) => (existsSync(findingsFile(repo, { logDir })) ? stored(logDir, repo) : []);
const twoRepos = () => ({ a: gitRepo({ origin: "https://github.com/o/a.git" }), b: gitRepo({ origin: "https://github.com/o/b.git" }) });

test("nextAction: a tier read from tier.json is shell-quoted like every other dynamic word", () => {
  const next = nextAction(verdictOf("CLEAN"), COUNTS, { work: "/w/review-1", tier: "L; rm -rf x", scripts: SCRIPTS });
  assert.match(next, / --tier 'L; rm -rf x' --intent /, next);
  assert.match(nextFor("CLEAN"), / --tier M /, "a plain tier stays bare");
});

test("record --work refuses a round round.sh never planned, and creates no round dir", () => {
  const logDir = workdir(), repo = gitRepo({ origin: "https://github.com/o/r.git" });
  const work = scoped(path.join(workdir(), "review-1"), repo);
  const run = cliIn(repo);
  assert.equal(run(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);
  const typo = run(["record", "--work", work, "--round", "9", "--log-dir", logDir], "[]");
  assert.equal(typo.status, 2, typo.stderr);
  assert.ok(typo.stderr.includes(path.join(work, "round-9", "tier.json")), typo.stderr);
  assert.equal(existsSync(path.join(work, "round-9")), false, "no round dir is invented");
  const out = run(["converge", "--work", work, "--log-dir", logDir]);
  assert.match(out.stdout, /^CONTINUE — round 1 /m, "converge still judges the newest real round");
});

test("record-repo: run from repo A on a scope naming repo B, the rows land in B and converge sees them", () => {
  const logDir = workdir(), { a, b } = twoRepos();
  const work = scoped(path.join(workdir(), "review-1"), b);
  const run = cliIn(a);
  assert.equal(run(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);
  assert.equal(rowsIn(logDir, b).length, 1, "the rows land in B's memory");
  assert.equal(rowsIn(logDir, a).length, 0, "and none in A's");
  const out = run(["converge", "--work", work, "--round", "1", "--log-dir", logDir]);
  assert.match(out.stdout, /^CONTINUE — /m, "the fixed row is seen, not a false CLEAN");
});

test("record-repo: --repo and --review are unknown arguments for every command", () => {
  const logDir = workdir(), { a, b } = twoRepos();
  const work = scoped(path.join(workdir(), "review-1"), b);
  for (const command of ["record", "converge", "prior", "engagement"]) {
    for (const [flag, value] of [["--repo", b], ["--review", "r"]]) {
      const out = cliIn(a)([command, "--work", work, flag, value, "--log-dir", logDir], "[]");
      assert.equal(out.status, 2, `${command} ${flag}`);
      assert.match(out.stderr, new RegExp(`unknown argument ${flag} `), `${command} ${flag}`);
    }
  }
});

test("record-repo: every command without --work exits 2 before it reads or writes anything", () => {
  const logDir = workdir(), { a } = twoRepos();
  const input = path.join(workdir(), "findings.json");
  writeFileSync(input, JSON.stringify([candidate()]));
  const scope = path.join(workdir(), "scope.diff");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n c\n+added\n");
  const args = { record: ["--in", input], converge: [], prior: ["--scope", scope, "--out", path.join(logDir, "prior.md")], engagement: [] };
  for (const [command, extra] of Object.entries(args)) {
    const out = cliIn(a)([command, ...extra, "--log-dir", logDir], "{oops");
    assert.equal(out.status, 2, `${command}: ${out.stderr}`);
    assert.match(out.stderr, /pass --work <this review's work dir>/, command);
    assert.deepEqual(readdirSync(logDir), [], `${command} wrote nothing`);
  }
});

test("record-repo: a missing round-1 scope exits 2 naming it, and writes no rows and no receipt", () => {
  const logDir = workdir(), { a } = twoRepos();
  const work = path.join(workdir(), "review-1");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  const out = cliIn(a)(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()]));
  assert.equal(out.status, 2);
  assert.ok(out.stderr.includes(path.join(work, "round-1", "scope.diff")), out.stderr);
  assert.equal(rowsIn(logDir, a).length, 0, "no fallback to the cwd");
  assert.equal(existsSync(path.join(work, "round-1", "recorded.json")), false);
});

test("record-repo: a scope in no repository keys on the work dir, whichever cwd asks", () => {
  const logDir = workdir(), { a, b } = twoRepos();
  const work = path.join(workdir(), "review-1");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  // A `# repo: ` line inside a plain file's content is content, not structure.
  writeFileSync(path.join(work, "round-1", "scope.diff"), `# self-review scope (not a git repo)\n==> /x/notes.txt <==\n# repo: ${a}\n`);
  planned(work, 1);
  assert.equal(cliIn(a)(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);
  assert.equal(rowsIn(logDir, realpathSync(work)).length, 1);
  assert.equal(rowsIn(logDir, a).length, 0, "the plain section's `# repo: ` line did not take over");
  assert.match(cliIn(b)(["converge", "--work", work, "--round", "1", "--log-dir", logDir]).stdout, /^CONTINUE — /m,
    "converge from another cwd reads the same file");
});

test("record-repo: in a mixed scope the first git repository wins", () => {
  const logDir = workdir(), { a, b } = twoRepos();
  const work = path.join(workdir(), "review-1");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  writeFileSync(path.join(work, "round-1", "scope.diff"),
    `# self-review scope\n# repo: ${b}\n\n# self-review scope\n# repo: ${a}\n\n# self-review scope (not a git repo)\n==> /x/notes.txt <==\n# repo: ${a}\n`);
  planned(work, 1);
  assert.equal(cliIn(a)(["record", "--work", work, "--round", "1", "--log-dir", logDir], JSON.stringify([candidate()])).status, 0);
  assert.equal(rowsIn(logDir, b).length, 1);
  assert.equal(rowsIn(logDir, a).length, 0);
});

test("record-repo: prior --work run from repo A reads repo B's memory", () => {
  const logDir = workdir(), { a, b } = twoRepos();
  const work = scoped(path.join(workdir(), "review-1"), b);
  recordFindings([candidate()], { review: "earlier", round: 1, repoRoot: b, logDir });
  const scope = path.join(work, "scope-2.diff"), out = path.join(work, "prior.md");
  writeFileSync(scope, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
  assert.equal(cliIn(a)(["prior", "--scope", scope, "--out", out, "--work", work, "--log-dir", logDir]).status, 0);
  assert.match(readFileSync(out, "utf8"), /null deref/);
});

// Empty-record A (questions/empty-record-answer.md): a `[]` over candidates the
// round's reviewers filed is the forgotten round dressed as a clean one.
const emptyRecordWork = (state = {}, rounds = [1]) => {
  const repo = gitRepo();
  const work = scoped(workdir(), repo, rounds);
  for (const [name, text] of Object.entries(state)) {
    const [round, file] = name.includes("/") ? name.split("/") : ["round-1", name];
    mkdirSync(path.join(work, round, "state"), { recursive: true });
    writeFileSync(path.join(work, round, "state", file), text);
  }
  const logDir = workdir();
  const run = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args, "--work", work, "--log-dir", logDir], { input, encoding: "utf8", cwd: repo });
  return { work, logDir, run, receipt: (round = 1) => existsSync(path.join(work, `round-${round}`, "recorded.json")) };
};
const twoCandidates = `${JSON.stringify({ file: "a.mjs", line: 1, summary: "x" })}\n${JSON.stringify({ file: "a.mjs", line: 2, summary: "y" })}\n`;

test("record refuses [] over filed candidates, names the file and its count, and writes nothing", () => {
  const { logDir, run, receipt } = emptyRecordWork({ "self-review-finder-k1-r1-abd.jsonl": twoCandidates });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /self-review-finder-k1-r1-abd\.jsonl \(2\)/);
  assert.equal(receipt(), false);
  assert.deepEqual(readdirSync(logDir), [], "no memory row was written");
});

test("record with a row over the same filed candidates records and writes the receipt", () => {
  const { run, receipt } = emptyRecordWork({ "self-review-finder-k1-r1-abd.jsonl": twoCandidates });
  const out = run(["record", "--round", "1"], JSON.stringify([candidate()]));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(receipt(), true);
});

test("a verifier's verdict lines are not candidates: [] records, CLEAN", () => {
  const { run, receipt } = emptyRecordWork({ "self-review-verifier-k1-r2-b1.jsonl": `${JSON.stringify({ id: "r1-1", verdict: "REFUTED" })}\n` });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^CLEAN — /m);
  assert.equal(receipt(), true);
});

test("state files that are empty, hold [] or hold only prose are no candidates", () => {
  const { run, receipt } = emptyRecordWork({
    "self-review-finder-k1-r1-a.jsonl": "",
    "self-review-finder-k1-r1-b.jsonl": "[]\n",
    "self-review-finder-k1-r1-c.jsonl": "reading the scope\nnothing found, moving on\n",
  });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(receipt(), true);
});

test("a round with no state dir records []", () => {
  const { run, receipt } = emptyRecordWork();
  assert.equal(run(["record", "--round", "1"], "[]").status, 0);
  assert.equal(receipt(), true);
});

test("a misnamed state file counts: waiting on the wrong name is how [] gets recorded", () => {
  const { run, receipt } = emptyRecordWork({ "finder-abd-attempt-1.jsonl": `${JSON.stringify({ summary: "x" })}\n` });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /finder-abd-attempt-1\.jsonl \(1\)/);
  assert.equal(receipt(), false);
});

test("a cold grader's state file counts", () => {
  const { run, receipt } = emptyRecordWork({ "self-review-cold-grader-k1-r1-x.jsonl": `${JSON.stringify({ summary: "x" })}\n` });
  assert.equal(run(["record", "--round", "1"], "[]").status, 3);
  assert.equal(receipt(), false);
});

test("a one-line array of objects in a state file counts each object", () => {
  const { run } = emptyRecordWork({ "self-review-finder-k1-r1-abd.jsonl": `${JSON.stringify([{ summary: "x" }, { summary: "y" }, 3])}\n` });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /self-review-finder-k1-r1-abd\.jsonl \(2\)/);
});

test("only the recorded round's state is read: round 1's candidates do not block round 2's []", () => {
  const { run, receipt } = emptyRecordWork({ "round-1/self-review-finder-k1-r1-abd.jsonl": twoCandidates }, [1, 2]);
  assert.equal(run(["record", "--round", "1"], JSON.stringify([candidate()])).status, 0);
  const out = run(["record", "--round", "2"], "[]");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(receipt(2), true);
});

test("after the refusal, converge calls the round UNRECORDED", () => {
  const { run } = emptyRecordWork({ "self-review-finder-k1-r1-abd.jsonl": twoCandidates });
  assert.equal(run(["record", "--round", "1"], "[]").status, 3);
  const out = run(["converge", "--round", "1"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^UNRECORDED — /m);
});

test("a state file that is not .jsonl is not read: [] records", () => {
  const { run, receipt } = emptyRecordWork({ "notes.txt": `${JSON.stringify({ summary: "x" })}\n`, "self-review-finder-k1-r1-a.jsonl.tmp": `${JSON.stringify({ summary: "y" })}\n` });
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(receipt(), true);
});

test("a state path that cannot be listed fails closed: exit 3, no receipt", () => {
  const { work, run, receipt } = emptyRecordWork();
  writeFileSync(path.join(work, "round-1", "state"), "not a directory\n");
  const out = run(["record", "--round", "1"], "[]");
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /cannot list the round's state dir/);
  assert.equal(receipt(), false);
});
