// Run: node --test plugin/scripts/retro.test.mjs   (or ./test.sh for everything)
//
// The three promises the retro makes in plain words — the signals table carries
// no names, the lint refuses what it can know is the user's, and the selector
// puts a write outside the project in front of the model — each held to a
// fixture that would break it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { field, header } from "../hooks/lib/frontmatter.mjs";
import { CONVERGE_VERDICTS, GATE_RULES, angleTokens, destructiveGit, isTempCwd, lint, outsideDeletion, periodOf, rank, watchedNames } from "./retro.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "retro.mjs");
const HOME = homedir();
const DAY = 86_400_000;
// Every string a leak would carry. None of them may reach `signals`, whatever field holds it.
const SENTINEL = "zqxsentinel";
const CWD = path.join(HOME, `${SENTINEL}-project`);
const SESSION = "0a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a5b";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const human = (ts, text) => ({ type: "user", timestamp: ts, cwd: CWD, sessionId: SESSION, message: { role: "user", content: text } });
const said = (ts, content) => ({ type: "assistant", timestamp: ts, cwd: CWD, sessionId: SESSION, message: { role: "assistant", model: "claude-opus-5-5", content } });
const bash = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const result = (ts, id, text) => ({ type: "user", timestamp: ts, cwd: CWD, sessionId: SESSION, toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const gateBlock = (ts) => ({ type: "user", timestamp: ts, cwd: CWD, isMeta: true, message: { role: "user", content: `Stop hook feedback:\n[self-review-gate] Files changed this turn but no marker (${SENTINEL})` } });

/**
 * One user's machine in miniature: a plugin session that spawned a finder, was
 * blocked twice in one turn, and then removed something under ~/.config; the
 * log rows that session wrote, with sentinels in every free-text field and in
 * every enum field a careless table would print as a key.
 */
function machine({ reviewerGit = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "retro-"));
  const projects = path.join(root, "projects"), logDir = path.join(root, "log"), project = path.join(projects, `-${SENTINEL}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(logDir, "gate"), { recursive: true });
  mkdirSync(path.join(logDir, "findings"), { recursive: true });
  const t = (n) => iso(2 * DAY - n * 60_000);
  writeFileSync(path.join(project, `${SESSION}.jsonl`), jsonl([
    { ...human(t(0), `fix the ${SENTINEL} widget`), version: `2.1.300-${SENTINEL}` },
    said(t(1), [{ type: "tool_use", id: "s1", name: "Agent", input: { subagent_type: "self-review:self-review-finder", name: "self-review-finder-a-r1", prompt: SENTINEL } }]),
    said(t(2), [bash("b1", `"${HOME}/x/scripts/wait.mjs" --work /w --round 1 self-review-finder-a-r1`)]),
    result(t(3), "b1", "self-review-finder-a-r1 active (no transcript)"),
    gateBlock(t(4)),
    gateBlock(t(5)),
    { ...said(t(5), [{ type: "text", text: "ok" }]), message: { role: "assistant", model: `claude-opus-5-${SENTINEL}`, content: [{ type: "text", text: "ok" }] } },
    said(t(6), [bash("b2", `rm -rf ~/.config/${SENTINEL}app/store.jsonl`)]),
    result(t(7), "b2", ""),
  ]));
  if (reviewerGit) {
    const sub = path.join(project, SESSION, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "agent-aself-review-verifier-r1-0123456789abcdef.jsonl"), jsonl([
      { type: "user", timestamp: t(2), cwd: CWD, isSidechain: true, message: { role: "user", content: "verify" } },
      { type: "assistant", timestamp: t(3), cwd: CWD, isSidechain: true, message: { role: "assistant", content: [bash("v1", reviewerGit)] } },
    ]));
    writeFileSync(path.join(sub, "agent-aself-review-verifier-r1-0123456789abcdef.meta.json"), JSON.stringify({ spawnedAgentType: "self-review:self-review-verifier" }));
  }
  writeFileSync(path.join(logDir, "log.jsonl"), jsonl([
    { ts: t(8), cwd: CWD, outcome: "not-converged", rounds: 2, fixed: 1, dismissed: 0, open: 1, intent: "author", note: `${SENTINEL} note`, summary: "outcome=not-converged rounds=2 fixed=1 dismissed=0 open=1 intent=author" },
    { ts: t(9), cwd: CWD, outcome: "not-converged", reason: "stall", rounds: 2, fixed: 0, dismissed: 0, open: 0, intent: "author", summary: "outcome=not-converged rounds=2 fixed=0 dismissed=0 open=0 reason=stall intent=author" },
    { ts: t(10), cwd: CWD, outcome: "not-applicable", reason: `${SENTINEL}-reason`, summary: "outcome=not-applicable" },
    { ts: t(11), cwd: CWD, kind: "wait", ended: `${SENTINEL} ended`, waitedMs: 1000, review: SENTINEL },
    // Shaped like a real value, which is why shape is not the test.
    { ts: t(11), cwd: CWD, kind: "wait", ended: `${SENTINEL}-project`, waitedMs: 1000 },
    { ts: t(12), cwd: CWD, kind: "converge", verdict: SENTINEL.toUpperCase(), review: SENTINEL },
    // The test suite's own rows land here from temp dirs; they are not the user's work.
    { ts: t(13), cwd: path.join(tmpdir(), "suite-run"), outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, intent: "author", summary: "outcome=converged rounds=1" },
  ]));
  writeFileSync(path.join(logDir, "gate", "2026-10.jsonl"), jsonl([
    { ts: t(4), cwd: CWD, session: SESSION, rule: "block:unmarked", version: "0.10.2", decision: "block" },
    { ts: t(5), cwd: CWD, session: SESSION, rule: `block:${SENTINEL}`, version: `0.10.2-${SENTINEL}`, decision: "block" },
  ]));
  writeFileSync(path.join(logDir, "findings", "r.jsonl"), jsonl([
    { ts: t(6), review: `${SENTINEL}/review-1@abc`, round: 1, angle: `${SENTINEL}`, class: "correctness", severity: "minor", verdict: "dismissed", file: `${SENTINEL}.ts`, line: 1, summary: SENTINEL },
    { ts: t(6), review: `${SENTINEL}/review-1@abc`, round: 1, angle: "A", class: "correctness", severity: "major", verdict: "fixed", file: "a.ts", line: 1, summary: SENTINEL },
    { ts: t(7), review: `${SENTINEL}/review-1@abc`, round: 2, angle: "A", class: "correctness", severity: "major", verdict: "fixed", file: "a.ts", line: 2, summary: SENTINEL },
  ]));
  const settings = path.join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30 }));
  // A trailing object is extra environment for that one run.
  const run = (...args) => {
    const env = typeof args.at(-1) === "object" ? args.pop() : {};
    return spawnSync(process.execPath, [SCRIPT, ...args],
      { encoding: "utf8", env: { ...process.env, SELF_REVIEW_PROJECTS_DIR: projects, SELF_REVIEW_LOG_DIR: logDir, SELF_REVIEW_SETTINGS: settings, SELF_REVIEW_RETRO_DIR: path.join(logDir, "retro"), ...env } });
  };
  return { root, run };
}

test("signals carries no cwd, session, note or free text, whichever field held it", () => {
  const { run } = machine();
  const out = run("signals", "7");
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, new RegExp(SENTINEL, "i"));
  assert.ok(!out.stdout.includes(SESSION) && !out.stdout.includes(HOME), out.stdout);
  // ...and it still counts what it saw, with the leaked labels folded into `other`.
  assert.match(out.stdout, /^outcomes\.not-converged 2$/m);
  assert.match(out.stdout, /^gate\.rules\.other 1$/m);
  assert.match(out.stdout, /^environment\.pluginVersions\.other 1$/m);
  assert.match(out.stdout, /^dismissedByAngle\.other 1\/1$/m);
  assert.match(out.stdout, /^dismissedByAngle\.A 0\/2$/m);
  assert.match(out.stdout, /^refiled\.refiled 1$/m, "round 2 filed round 1's fix again");
});

test("signals counts each angle of a group under its own name, and only an unknown token as other", () => {
  const { root, run } = machine();
  const row = (angle) => ({ ts: iso(2 * DAY - 6 * 60_000), review: `${SENTINEL}/review-1@abc`, round: 1, angle, class: "correctness", severity: "minor", verdict: "fixed", file: "a.ts", line: 1, summary: SENTINEL });
  writeFileSync(path.join(root, "log", "findings", "r.jsonl"), jsonl([row("P1"), row("compact"), row("A+B"), row(`${SENTINEL.toUpperCase()}+A`)]));
  const out = run("signals", "7").stdout;
  assert.doesNotMatch(out, new RegExp(SENTINEL, "i"));
  assert.match(out, /^dismissedByAngle\.P1 0\/1$/m);
  assert.match(out, /^dismissedByAngle\.compact 0\/1$/m);
  assert.match(out, /^dismissedByAngle\.A 0\/2$/m);
  assert.match(out, /^dismissedByAngle\.B 0\/1$/m);
  assert.match(out, /^dismissedByAngle\.other 0\/1$/m);
});

test("the vocabularies signals prints are the writers' own, so a new rule is not silently `other`", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gate = readFileSync(path.join(here, "..", "hooks", "self-review-gate.mjs"), "utf8");
  const written = [...new Set([...gate.matchAll(/rule: "((?:block|pass|release):[a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(written.length >= 20, `the gate's rules were not found: ${written}`);
  assert.deepEqual(written.filter((rule) => !GATE_RULES.includes(rule)), []);
  const findings = readFileSync(path.join(here, "findings.mjs"), "utf8");
  const verdicts = [...findings.matchAll(/verdict: ([^,\n]*)/g)].flatMap((m) => [...m[1].matchAll(/"([A-Z]+)"/g)].map((v) => v[1]));
  assert.ok(verdicts.length >= 5, `findings.mjs's verdicts were not found: ${verdicts}`);
  assert.deepEqual(verdicts.filter((v) => !CONVERGE_VERDICTS.includes(v)), []);
});

test("signals counts not-converged reasons, with rows from before the field as their own bucket", () => {
  const out = machine().run("signals", "7").stdout;
  assert.match(out, /^notConvergedReasons\.unrecorded 1$/m);
  assert.match(out, /^notConvergedReasons\.stall 1$/m);
  assert.match(out, /^notApplicableReasons\.other 1$/m, "a reason outside the vocabulary is other, never printed");
});

test("signals reads a file-form marker's reason from its summary, not as unrecorded", () => {
  const { root, run } = machine();
  const log = path.join(root, "log", "log.jsonl");
  writeFileSync(log, readFileSync(log, "utf8") + jsonl([
    { ts: iso(2 * DAY - 14 * 60_000), cwd: CWD, summary: "outcome=not-converged rounds=2 fixed=1 dismissed=0 open=0 reason=stall tier=M intent=author", marker: "file" },
  ]));
  const out = run("signals", "7").stdout;
  assert.match(out, /^notConvergedReasons\.stall 2$/m);
  assert.match(out, /^notConvergedReasons\.unrecorded 1$/m);
});

test("signals drops the rows the test suite wrote from a temp dir", () => {
  assert.doesNotMatch(machine().run("signals", "7").stdout, /^outcomes\.converged /m);
});

test("signals reports the gate re-blocking twice in one turn, and the version it ran", () => {
  const out = machine().run("signals", "7").stdout;
  assert.match(out, /^gate\.reBlockTurns 1$/m);
  assert.match(out, /^environment\.pluginVersions\.0\.10\.2 1$/m);
  assert.match(out, /^self-review retro signals v1$/m, "the format is versioned, so tables from different reports can be added up");
});

test("episodes puts the lead's deletion outside the project first, and writes each window to a file", () => {
  const { run } = machine();
  const result = run("episodes", "7");
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").filter((l) => /^\d+\t/.test(l));
  assert.match(rows[0], /^1\toutside-write/);
  assert.ok(rows.some((r) => /re-block/.test(r)), result.stdout);
  assert.match(readFileSync(rows[0].split("\t").at(-1), "utf8"), /rm -rf ~\/\.config\//);
});

test("episodes finds a reviewer discarding work in the real checkout from its own transcript", () => {
  const { run } = machine({ reviewerGit: `cd ${CWD} && git checkout -- .` });
  const rows = run("episodes", "7").stdout.split("\n").filter((l) => /^\d+\t/.test(l));
  const reviewer = rows.findIndex((r) => /outside-write/.test(r) && readFileSync(r.split("\t").at(-1), "utf8").includes("a reviewer's own transcript"));
  assert.ok(reviewer !== -1 && reviewer < 2, rows.join("\n"));
});

// ---------- the period ----------

test("period: the default is the user's transcript retention when there is no earlier retro", () => {
  const root = mkdtempSync(path.join(tmpdir(), "retro-p-"));
  const settings = path.join(root, "s.json");
  writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 7 }));
  const p = periodOf({ settings, retroDir: path.join(root, "none"), projects: path.join(root, "none") });
  assert.deepEqual([p.days, p.basis, p.retentionDays], [7, "retention", 7]);
  const unset = periodOf({ settings: path.join(root, "missing.json"), retroDir: root, projects: root });
  assert.deepEqual([unset.days, unset.retentionDays], [30, 30], "Claude Code's default applies without a setting");
});

test("period: since the last retro when that is shorter, and a draft from today is not the last retro", () => {
  const root = mkdtempSync(path.join(tmpdir(), "retro-p-"));
  const now = Date.parse("2026-10-23T12:00:00Z");
  writeFileSync(path.join(root, "2026-10-20.md"), "");
  writeFileSync(path.join(root, "2026-10-23.md"), "");
  const p = periodOf({ now, settings: path.join(root, "x"), retroDir: root, projects: root });
  assert.deepEqual([p.basis, p.lastRetro, p.since.slice(0, 10)], ["last-retro", "2026-10-20", "2026-10-20"]);
  assert.equal(periodOf({ days: 90, now, settings: path.join(root, "x"), retroDir: root, projects: root }).basis, "requested");
});

test("period: a period reaching past the oldest surviving transcript says so", () => {
  const root = mkdtempSync(path.join(tmpdir(), "retro-p-"));
  mkdirSync(path.join(root, "p"));
  const file = path.join(root, "p", "s.jsonl");
  writeFileSync(file, "{}\n");
  const p = periodOf({ days: 365, settings: path.join(root, "x"), retroDir: root, projects: root });
  assert.equal(p.missingBefore, new Date().toISOString().slice(0, 10));
  utimesSync(file, new Date(Date.now() - 400 * DAY), new Date(Date.now() - 400 * DAY));
  assert.equal(periodOf({ days: 1, settings: path.join(root, "x"), retroDir: root, projects: root }).missingBefore, null);
});

// ---------- outside-write, rule (a) ----------

test("rule (a): a deletion under the home directory and outside the project is flagged", () => {
  const ctx = { cwd: "/home/u/proj", home: "/home/u" };
  assert.equal(outsideDeletion("rm -rf ~/.config/app/store.jsonl", ctx), "/home/u/.config/app/store.jsonl");
  assert.equal(outsideDeletion('rmdir "$HOME/.config/app"', ctx), "/home/u/.config/app");
  assert.equal(outsideDeletion("cd ~/other && rm notes.txt", ctx), "/home/u/other/notes.txt", "a relative path follows the cd");
  assert.equal(outsideDeletion("unlink /home/u/Documents/x", ctx), "/home/u/Documents/x");
});

test("rule (a): the project, scratch, ~/.claude, a variable and a move's destination are not", () => {
  const ctx = { cwd: "/home/u/proj", home: "/home/u" };
  for (const command of ["rm -rf build/", "rm /home/u/proj/a.ts", "rm -rf ~/.claude/self-review/x", "rm /tmp/x /private/tmp/y /var/folders/z",
    'rm -rf "$W/round-1"', "mv a.ts ~/.Trash/a.ts", "rm /etc/hosts", "python3 - <<'EOF'\nimport os\nos.system('rm ~/x')\nrm ~/y\nEOF"]) {
    assert.equal(outsideDeletion(command, ctx), null, command);
  }
  assert.equal(outsideDeletion("mv ~/elsewhere/a.ts .", ctx), "/home/u/elsewhere/a.ts", "a move's source is removed from where it was");
});

// ---------- outside-write, rule (b) ----------

test("rule (b): a reviewer discarding work in the real checkout is flagged", () => {
  const ctx = { cwd: "/home/u/proj", home: "/home/u" };
  for (const command of ["git checkout -- .", "git checkout .", "git restore src/a.ts", "git stash", "git stash push -m x",
    "git clean -fd", "git reset --hard HEAD", "git -C /home/u/proj/sub reset --hard", "cd /home/u/proj/src && git checkout -- a.ts"]) {
    assert.equal(destructiveGit(command, ctx), true, command);
  }
});

test("rule (b): read-only forms, and a worktree or scratch copy outside the checkout, are not", () => {
  const ctx = { cwd: "/home/u/proj", home: "/home/u" };
  for (const command of ["git stash list", "git stash show -p", "git clean -n", "git clean -fdn", "git reset --soft HEAD~1", "git checkout main",
    "git -C /tmp/wt reset --hard", "cd /tmp/copy && git checkout -- .", "git status"]) {
    assert.equal(destructiveGit(command, ctx), false, command);
  }
});

test("rule (b): restore discards the worktree, not the index alone", () => {
  const ctx = { cwd: "/Users/h/p" };
  assert.equal(destructiveGit("git restore --staged a", ctx), false);
  assert.equal(destructiveGit("git restore -S a", ctx), false);
  assert.equal(destructiveGit("git restore a", ctx), true);
  assert.equal(destructiveGit("git restore --staged --worktree a", ctx), true);
});

test("rule (b): a reviewer's git is resolved from the directory it ran in", () => {
  assert.equal(destructiveGit("git reset --hard", { cwd: "/Users/h/p", start: "/Users/h/wt" }), false);
  assert.equal(destructiveGit("git reset --hard", { cwd: "/Users/h/p", start: "/Users/h/p/sub" }), true);
  assert.equal(destructiveGit("git reset --hard", { cwd: "/Users/h/p" }), true);
});

// ---------- the selector ----------

test("rank: outside-write is picked first, at most two, inside the cap, and two per session", () => {
  const session = (n) => ({ file: `s${n}` });
  const ep = (type, s, idx, n = 1) => ({ type, session: session(s), source: { file: `s${s}`, turnOf: Array(100).fill(0).map((_, i) => i) }, idx, n });
  const eps = [ep("outside-write", 1, 1), ep("outside-write", 2, 1), ep("outside-write", 3, 1),
    ...Array.from({ length: 10 }, (_, i) => ep("re-block", 10 + i, 1, 8))];
  const { picked } = rank(eps, 4);
  assert.equal(picked.length, 4);
  assert.deepEqual(picked.slice(0, 2).map((p) => [...p.types]), [["outside-write"], ["outside-write"]]);
  assert.ok(picked.slice(2).every((p) => !p.types.has("outside-write")), "the third outside-write waits behind the cap of two");
  const crowded = rank(Array.from({ length: 5 }, (_, i) => ep("re-block", 1, i)), 8).picked;
  assert.equal(crowded.length, 2, "one session does not take the whole budget");
});

// ---------- check ----------

const watched = watchedNames([CWD, "/home/u/abc", "/home/u/scripts", "/home/u/Acme-Billing", "/home/u/.claude/plugins/cache/m/self-review/0.10.2", "/home/u/.claude/memory"], { home: "/home/u" });
const flagged = (text) => lint(text, watched).map((p) => p.clause);

test("check: a clean draft in plugin vocabulary passes", () => {
  const draft = [
    "# Field report", "", "## Signals", "", "```text", "self-review retro signals v1", "sessions 4", "```", "",
    "## Weaknesses", "", "### W1", "- **Mechanism:** `plugin/hooks/self-review-gate.mjs` decide()",
    "- **Symptom:** the gate blocked twice on a turn whose only change was a scratch file; see /self-review:retro and 3/8 episodes.",
  ].join("\n");
  assert.deepEqual(lint(draft, watched), []);
});

test("check: each clause fails its own fixture, with the line number", () => {
  const cases = [
    ["see /Users/someone/work/app.ts", "absolute path"],
    ["the store at ~/.config/app", "absolute path"],
    [`the repo ${CWD} again`, "a directory from your logs"],
    [`while working on ${SENTINEL.toUpperCase()}-PROJECT`, "a project name from your logs"],
    ["the acme-billing repo", "a project name from your logs"],
    [`session ${SESSION}`, "session id"],
    ["mail someone@example.com", "email address"],
    // Built at runtime: a literal token shape in a shipped file stops release.sh
    // at its credential audit, fixture or not.
    [`key ghp_${"abcdef".repeat(6)}`, "token shape"],
    ["```js", "code fence outside the signals block"],
    ["- **Mechanism:** `plugin/scripts/no-such-file.mjs`", "plugin path that does not exist"],
    ["- **Mechanism:** the gate", "Mechanism names no plugin/ path"],
  ];
  for (const [line, clause] of cases) {
    const problems = lint(`## Weaknesses\n\n${line}\n`, watched);
    assert.ok(problems.some((p) => p.clause === clause && p.line === 3), `${line} → ${JSON.stringify(problems)}`);
  }
});

test("check: a plugin/ path that climbs out with .. is refused even when its target exists", () => {
  const clauses = (text) => lint(text).map((p) => p.clause);
  assert.ok(clauses("- **Mechanism:** `plugin/scripts/../scripts/retro.mjs`").includes("plugin path that does not exist"));
  assert.ok(clauses("- **Mechanism:** `plugin/../../../../tmp`").includes("plugin path that does not exist"));
  assert.ok(!clauses("- **Mechanism:** `plugin/scripts/retro.mjs`").includes("plugin path that does not exist"));
});

test("check: a token prefix must start a token, not sit inside a hyphenated word", () => {
  const tokenShape = (text) => lint(text).some((p) => p.clause === "token shape");
  assert.equal(tokenShape("the risk-paths-config was ignored"), false);
  assert.equal(tokenShape("task-driven-development flow"), false);
  assert.equal(tokenShape("key=sk-abcdefghijklmnop"), true);
  assert.equal(tokenShape("token ghp_abcdefghijklmnop1234"), true);
});

test("check: a version is not an email, and a real address is", () => {
  const email = (text) => lint(text).some((p) => p.clause === "email address");
  assert.equal(email("self-review@0.10.2"), false);
  assert.equal(email("jo@acme.io"), true);
  assert.equal(email("a.b@mail.example.co.uk"), true);
});

test("check: payment keys, bearer tokens and secret assignments are token shapes", () => {
  const tokenShape = (text) => lint(text).some((p) => p.clause === "token shape");
  for (const text of ["sk_live_abcdefghijklmnop1234", "Bearer eyJhbGciOiJIUzI1NiJ9xx", "password=hunter2hunter2", "API_KEY: abcdefgh1234"]) {
    assert.equal(tokenShape(text), true, text);
  }
  for (const text of ["the token shape clause", "password is required"]) assert.equal(tokenShape(text), false, text);
  assert.ok(lint("password=hunter2hunter2").every((p) => !p.what.includes("hunter2")), "only the first 4 characters are printed");
});

test("check: quoted keys, suffixed names and Basic auth are token shapes, and the value is never printed", () => {
  const cases = [
    ['"password": "hunter2hunter2"', "hunter2hunter2"],
    ['"token": "abcdefghijklmnopqr"', "abcdefghijklmnopqr"],
    ["SECRET_KEY=abcdefghijklmnop", "abcdefghijklmnop"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1", "dXNlcjpwYXNzd29yZDEyMzQ1"],
  ];
  for (const [text, value] of cases) {
    const problems = lint(text);
    assert.ok(problems.some((p) => p.clause === "token shape"), text);
    assert.ok(problems.every((p) => !p.what.includes(value)), text);
  }
  for (const text of ["password is required", "the token shape clause", "mainTokensP50 1234", "tokens: 15000"]) {
    assert.equal(lint(text).some((p) => p.clause === "token shape"), false, text);
  }
});

test("check: a URL is refused unless it is the plugin's repo or Claude Code's", () => {
  const url = (text) => lint(text).some((p) => p.clause === "url");
  for (const text of ["https://github.com/clientco/secret-repo/pull/3", "https://ci.acme.dev/build/9",
    "https://github.com/HoussemDjeghri/self-review-fork", "https://github.com/HoussemDjeghri/self-reviewer"]) {
    assert.equal(url(text), true, text);
  }
  for (const text of ["https://github.com/HoussemDjeghri/self-review", "https://github.com/HoussemDjeghri/self-review/issues/12",
    "https://github.com/anthropics/claude-code/issues/1#x"]) {
    assert.equal(url(text), false, text);
  }
  assert.deepEqual(lint("file:///etc/x").map((p) => p.clause), ["absolute path"], "reported once, as the absolute path");
});

test("check: an absolute path is caught wherever it starts, and a relative path or a URL is not", () => {
  const absolute = (text) => lint(text).some((p) => p.clause === "absolute path");
  for (const text of ["failed at:/Users/alice/clients/acme/app.js", "see x,/home/bob/work/secret.txt", "file:///Users/alice/acme/x",
    "C:/Users/alice/acme", "**/Users/alice/.config/acme/x**"]) {
    assert.equal(absolute(text), true, text);
  }
  for (const text of ["plugin/scripts/retro.mjs", "https://github.com/HoussemDjeghri/self-review/issues/new", "tiers S/M/L", "and/or"]) {
    assert.equal(absolute(text), false, text);
  }
});

test("check: the plugin's own paths under ~/.claude are vocabulary, and a project transcript path is not", () => {
  const absolute = (text) => lint(text).some((p) => p.clause === "absolute path");
  for (const text of ["reads ~/.claude/self-review/log.jsonl", "see ~/.claude/settings.json", "reads $HOME/.claude/self-review/log.jsonl",
    "see ${HOME}/.claude/settings.json", "${HOME}/.claude/settings.json", "${HOME}/.claude/self-review/log.jsonl"]) {
    assert.equal(absolute(text), false, text);
  }
  assert.equal(absolute("see ${HOME}/secretproj now"), true);
  assert.equal(absolute("~/.claude/projects/-Users-a-acme/x.jsonl"), true);
  assert.equal(absolute("~/.claude/settings.json.bak"), true, "exactly settings.json, not a name that starts with it");
});

test("check: the one fence allowed is a `text` block under ## Signals, and it must be the saved table", () => {
  const fences = (draft) => lint(draft).filter((p) => p.clause === "code fence outside the signals block").map((p) => p.line);
  assert.deepEqual(fences("## Signals and my notes\n\n```js\nx\n```\n"), [3, 5], "a heading that only starts with Signals is another section");
  assert.deepEqual(fences("## Signals\n\n```text\nsessions 4\n```\n\n```text\nmore\n```\n"), [7, 9], "a second block is not the signals block");
  assert.deepEqual(fences("## Signals\n\n```js\nx\n```\n"), [3, 5]);
  const saved = "self-review retro signals v1\nsessions 4\n";
  const draft = "## Signals\n\n```text\nself-review retro signals v1\nsessions 5\n```\n";
  assert.deepEqual(lint(draft, { signals: saved }).map((p) => [p.line, p.clause]), [[3, "signals block differs from signals.txt"]]);
  assert.deepEqual(lint(draft.replace("sessions 5", "sessions 4"), { signals: saved }), []);
});

test("check: the saved table is not linted for names, and the same words in prose still are", () => {
  const names = watchedNames(["/Users/x/sessions", "/Users/x/outcomes", "/Users/x/period"]);
  const table = "sessions 3\noutcomes.not-converged 2\nperiod.days 30";
  const draft = `## Signals\n\n\`\`\`text\n${table}\n\`\`\`\n`;
  assert.deepEqual(lint(draft, { ...names, signals: table }), []);
  const prose = lint(`${draft}\n## Weaknesses\nthe sessions and outcomes of the period\n`, { ...names, signals: table });
  assert.deepEqual([...new Set(prose.map((p) => [p.line, p.clause].join(" ")))], ["10 a project name from your logs"]);
});

test("check: no traversal through the plugin's own paths, and the harness's encoding of a cwd is watched", () => {
  const names = watchedNames(["/Users/x/Projects/acme-corp"]);
  const clauses = (text) => lint(text, names).map((p) => p.clause);
  assert.ok(clauses("see ~/.claude/self-review/../projects/a.jsonl").includes("absolute path"));
  assert.ok(clauses("dir -Users-x-Projects-acme-corp here").includes("a directory from your logs"));
  assert.deepEqual(clauses("~/.claude/self-review/log.jsonl"), []);
});

test("check: a path under a temp dir is refused, and the bare name of a temp-dir-only project is not watched", () => {
  assert.ok(lint("see /tmp/bigclient-app/x", { paths: [], names: [] }).some((p) => p.clause === "absolute path"));
  // The stated limit, pinned so a change to it is deliberate.
  assert.deepEqual(lint("the bigclient-app repo", { paths: [], names: [] }), []);
});

test("check: a watched name is caught inside compounds and across separators, and not inside a longer word", () => {
  const names = { paths: [], names: ["payments", "acme-billing", "Zephyr Core"] };
  const named = (text) => lint(text, names).some((p) => p.clause === "a project name from your logs");
  for (const text of ["the payments-service repo", "payments_service", "acme billing", "acme_billing-api", "zephyr-core thing"]) {
    assert.equal(named(text), true, text);
  }
  for (const text of ["paymentsX", "subpayments"]) assert.equal(named(text), false, text);
});

test("a temp prefix matches a directory, not a name that starts with it", () => {
  for (const cwd of ["/tmpwork/Acme", "/tmp-projects/x"]) assert.equal(isTempCwd(cwd), false, cwd);
  for (const cwd of ["/tmp/x", `${tmpdir()}/x`]) assert.equal(isTempCwd(cwd), true, cwd);
});

test("check: a draft with no Signals block fails once a table is saved, and passes as before when none is given", () => {
  const draft = "## Weaknesses\n- **Mechanism:** `plugin/scripts/retro.mjs`\n";
  assert.deepEqual(lint(draft, { signals: "self-review retro signals v1\n" }).map((p) => [p.line, p.clause]), [[1, "no Signals block"]]);
  assert.deepEqual(lint(draft), []);
});

test("check: the CLI fails closed when no signals table was saved", () => {
  const { root, run } = machine();
  mkdirSync(path.join(root, "log", "retro"), { recursive: true });
  writeFileSync(path.join(root, "log", "retro", "draft.md"), "## Weaknesses\n- **Mechanism:** `plugin/scripts/retro.mjs`\n");
  const refused = run("check", "draft.md");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /^line 0: no saved signals table: run signals --save first$/m);
});

test("signals --save prints the table and writes the same text to signals.txt", () => {
  const { root, run } = machine();
  const dir = path.join(root, "retro-out");
  const out = run("signals", "7", "--save", { SELF_REVIEW_RETRO_DIR: dir });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^self-review retro signals v1$/m);
  assert.equal(readFileSync(path.join(dir, "signals.txt"), "utf8"), out.stdout);
});

test("check: names of three characters or fewer, and names in the plugin's own tree, are not refused", () => {
  assert.deepEqual(flagged("the abc of it, and scripts/ under the plugin"), []);
  assert.deepEqual(flagged("self-review 0.10.2, and the memory it keeps"), [], "a version, and a session run inside ~/.claude, name no project");
});

test("check: the CLI exits 1 and names the lines, and 0 on a clean draft", () => {
  const { root, run } = machine();
  const table = run("signals", "7", "--save").stdout;
  const retro = path.join(root, "log", "retro");
  writeFileSync(path.join(retro, "bad.md"), `## Weaknesses\nworking in ${SENTINEL}-project today\n`);
  writeFileSync(path.join(retro, "good.md"), `## Signals\n\n\`\`\`text\n${table}\`\`\`\n\n## Weaknesses\n- **Mechanism:** \`plugin/scripts/retro.mjs\`\n`);
  const refused = run("check", "bad.md");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /^line 2: a project name from your logs/m);
  const passed = run("check", "good.md");
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /^clean$/m);
});

test("check: the CLI takes a draft's file name in the retro dir, never a path", () => {
  const { run } = machine();
  for (const arg of ["../x.md", "/etc/hosts", "sub/x.md"]) {
    const refused = run("check", arg);
    assert.equal(refused.status, 2, `${arg}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /^check reads drafts from .*; pass the file name \(e\.g\. 2026-10-23\.md\), got "/m);
  }
});

test("the CLI takes no option that names a directory", () => {
  const { run } = machine();
  const refused = run("signals", "--retro-dir", "/tmp/x");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /unknown option --retro-dir/);
});

test("the CLI refuses a period that is not a positive number of days", () => {
  const { run } = machine();
  assert.equal(run("signals", "0").status, 2);
  assert.equal(run("signals", "a-week").status, 2);
  assert.equal(run("nonsense").status, 2);
  const huge = run("signals", "99999999999");
  assert.equal(huge.status, 2);
  assert.match(huge.stderr, /days must be at most 36500/);
  assert.doesNotMatch(huge.stderr, /RangeError/);
});

test("the CLI refuses a --cap or --tokens that is not a positive integer", () => {
  const { run } = machine();
  assert.equal(run("episodes", "--cap", "abc").status, 2);
  assert.equal(run("episodes", "--tokens", "0").status, 2);
});

test("the CLI answers --help, and refuses an option it does not know without swallowing the next argument", () => {
  const { run } = machine();
  for (const flag of ["--help", "-h"]) {
    const help = run(flag);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage: retro\.mjs/);
  }
  const typo = run("signals", "--jsn");
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /--jsn/);
});

// ---------- the skill ----------

test("the retro skill runs only when the user types it, and is granted nothing that reaches the network", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const skill = readFileSync(path.join(here, "..", "skills", "retro", "SKILL.md"), "utf8");
  const head = header(skill);
  assert.equal(field(head, "disable-model-invocation"), "true", "a model-invocable retro would load into every session and could run unasked");
  const allowed = field(head, "allowed-tools") ?? "";
  assert.doesNotMatch(allowed, /WebFetch|WebSearch|\b(?:curl|wget|gh|nc|ssh|scp)\b/, allowed);
  // One grant and nothing else: no Write or Edit that could put excerpts somewhere unprompted.
  assert.equal(allowed, "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs *)");
  // The grant covers what the skill runs: every command it shows is retro.mjs.
  const commands = [...skill.matchAll(/^```bash\n([\s\S]*?)^```/gm)].flatMap((m) => m[1].split("\n").filter((l) => l.trim()));
  assert.ok(commands.length > 0, "the skill's bash blocks were not found");
  for (const line of commands) assert.ok(line.startsWith("node ${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs "), line);
});

test("the report template passes its own check once filled with plugin vocabulary", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const template = readFileSync(path.join(here, "..", "skills", "retro", "references", "template.md"), "utf8")
    .replaceAll("plugin/<path>", "plugin/scripts/retro.mjs");
  assert.deepEqual(lint(template, watched), []);
});

test("angleTokens: every spelling of a group in the logs counts per angle, and nothing else gets through", () => {
  assert.deepEqual(angleTokens("A+B"), ["A", "B"]);
  assert.deepEqual(angleTokens("AB"), ["A", "B"]);
  assert.deepEqual(angleTokens("K2K1"), ["K2", "K1"]);
  assert.deepEqual(angleTokens("qv"), ["Q", "V"]);
  assert.deepEqual(angleTokens("p2v"), ["P2", "V"]);
  assert.deepEqual(angleTokens("compact"), ["compact"]);
  assert.deepEqual(angleTokens("P1+mixed"), ["P1", "mixed"]);
  assert.deepEqual(angleTokens("ZQXSENTINEL+A"), ["other", "A"]);
  assert.deepEqual(angleTokens("acme-api"), ["other"]);
  assert.deepEqual(angleTokens("ACME"), ["other"]);
  assert.deepEqual(angleTokens("p"), ["other"]);
  assert.deepEqual(angleTokens(""), ["other"]);
  assert.deepEqual(angleTokens(undefined), ["other"]);
});
