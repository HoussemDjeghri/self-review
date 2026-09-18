// Run: node --test plugin/scripts/round.test.mjs   (or ./test.sh for everything)
// round.sh is the per-round setup as ONE call. What is worth testing is not
// that it chains — it is the three things it makes structural, each of which
// was a live defect first: the tier ceiling a later round inherits, the empty
// `paths` array that macOS bash 3.2 refuses under `set -u`, and a work dir
// inside the repository under review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUND = path.join(HERE, "round.sh");
const FINDINGS = path.join(HERE, "findings.mjs");
// Every round's `prior`, `engagement` and (from round 2) `converge` call writes
// under the log dir; the suite must not write into the developer's own memory.
process.env.SELF_REVIEW_LOG_DIR = mkdtempSync(path.join(tmpdir(), "round-log-"));

/** A repo with one committed file and a small uncommitted edit to it. */
const fixture = () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "round-")), "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src/cli.mjs"), "export const parseArgs = (a) => a;\n");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(path.join(repo, "src/cli.mjs"), 'export const parseArgs = (a) => { if (!a) throw new Error("bad"); return a; };\n');

  const work = path.join(mkdtempSync(path.join(tmpdir(), "round-work-")), "sr");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "intent.md"), "intent\n");
  return { repo, work };
};

const run = (repo, args) =>
  spawnSync("bash", [ROUND, ...args], { cwd: repo, encoding: "utf8" });

const tierOf = (work, round) =>
  JSON.parse(readFileSync(path.join(work, `round-${round}`, "tier.json"), "utf8"));

test("a change that ships something runnable gets a cold run, and its verdict reaches the caller", () => {
  // coldrun.sh keeps its stdout to a few lines so they can land in the calling
  // session; round.sh redirected them into a file nothing ever read. That hid
  // the line that matters most — on a host with no containment coldrun runs
  // NOTHING, and the only other trace of that is a `minor` candidate from the
  // grader, which a round is entitled to treat as noise. A review that
  // executed nothing has to say so where the person running it will see it.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, "ship.sh"), "#!/usr/bin/env bash\necho hi\n");
  chmodSync(path.join(repo, "ship.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^cold run: /m, "the tier it achieved is on stdout, not only in a file");
  assert.match(done.stdout, /entry points: [1-9]/, "and it found the runnable file");
  // The success and failure branches are one `if`, and an edit once collapsed
  // them: the "failed" message moved INSIDE the success branch, so every good
  // run reported a failure and a real failure reported nothing at all. A test
  // that only checks the happy path does not notice that.
  assert.doesNotMatch(done.stderr, /coldrun\.sh failed/, "a run that worked does not report a failure");

  // The grader is the reviewer that reads the transcript, and it is the one
  // agent in the plan with no shell. Whether it survives is F4's contract, and
  // it depends on the host: one with no containment executes nothing, and a
  // grader with no transcript can only file "not exercised" for 237k tokens.
  const plan = tierOf(work, 1);
  const cold = plan.finders.filter((f) => f.agent === "self-review-cold-grader");
  const transcript = path.join(work, "round-1", "cold run", "transcript.md");
  const invocations = (readFileSync(transcript, "utf8").match(/^- exit: /gm) ?? []).length;
  if (invocations) {
    assert.equal(cold.length, 1, "angle X is planned, once");
    assert.deepEqual(cold[0].angles, ["X"]);
    assert.equal(plan.coldSkipped, undefined);
    const brief = readFileSync(path.join(work, "round-1", "briefs", `${cold[0].name}.md`), "utf8");
    assert.match(brief, /transcript/i, "and its brief points at the run that already happened");
  } else {
    assert.equal(cold.length, 0, "no transcript, no grader");
    assert.match(plan.coldSkipped, /executed nothing/);
  }
});

test("with no paths it scopes the whole working tree", () => {
  // Regression: `"${paths[@]}"` on an empty array is an unbound variable under
  // `set -u` in bash 3.2, which is what macOS ships — and no paths is the
  // common case. It failed before it ever reached scope.sh.
  const { repo, work } = fixture();
  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^tier S · round 1/m);
  assert.equal(tierOf(work, 1).finders.length, 1, "a 1-line change is one finder");
});

test("a later round inherits round 1's tier as a ceiling", () => {
  // The measured regression: round 1 fixes its finding by writing a test file,
  // the scope is captured against HEAD so the fix's lines are added to the
  // change's, and round 2 recomputes a higher tier and spends more finders —
  // the loop charging more for having fixed something well.
  const { repo, work } = fixture();
  run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(tierOf(work, 1).tier, "S");

  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(path.join(repo, "test/cli.test.mjs"), Array.from({ length: 24 }, (_, i) => `// test line ${i}`).join("\n"));

  const done = run(repo, ["--work", work, "--round", "2", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 0, done.stderr);
  const two = tierOf(work, 2);
  assert.equal(two.tier, "S", "held at what round 1 gave the change");
  assert.equal(two.cappedTo, "S");
  assert.notEqual(two.computed, "S", "the cumulative scope really does compute higher — that is the bug");
  assert.equal(two.finders.length, 1, "and it no longer buys a second finder");
});

test("it refuses a work dir inside the repository under review", () => {
  // Otherwise scope.sh picks up the round's own scope.diff, impact.json and
  // ledger as changed files: the loop reviews its own paperwork and climbs a
  // tier every round. Observed at 16 changed files and a risk marker on
  // ledger.md before the guard existed.
  const { repo } = fixture();
  const inside = path.join(repo, ".sr");
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, "intent.md"), "intent\n");

  const done = run(repo, ["--work", inside, "--round", "1", "--intent", path.join(inside, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 2);
  assert.match(done.stderr, /inside the repository under review/);
});

test("an empty scope is refused before any brief is written", () => {
  const { repo, work } = fixture();
  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight", "src/nothing-here.mjs"]);
  assert.equal(done.status, 4);
  assert.match(done.stderr, /scope is empty/);
});

test("F1: a change committed this turn is a round, not an empty scope", () => {
  // D1: `git status` forgets a committed change, so a lead who committed first
  // and passed --base got "the scope is empty" with a full diff in scope.diff.
  // The plan is built from the changed-file list; the list came from the wrong
  // command. Exercised end to end here because the three symptoms — tier from
  // nothing, this abort, no cold run — were one cause read by three consumers.
  const { repo, work } = fixture();
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("add", "-A");
  git("commit", "-qm", "the change under review");

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight", "--base", base]);
  assert.doesNotMatch(done.stderr, /scope is empty/, done.stdout);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(path.join(work, "round-1", "scope.diff"), "utf8"), /^ {3}M src\/cli\.mjs$/m);
});

/** round.sh from a shadow directory, so one sibling script can be replaced. */
function shadowRound(work, stub) {
  const shadow = path.join(path.dirname(work), `bin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(shadow, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(stub)) {
    writeFileSync(path.join(shadow, name), body);
    chmodSync(path.join(shadow, name), 0o755);
  }
  for (const name of ["scope.sh", "tier.mjs", "impact.mjs", "findings.mjs", "brief.mjs", "preflight.sh", "coldrun.sh", "treecheck.sh"]) {
    if (stub[name]) continue;
    writeFileSync(path.join(shadow, name), `#!/bin/sh\nexec "${path.join(HERE, name)}" "$@"\n`);
    chmodSync(path.join(shadow, name), 0o755);
  }
  writeFileSync(path.join(shadow, "round.sh"), readFileSync(path.join(HERE, "round.sh"), "utf8"));
  writeFileSync(path.join(shadow, "lib", "path.sh"), readFileSync(path.join(HERE, "lib", "path.sh"), "utf8"));
  return path.join(shadow, "round.sh");
}

/** A fixture that ships something runnable, so angle X is planned at all. */
function runnableFixture() {
  const made = fixture();
  writeFileSync(path.join(made.repo, "ship.sh"), "#!/usr/bin/env bash\necho hi\n");
  chmodSync(path.join(made.repo, "ship.sh"), 0o755);
  return made;
}

test("F4: a cold run that failed leaves no grader in the plan", () => {
  // D6: a grader was spawned with no transcript — 237k tokens and four tool
  // calls to file the one `minor` its brief told it to file. round.sh kept the
  // X row whatever coldrun.sh did.
  const { repo, work } = runnableFixture();
  const round = shadowRound(work, { "coldrun.sh": "#!/bin/sh\necho 'boom' >&2\nexit 1\n" });
  const done = spawnSync("bash", [round, "--work", work, "--round", "1",
    "--intent", path.join(work, "intent.md"), "--no-preflight"], { cwd: repo, encoding: "utf8" });

  assert.equal(done.status, 0, done.stderr);
  const plan = tierOf(work, 1);
  assert.deepEqual(plan.finders.filter((f) => f.agent === "self-review-cold-grader"), [], "the X row is gone");
  assert.match(plan.coldSkipped, /coldrun\.sh failed/, "and the plan says why, for audit.mjs and the report");
  assert.match(done.stdout, /^cold run: nothing to grade — coldrun\.sh failed/m, "on stdout, where the lead reads it");
  assert.match(done.stdout, /angle X dropped from the plan/);
  assert.deepEqual(readdirSync(path.join(work, "round-1", "briefs")).filter((f) => f.includes("cold")), [],
    "and brief.mjs wrote no grader brief");
});

test("F4: a cold run that executed nothing is the same news as one that failed", () => {
  // A host with no containment refuses to execute and still writes a
  // transcript. "There is a transcript" was the wrong question; "was anything
  // invoked" is the right one, and an invocation records its exit line.
  const { repo, work } = runnableFixture();
  const stub = [
    "#!/bin/sh",
    'out=""',
    'while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done',
    'mkdir -p "$out"',
    'printf "# Cold run\\n\\n- containment: **network-denied**\\n\\n## Nothing was executed\\n" > "$out/transcript.md"',
    'echo "cold run: network-denied"',
    "",
  ].join("\n");
  const round = shadowRound(work, { "coldrun.sh": stub });
  const done = spawnSync("bash", [round, "--work", work, "--round", "1",
    "--intent", path.join(work, "intent.md"), "--no-preflight"], { cwd: repo, encoding: "utf8" });

  assert.equal(done.status, 0, done.stderr);
  const plan = tierOf(work, 1);
  assert.deepEqual(plan.finders.filter((f) => f.agent === "self-review-cold-grader"), []);
  assert.match(plan.coldSkipped, /executed nothing/);
  assert.match(done.stdout, /^cold run: nothing to grade — the cold run executed nothing/m);
});

test("F5: the tree the reviewers are pointed at is recorded before they run", () => {
  const { repo, work } = fixture();
  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(path.join(work, "round-1", "tree-before.txt"), "utf8"), /src\/cli\.mjs/,
    "without this snapshot treecheck.sh has nothing to compare a reviewer's write against");
});

test("F2: a scope holding an earlier review's work dir is refused, not reviewed", () => {
  // D2: the reporter's `scratchpad/self-review/` was untracked, so it was
  // scoped like any other new file — 4,337 lines, tier L, six finders, ~3M
  // tokens spent reviewing the review's own notes. Refused rather than
  // excluded silently: a silent exclusion is how a real change escapes review.
  const { repo, work } = fixture();
  const paperwork = path.join(repo, "scratchpad", "sr");
  mkdirSync(path.join(paperwork, "round-1", "briefs"), { recursive: true });
  writeFileSync(path.join(paperwork, "intent.md"), "an earlier round\n");
  writeFileSync(path.join(paperwork, "round-1", "scope.diff"), "old scope\n");
  writeFileSync(path.join(paperwork, "round-1", "tier.json"), "{}\n");
  writeFileSync(path.join(paperwork, "round-1", "briefs", "q.md"), "old brief\n");

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 2, done.stderr);
  assert.match(done.stderr, /^round\.sh: the scope contains self-review paperwork — scratchpad\/sr\/ \(4 files, \d+ lines\)$/m);
  assert.match(done.stderr, /^ {2}remove it \(rm -r scratchpad\/sr\/\), or scope only the change/m);
  assert.equal(existsSync(path.join(work, "round-1", "tier.json")), false, "refused before the plan is built");

  // The one-line override the refusal names has to work.
  const scoped = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight", "src/cli.mjs"]);
  assert.equal(scoped.status, 0, scoped.stderr);
});

test("--reason without --force is refused, and a missing intent is named", () => {
  const { repo, work } = fixture();
  const loose = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--reason", "because"]);
  assert.equal(loose.status, 2);
  assert.match(loose.stderr, /--reason belongs to --force/);

  const gone = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "no-intent.md")]);
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /no intent file/);
});

test("pre-flight runs by default, rooted at the repo and not at the cwd", () => {
  // Every other case here passes --no-preflight, so the default path — the one
  // every real round takes — was untested. And it was wrong: `--root "$(pwd)"`
  // meant a round started from a subdirectory pointed pre-flight at a directory
  // with no manifest, which reports "no checks detected" and lets a broken
  // suite reach the reviewers unannounced.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, "test.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(path.join(repo, "test.sh"), 0o755);
  mkdirSync(path.join(repo, "src", "deep"), { recursive: true });

  const done = spawnSync("bash", [ROUND, "--work", work, "--round", "1", "--intent", path.join(work, "intent.md")],
    { cwd: path.join(repo, "src", "deep"), encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^pre-flight \(from .*cold run – ü\/install\):/m,
    "the verdicts reach the caller, and say which tree they are about");
  // PASS, not OK: the grep used to filter for a token preflight.sh never emits,
  // so passing checks were silently dropped and only failures were reported.
  assert.match(done.stdout, /^PASS\s+\S+\s+\.\/test\.sh/m);
  assert.doesNotMatch(readFileSync(path.join(work, "round-1", "preflight.txt"), "utf8"), /no checks detected/);

  // And a project that defines nothing must SAY so: "pre-flight ran and found
  // nothing to run" and "pre-flight never ran" call for opposite reactions,
  // and the verdict grep used to match neither, printing no section at all.
  const bare = fixture();
  const quiet = run(bare.repo, ["--work", bare.work, "--round", "1", "--intent", path.join(bare.work, "intent.md")]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /^# no checks detected/m);
});

test("F8: pre-flight runs the project's own checks from the install copy, not from the checkout", () => {
  // Eleven files resolved their own root through a URL component rather than
  // `fileURLToPath` (the guard for that spelling is in docs-claims.test.mjs),
  // which keeps percent-encoding: a path with a space became `cold%20run` and
  // everything under it failed ENOENT. Nine releases and a 485-test suite could
  // not see it, because every suite ran from the one path where a root computed
  // from the file's own location cannot be wrong. Pre-flight already loads a
  // project's libraries broadly and already owns a suite-sized budget, so it is
  // the instrument: same checks, same cost, run where the bug can show.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, "test.sh"),
    '#!/bin/sh\necho "root: $(cd "$(dirname "$0")" && pwd)"\necho "home: $HOME"\nexit 1\n');
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stderr, /could not stage/, done.stderr);

  const report = readFileSync(path.join(work, "round-1", "preflight.txt"), "utf8");
  const ran = /^root: (.*)$/m.exec(report)?.[1];
  assert.ok(ran, report);
  assert.equal(ran, realpathSync(path.join(work, "round-1", "cold run – ü", "install")),
    "the suite ran from the copy — space and non-ASCII in the path, and not the developer's tree");
  // A copy, not a symlink: Node realpaths `import.meta.url`, so through a link
  // the suite would be right back at the checkout and the whole test is void.
  assert.notEqual(ran, realpathSync(repo));
  // The DEVELOPER'S home, and this assertion is the inversion of the one it
  // replaces. The copy's own empty `home` was the original design; every
  // toolchain keeps its locator state in HOME, so emptying it tells each of them
  // to repair itself and the repair is a WRITE — through the linked dependency
  // tree, into the author's real checkout. Measured on pnpm 2026-09-07:
  // `.modules.yaml` holds an absolute storeDir, a moved HOME moves the default
  // store, and pnpm purges and reinstalls the linked node_modules, rewriting the
  // real repository's storeDir to a directory round.sh then deletes. The
  // isolation that empty HOME was reaching for belongs to the CONTAINED cold run,
  // where a write cannot escape; this stage stops before those tiers.
  assert.equal(/^home: (.*)$/m.exec(report)?.[1] ?? "", process.env.HOME,
    "with the developer's own HOME — an empty one makes the toolchain repair itself into the author's tree");
});

test("the tripwire reports a pre-flight that wrote into the checkout's dependency tree", () => {
  // The stage LINKS node_modules rather than copying it, so every check has a
  // live path into the author's real checkout. Inheriting HOME removes the cause
  // we know of; it does not prove there is no other, and "a review never writes
  // the author's tree" is the invariant that must not fail quietly. Reported,
  // never fatal — the reviewers still need the suite verdict, and what a write
  // into their node_modules means is the operator's call.
  const { repo, work } = fixture();
  // The `.gitignore` is the whole fixture. coldrun.sh links a dependency tree
  // only when the copy predicate DROPPED it, which it does for ignored files
  // and nothing else — without this line node_modules is copied into the stage,
  // the suite writes into that copy, the checkout is untouched, and this test
  // passes on an alarm with no breach behind it.
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "marker.txt"), "before\n");
  writeFileSync(path.join(repo, "test.sh"),
    '#!/bin/sh\necho "touching the linked tree"\necho after > node_modules/marker.txt\n');
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /TRIP {2}node_modules {4}pre-flight wrote into the checkout through the staged link:/,
    `the write must reach the lead's own report, not only stderr:\n${done.stdout}`);
  assert.equal(readFileSync(path.join(repo, "node_modules", "marker.txt"), "utf8"), "after\n",
    "the author's own checkout is what was written — the alarm names that mechanism");
});

test("pre-flight runs with pnpm's pre-run install off, and the tripwire watches a workspace package's link", () => {
  // pnpm 11 installs before a script whose dependencies look stale, and the
  // stage always does: the workspace state records the checkout's absolute
  // paths. The install purges, and with no TTY aborts — a FAIL on code nobody
  // broke, in every round-1 report of a pnpm workspace (field report 2026-09-18).
  // With every package's node_modules now linked, a write through a NESTED link
  // reaches the checkout as surely as one through the root's, so the tripwire
  // must see those too.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(path.join(repo, "packages", "app", "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "packages", "app", "index.js"), "export default 1;\n");
  writeFileSync(path.join(repo, "packages", "app", "node_modules", "marker.txt"), "before\n");
  writeFileSync(path.join(repo, "test.sh"),
    '#!/bin/sh\necho "verify: $pnpm_config_verify_deps_before_run"\necho after > packages/app/node_modules/marker.txt\nexit 1\n');
  // Red on purpose: preflight.txt keeps the output tail of a failing check only.
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  const report = readFileSync(path.join(work, "round-1", "preflight.txt"), "utf8");
  assert.match(report, /^verify: false$/m, report);
  assert.match(done.stdout, /TRIP {2}packages\/app\/node_modules {4}pre-flight wrote into the checkout/,
    `a write through a package's link must trip like one through the root's:\n${done.stdout}`);
});

test("a symlink the repository itself commits is not a path into the checkout", () => {
  // The tripwire walks every link in the stage at any depth, and the copy keeps
  // the repo's own links. A relative `current -> releases/v1` lands pointing
  // inside the stage, so a write through it never left the copy — reporting it
  // as a write into the checkout is a breach that did not happen.
  const { repo, work } = fixture();
  mkdirSync(path.join(repo, "releases", "v1"), { recursive: true });
  writeFileSync(path.join(repo, "releases", "v1", "keep.txt"), "v1\n");
  symlinkSync("releases/v1", path.join(repo, "current"));
  writeFileSync(path.join(repo, "test.sh"), "#!/bin/sh\necho built > current/out.txt\n");
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stdout, /TRIP/, done.stdout);
});

test("a pre-flight that wrote nothing adds no tripwire line", () => {
  const { repo, work } = fixture();
  // Ignored, so the tree is really LINKED — the negative case has to run the
  // same traversal the positive one does, or it asserts nothing.
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "marker.txt"), "untouched\n");
  writeFileSync(path.join(repo, "test.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stdout, /TRIP/,
    "a tripwire that fires on a clean run is one the lead learns to ignore");
});

test("F8: a copy that cannot be staged falls back to the checkout and says so", () => {
  // Pre-flight from the checkout is what every release until this one did, and
  // it is worth more than no pre-flight: the fallback is reported, not fatal.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, "test.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(path.join(repo, "test.sh"), 0o755);
  const round = shadowRound(work, { "coldrun.sh": "#!/bin/sh\necho 'no disk' >&2\nexit 2\n" });

  const done = spawnSync("bash", [round, "--work", work, "--round", "1", "--intent", path.join(work, "intent.md")],
    { cwd: repo, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /could not stage the install copy .*stage\.err.* — pre-flight runs from the checkout/);
  assert.match(done.stdout, /^pre-flight \(from .*\/repo\):/m, "the checkout, named");
  assert.match(done.stdout, /^PASS\s+\S+\s+\.\/test\.sh/m, "the checks still ran");
});

test("the inside-repo guard holds when the work dir does not exist yet", () => {
  // The guard compares a resolved work dir against the repo root, and abs_path
  // used to hand back the caller's literal spelling when the parent directory
  // did not exist yet — `cd` failed, so nothing was resolved and the paths
  // could not match. A reviewer reproduced it: --work <repo>/nested/not/yet
  // walked straight through and the round scoped its own scope.diff as an
  // untracked change. A resolver that fails open is worse than none, because
  // every caller reads its answer as canonical.
  const { repo, work } = fixture();
  const unborn = path.join(repo, "nested", "not", "yet", "created");

  const done = run(repo, ["--work", unborn, "--round", "1", "--intent", path.join(work, "intent.md"), "--no-preflight"]);
  assert.equal(done.status, 2, done.stdout);
  assert.match(done.stderr, /inside the repository under review/);
  assert.doesNotMatch(done.stderr, /nested\/not\/yet\/created$/m, "the path it names is the resolved one");
});

test("a failing impact.mjs costs the blast radius, not the round", () => {
  // round.sh runs under `set -euo pipefail`, so a bare impact.mjs call aborted
  // with only scope.diff written — no tier.json, no briefs — while SKILL.md
  // promised the loop keeps going without these scripts. tier.mjs already
  // handles a missing impact.json, so the failure degrades instead.
  const { repo, work } = fixture();
  const shadow = path.join(path.dirname(work), "bin");
  mkdirSync(shadow, { recursive: true });
  writeFileSync(path.join(shadow, "impact.mjs"), "#!/bin/sh\nexit 9\n");
  chmodSync(path.join(shadow, "impact.mjs"), 0o755);
  for (const name of ["scope.sh", "tier.mjs", "findings.mjs", "brief.mjs", "preflight.sh", "treecheck.sh"]) {
    writeFileSync(path.join(shadow, name), `#!/bin/sh\nexec "${path.join(HERE, name)}" "$@"\n`);
    chmodSync(path.join(shadow, name), 0o755);
  }
  // round.sh resolves its siblings from `dirname $0`, so it must BE in the
  // shadow dir — a shim that execs the real one lands `here` back in scripts/.
  writeFileSync(path.join(shadow, "round.sh"), readFileSync(path.join(HERE, "round.sh"), "utf8"));
  mkdirSync(path.join(shadow, "lib"), { recursive: true });
  writeFileSync(path.join(shadow, "lib", "path.sh"), readFileSync(path.join(HERE, "lib", "path.sh"), "utf8"));

  const done = spawnSync("bash", [path.join(shadow, "round.sh"), "--work", work, "--round", "1",
    "--intent", path.join(work, "intent.md"), "--no-preflight"], { cwd: repo, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /impact\.mjs failed/);
  assert.match(done.stdout, /^tier M · round 1/m, "S is lifted to M: the caller clause could not be checked");
  assert.ok(readFileSync(path.join(work, "round-1", "tier.json"), "utf8").length, "the plan was still written");
});

test("a failing pre-flight is reported, not swallowed", () => {
  // `>/dev/null 2>&1 || true` hid preflight.sh's own exit-2 paths completely:
  // no message, no preflight.txt, no section, exit 0 — while SKILL.md tells the
  // session to say which script did not run. Asymmetric with impact.mjs, which
  // announces its failure two lines below.
  const { repo, work } = fixture();
  const shadow = path.join(path.dirname(work), "bin2");
  mkdirSync(path.join(shadow, "lib"), { recursive: true });
  writeFileSync(path.join(shadow, "preflight.sh"), "#!/bin/sh\necho 'crash' >&2\nexit 2\n");
  chmodSync(path.join(shadow, "preflight.sh"), 0o755);
  for (const name of ["scope.sh", "tier.mjs", "impact.mjs", "findings.mjs", "brief.mjs", "treecheck.sh"]) {
    writeFileSync(path.join(shadow, name), `#!/bin/sh\nexec "${path.join(HERE, name)}" "$@"\n`);
    chmodSync(path.join(shadow, name), 0o755);
  }
  writeFileSync(path.join(shadow, "round.sh"), readFileSync(path.join(HERE, "round.sh"), "utf8"));
  writeFileSync(path.join(shadow, "lib", "path.sh"), readFileSync(path.join(HERE, "lib", "path.sh"), "utf8"));

  const done = spawnSync("bash", [path.join(shadow, "round.sh"), "--work", work, "--round", "1",
    "--intent", path.join(work, "intent.md")], { cwd: repo, encoding: "utf8" });
  assert.equal(done.status, 0, "a failed pre-flight still must not cost the round");
  assert.match(done.stderr, /preflight\.sh failed/);
  assert.match(readFileSync(path.join(work, "round-1", "preflight.err"), "utf8"), /crash/);
});

test("an asset-only change is not reported as an empty scope", () => {
  // Zero finders has two causes. tier.mjs lists assets and deliberately does
  // not review them, so a round whose only remaining diff is a regenerated
  // screenshot gets no finder — and saying "nothing changed" about it is
  // false. Most likely on a later round, which is where a wrong message costs
  // the most, because the session is deciding whether the loop is done.
  const { repo, work } = fixture();
  writeFileSync(path.join(repo, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"),
    "--no-preflight", "logo.png"]);
  assert.equal(done.status, 4);
  assert.match(done.stderr, /never reviews \(assets:1/);
  assert.doesNotMatch(done.stderr, /scope is empty/);

  // Same claim, different kind: tier.ignore covers lockfiles and generated
  // output, and a change that is only those is also not "nothing changed".
  const locked = fixture();
  writeFileSync(path.join(locked.repo, "package-lock.json"), '{"name":"x"}\n');
  const skipped = run(locked.repo, ["--work", locked.work, "--round", "1",
    "--intent", path.join(locked.work, "intent.md"), "--no-preflight", "package-lock.json"]);
  assert.equal(skipped.status, 4);
  assert.match(skipped.stderr, /never reviews \(ignored:1/);
  assert.doesNotMatch(skipped.stderr, /scope is empty/);
});

test("--force without --reason dies before any script runs", () => {
  // It was caught, but by tier.mjs — after scope.sh and impact.mjs had written
  // files, and naming a script the caller never invoked.
  const { repo, work } = fixture();
  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md"), "--force", "L"]);
  assert.equal(done.status, 2);
  assert.match(done.stderr, /^round\.sh: --force needs --reason/);
  assert.doesNotMatch(done.stderr, /tier\.mjs/);
});

// The installed-root suite (ruling 1, item 3). `preflight.artifactRoot` names
// the subdirectory that becomes the root of what the project ships, and round 1
// runs that subdirectory's tests with it AS the root — the shape an installed
// copy has and the repository never does.
const withArtifactRoot = (repo, artifactRoot) => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "round-cfg-")), "config.json");
  writeFileSync(cfg, JSON.stringify({ preflight: { skip: ["*"], artifactRoot } }));
  return (args) => spawnSync("bash", [ROUND, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, SELF_REVIEW_CONFIG: cfg } });
};

test("the shipped subdirectory's suite runs with that subdirectory as the root", () => {
  const { repo, work } = fixture();
  mkdirSync(path.join(repo, "ship"), { recursive: true });
  // A test that resolves a path against ITS OWN root — green from the artifact
  // root, and the whole reason this check exists.
  writeFileSync(path.join(repo, "ship", "a.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\ntest("ships its own manifest", () => { assert.ok(existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "marker.txt"))); });\n');
  writeFileSync(path.join(repo, "ship", "marker.txt"), "here\n");
  const r = withArtifactRoot(repo, "ship")(["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.match(r.stdout, /PASS artifact-suite\s+1 tests green with ship\/ as the root/, r.stdout + r.stderr);
});

test("a red suite under the artifact root is a FAIL, and names where to read it", () => {
  const { repo, work } = fixture();
  mkdirSync(path.join(repo, "ship"), { recursive: true });
  writeFileSync(path.join(repo, "ship", "a.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => assert.equal(1, 2));\n');
  const r = withArtifactRoot(repo, "ship")(["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.match(r.stdout, /FAIL artifact-suite/, r.stdout + r.stderr);
});

test("a named root with no node tests is a SKIP, not a failure of the repository under review", () => {
  // The key can only be set in the reviewing USER's global config — it is not
  // in REPO_ADDITIVE — so the named directory may belong to a project that
  // never asked for this, or to one whose suite is pytest or go test. SKILL.md
  // §1 tells the lead to fix what pre-flight fails before spending reviewers,
  // and a FAIL here would send it to fix a failure that is not the repo's.
  const { repo, work } = fixture();
  mkdirSync(path.join(repo, "ship"), { recursive: true });
  writeFileSync(path.join(repo, "ship", "test_thing.py"), "def test_thing():\n    assert True\n");
  const r = withArtifactRoot(repo, "ship")(["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.match(r.stdout, /SKIP artifact-suite\s+no \*\.test\.mjs under ship\//, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /FAIL artifact-suite/);
});

test("no artifactRoot means the check does not run at all", () => {
  const { repo, work } = fixture();
  const r = withArtifactRoot(repo, "")(["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.doesNotMatch(r.stdout, /artifact-suite/, r.stdout + r.stderr);
});

test("every check failing to start in the copy falls back to the checkout and names the cause", () => {
  // All-INFRA is the staging failure discovered one step later: the reviewers
  // still need a real verdict on the code, and the checkout is where the checks
  // are known to run. It must also say WHICH of the two happened — "the stage is
  // broken for this project" is a defect in this plugin and "your suite is red"
  // is not, and a report that lets the lead confuse them is worse than silent.
  const { repo, work } = fixture();
  // A shebang naming an interpreter that does not exist: the shell answers 127,
  // which is exactly "this never ran" and needs no per-tool knowledge to read.
  writeFileSync(path.join(repo, "test.sh"), "#!/nonexistent/interpreter\necho unreachable\n");
  chmodSync(path.join(repo, "test.sh"), 0o755);

  const done = run(repo, ["--work", work, "--round", "1", "--intent", path.join(work, "intent.md")]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /no check could start in the install copy — a defect in this plugin's staging/, done.stderr);
  assert.ok(existsSync(path.join(work, "round-1", "preflight-stage.txt")),
    "the copy's own report is kept: it is the evidence for the plugin defect");
  assert.match(done.stdout, /INFRA staging {2}no check could start in the install copy/, done.stdout);
  // The header names where the verdicts under it came from. Rewriting
  // preflight.txt from the checkout without moving `pf_from` printed the stage's
  // path over the checkout's verdicts, contradicting the INFRA line four rows
  // below it in the same block.
  // `repo` is under /var, which macOS resolves to /private/var, so the header is
  // matched by its tail rather than by the string this test holds.
  assert.match(done.stdout, /pre-flight \(from .*\/repo\):/,
    "the fallback reran from the checkout, so the header must say the checkout");
  assert.doesNotMatch(done.stdout, /pre-flight \(from .*cold run/, done.stdout);
});

test("the tripwire is silent when pre-flight ran from the checkout, where there is no link", () => {
  // Staging failed, so `pf_from` IS the checkout and pre-flight is running the
  // project's own checks in the project's own tree. A suite touching its own
  // node_modules there crossed no staged link — reporting it would put a false
  // alarm in the one line of this block that is about the REVIEW rather than
  // about the code, and would name a mechanism that did not happen.
  const { repo, work } = fixture();
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "marker.txt"), "before\n");
  writeFileSync(path.join(repo, "test.sh"),
    '#!/bin/sh\necho "touching its own tree"\necho after > node_modules/marker.txt\n');
  chmodSync(path.join(repo, "test.sh"), 0o755);
  const round = shadowRound(work, { "coldrun.sh": "#!/bin/sh\necho 'no disk' >&2\nexit 2\n" });

  const done = spawnSync("bash", [round, "--work", work, "--round", "1", "--intent", path.join(work, "intent.md")],
    { cwd: repo, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /could not stage the install copy/, "the staging-failure path is the one under test");
  assert.doesNotMatch(done.stdout, /TRIP/,
    `no link was crossed, so there is nothing to report:\n${done.stdout}`);
});

// --- D1: one work dir per review (docs/design-notes/questions/review-identity-answer.md)
// A session's reviews used to share one work dir: review 3 opened at "round 7",
// got no pre-flight, a tapered finder plan, a tier ceiling from an unrelated
// change, and a converge that said STOP from its first look.

const newReview = (repo, base, intent, extra = []) =>
  run(repo, ["--new-review", "--work", base, "--intent", intent, "--no-preflight", ...extra]);
const workLine = (done) => /^work: (.+)$/.exec(done.stdout.split("\n")[0])?.[1];

/** Every file under `dir` with its bytes, so "left untouched" is a comparison. */
const snapshot = (dir) => Object.fromEntries(
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, file), readFileSync(file, "utf8")];
    }));

test("D1: each --new-review allocates its own review dir with its own round 1, and says where", () => {
  const { repo, work } = fixture();
  mkdirSync(path.join(work, "ticket"));
  writeFileSync(path.join(work, "ticket", "verdict.json"), "{}\n");

  const first = newReview(repo, work, path.join(work, "intent.md"));
  assert.equal(first.status, 0, first.stderr);
  const one = workLine(first);
  assert.ok(one && path.isAbsolute(one), `the first stdout line names the review dir:\n${first.stdout}`);
  assert.equal(realpathSync(one), realpathSync(path.join(work, "review-1")));
  assert.ok(existsSync(path.join(one, "round-1", "briefs")), "round 1 ran inside it");
  assert.equal(existsSync(path.join(work, "round-1")), false, "and nothing ran in the base");

  // The base intent belongs to the review that consumed it; review 2 must not
  // brief its finders against review 1's ticket.
  assert.equal(readFileSync(path.join(one, "intent.md"), "utf8"), "intent\n");
  assert.equal(existsSync(path.join(work, "intent.md")), false, "the base intent.md is moved, not copied");
  assert.ok(existsSync(path.join(one, "ticket", "verdict.json")), "and the ticket's paperwork goes with it");
  assert.equal(existsSync(path.join(work, "ticket")), false);

  const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), "round-intent-")), "intent.md");
  writeFileSync(elsewhere, "second intent\n");
  const second = newReview(repo, work, elsewhere);
  assert.equal(second.status, 0, second.stderr);
  const two = workLine(second);
  assert.equal(realpathSync(two), realpathSync(path.join(work, "review-2")));
  assert.ok(existsSync(path.join(two, "round-1", "briefs")), "review 2 has a round 1 of its own");
  assert.equal(readFileSync(path.join(two, "intent.md"), "utf8"), "second intent\n");
  assert.equal(readFileSync(elsewhere, "utf8"), "second intent\n", "an intent from outside the base is copied and left");
});

test("D1: a review whose round 1 failed keeps the base intent, so the retry can use it", () => {
  // The intent moves only once the round it briefs exists: a round refused for
  // its scope (paperwork, an empty scope) would otherwise strand the ticket in
  // a review that never ran, and the retry would die on a missing intent.
  const { repo, work } = fixture();
  const empty = newReview(repo, work, path.join(work, "intent.md"), ["src/nothing-here.mjs"]);
  assert.equal(empty.status, 4, empty.stderr);
  assert.equal(readFileSync(path.join(work, "intent.md"), "utf8"), "intent\n", "the base intent is still there");

  const retry = newReview(repo, work, path.join(work, "intent.md"));
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(existsSync(path.join(work, "intent.md")), false);
});

test("D1: the allocator takes the next free number and writes nothing into the reviews before it", () => {
  const { repo, work } = fixture();
  for (const k of [1, 2]) {
    mkdirSync(path.join(work, `review-${k}`, "round-1"), { recursive: true });
    writeFileSync(path.join(work, `review-${k}`, "round-1", "tier.json"), `{"k":${k}}\n`);
  }
  const before = snapshot(work);
  const done = newReview(repo, work, path.join(work, "intent.md"));
  assert.equal(done.status, 0, done.stderr);
  assert.equal(realpathSync(workLine(done)), realpathSync(path.join(work, "review-3")));
  for (const k of [1, 2]) {
    const prefix = `review-${k}${path.sep}`;
    const kept = (tree) => Object.entries(tree).filter(([file]) => file.startsWith(prefix));
    assert.deepEqual(kept(snapshot(work)), kept(before), `review-${k} is untouched`);
  }
});

test("D1: a review's later rounds are capped by its own round 1, not by an earlier review's", () => {
  const { repo, work } = fixture();
  const first = newReview(repo, work, path.join(work, "intent.md"), ["--force", "L", "--reason", "an earlier, bigger change"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(tierOf(workLine(first), 1).tier, "L");

  const intent = path.join(workLine(first), "intent.md");
  const second = newReview(repo, work, intent);
  assert.equal(second.status, 0, second.stderr);
  const two = workLine(second);
  assert.equal(tierOf(two, 1).tier, "S");

  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(path.join(repo, "test/cli.test.mjs"), Array.from({ length: 24 }, (_, i) => `// test line ${i}`).join("\n"));
  const again = run(repo, ["--work", two, "--round", "2", "--intent", intent, "--no-preflight"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(tierOf(two, 2).tier, "S", "held at review 2's round 1, not lifted to review 1's L");
});

test("D1: round numbers are the script's, not the lead's to reuse", () => {
  const { repo, work } = fixture();
  const intent = path.join(work, "intent.md");
  assert.equal(run(repo, ["--work", work, "--round", "1", "--intent", intent, "--no-preflight"]).status, 0,
    "a fresh dir with --round 1 still works: the evals and the fallback path depend on it");

  const before = snapshot(work);
  const reused = run(repo, ["--work", work, "--round", "1", "--intent", intent, "--no-preflight"]);
  assert.equal(reused.status, 2, "a second round 1 in one work dir is a second review");
  assert.match(reused.stderr, /--new-review/, "and the refusal names the way to start one");
  assert.deepEqual(snapshot(work), before, "refused before it writes a byte");

  const skipped = run(repo, ["--work", work, "--round", "3", "--intent", intent, "--no-preflight"]);
  assert.equal(skipped.status, 2, "round 3 needs a round 2");
  assert.match(skipped.stderr, /round-2\/tier\.json/);

  const both = newReview(repo, work, intent, ["--round", "1"]);
  assert.equal(both.status, 2, "--new-review is round 1 by definition");
  assert.equal(existsSync(path.join(work, "review-1")), false, "and a usage error allocates nothing");
});

// --- D2: the stopping rule's verdict is printed where the next round starts
// `findings.mjs converge` ran in 7 of 46 measured reviews. round.sh now runs it
// for the round just finished and prints the verdict above the Agent-call table,
// with no new obligation and no change to its exit code.

/** A review whose round 1 ran, with `records` recorded per round number. */
const reviewWithRecords = (records) => {
  const { repo, work } = fixture();
  const done = newReview(repo, work, path.join(work, "intent.md"));
  assert.equal(done.status, 0, done.stderr);
  const review = workLine(done);
  for (const [round, entries] of Object.entries(records)) {
    const rec = spawnSync(process.execPath, [FINDINGS, "record", "--work", review, "--round", round, "--repo", repo],
      { input: JSON.stringify(entries), encoding: "utf8", cwd: repo });
    assert.equal(rec.status, 0, rec.stderr);
  }
  return { repo, review, intent: path.join(review, "intent.md") };
};
const finding = (severity) => ({
  verdict: "fixed", file: "src/cli.mjs", line: 1, severity, class: "correctness",
  angle: "A", summary: `a ${severity} finding`, mechanism: "m", proof: "p",
});
/** A round-2 plan written by hand, so round 3 can be asked for. */
const planRound2 = (review, roundsCap) => {
  mkdirSync(path.join(review, "round-2"), { recursive: true });
  writeFileSync(path.join(review, "round-2", "tier.json"), JSON.stringify({ tier: "S", round: 2, roundsCap }));
};
const verdictAboveTable = (done, pattern) => {
  assert.equal(done.status, 0, done.stderr);
  const lines = done.stdout.split("\n");
  const at = lines.findIndex((line) => pattern.test(line));
  assert.ok(at >= 0, `the verdict is printed:\n${done.stdout}`);
  assert.ok(at < lines.findIndex((line) => /^tier /.test(line)), `above the plan:\n${done.stdout}`);
};

test("D2: round 2 prints converge's verdict on round 1 — CONTINUE", () => {
  const { repo, review, intent } = reviewWithRecords({ 1: [finding("major")] });
  const done = run(repo, ["--work", review, "--round", "2", "--intent", intent, "--no-preflight"]);
  verdictAboveTable(done, /^converge \(round 1\): CONTINUE — round 1 is the first change-round/);
});

test("D2: round 3 prints converge's verdict on round 2 — ESCALATE on a plateau", () => {
  const { repo, review, intent } = reviewWithRecords({ 1: [finding("major")], 2: [finding("major")] });
  planRound2(review, 6);
  const done = run(repo, ["--work", review, "--round", "3", "--intent", intent, "--no-preflight"]);
  verdictAboveTable(done, /^converge \(round 2\): ESCALATE — /);
});

test("D2: round 3 prints converge's verdict on round 2 — STOP on a spent budget", () => {
  const { repo, review, intent } = reviewWithRecords({ 1: [finding("major"), finding("major")], 2: [finding("minor")] });
  planRound2(review, 2);
  const done = run(repo, ["--work", review, "--round", "3", "--intent", intent, "--no-preflight"]);
  verdictAboveTable(done, /^converge \(round 2\): STOP — /);
});

test("D2: with no records for the round just finished, it says W cannot be computed", () => {
  const { repo, review, intent } = reviewWithRecords({});
  const done = run(repo, ["--work", review, "--round", "2", "--intent", intent, "--no-preflight"]);
  verdictAboveTable(done, /^converge: no records for round 1 — W cannot be computed$/);
  assert.doesNotMatch(done.stdout, /CONTINUE|ESCALATE|STOP/, "and no verdict it could not compute");
});
