// Run: node --test plugin/hooks/lib/engagement.test.mjs   (or ./test.sh)
//
// The audit that exists because tree-guard was inert for roughly ninety named
// finders while every review round read it and correctly found it correct. The
// defect was never in the code; it was in what the harness put in the payload,
// and only a record of what the guard actually matched can catch that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_ROOT } from "./config.mjs";
import { auditEngagement, engagementFile, engagementLine, noteEngagement, openEngagement, OURS } from "./engagement.mjs";

const logDir = () => mkdtempSync(path.join(tmpdir(), "engagement-"));
const rows = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("nothing is written until a round opens the log", () => {
  // The scoping rule: a project that never runs this loop pays nothing, and the
  // guard cannot be the thing that decides a review is in progress.
  const dir = logDir();
  assert.equal(noteEngagement("/repo", "self-review-finder-r1-ab", true, { session: "s1", logDir: dir }), null);
  assert.ok(!existsSync(engagementFile("/repo", dir)), "no log, no write");

  openEngagement("/repo", 1, { logDir: dir });
  assert.ok(noteEngagement("/repo", "self-review-finder-r1-ab", true, { session: "s1", logDir: dir }));
  assert.equal(rows(engagementFile("/repo", dir)).length, 2);
});

test("a different repository's log is a different file", () => {
  const dir = logDir();
  assert.notEqual(engagementFile("/repo/a", dir), engagementFile("/repo/b", dir));
  openEngagement("/repo/a", 1, { logDir: dir });
  assert.equal(noteEngagement("/repo/b", "self-review-finder-r1-ab", true, { session: "s1", logDir: dir }), null);
});

test("a write that cannot happen is silent — a hook must not hold a turn hostage", () => {
  // The log directory is a file, so mkdir/append both fail. The guard still
  // has to let the tool call through.
  assert.equal(noteEngagement("/repo", "x", true, { logDir: "/dev/null/nope" }), null);
});

const log = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const round = (n) => ({ ts: "2026-09-03T10:00:00.000Z", kind: "round", round: n });
// A row as tree-guard writes one. `session` is what the harness attributed the
// call to; a row without it was written by something running the hook by hand,
// and the audit keeps it but does not count it as evidence.
const agent = (agentType, matched, session = "sess-1") =>
  ({ ts: "2026-09-03T10:01:00.000Z", kind: "agent", agentType, matched, session });

test("a name this plugin generated that the guard did not match is the finding", () => {
  // Exactly F10h: the harness replaced `agent_type` with the agent's NAME, and
  // `self-review-finder-r1-gqv` stopped matching a regex anchored at `$`.
  const audit = auditEngagement(log(round(1), agent("self-review-finder-r1-gqv", false), agent("self-review-finder-r1-ab", false)));
  assert.deepEqual(audit.unmatched, ["self-review-finder-r1-gqv", "self-review-finder-r1-ab"]);
  assert.match(engagementLine(audit), /did NOT match 2 name/);
  assert.match(engagementLine(audit), /gone inert/);
});

test("a round in which the guard matched nothing at all is the same defect from the other side", () => {
  // The names here are not ones this plugin generates, so the first clause is
  // silent — and this is the clause that would have caught F10h anyway.
  const audit = auditEngagement(log(round(1), agent("r1-gqv", false), agent("r1-ab", false)));
  assert.deepEqual(audit.unmatched, []);
  assert.equal(audit.blind, true);
  assert.match(engagementLine(audit), /matched none of the 2 subagent shell calls/);
});

test("a round the guard watched says so, and one with nothing to watch says nothing", () => {
  const watched = auditEngagement(log(round(1), agent("self-review-finder-r1-ab", true), agent("general-purpose", false)));
  assert.equal(watched.blind, false);
  assert.match(engagementLine(watched), /engaged: 1\/2 subagent shell calls/);

  // An open round the guard was never asked about used to print nothing, on the
  // reasoning that a cold-grader has no shell and so exercises nothing. That
  // reasoning is measured false: on 2026-09-04 every reviewer type in this
  // plugin, cold-graders and appliers included, was observed making real Bash
  // calls their agent file's `tools:` list does not contain. So silence there
  // is anomalous and says so.
  assert.match(engagementLine(auditEngagement(log(round(1)))), /asked about no subagent shell call/);
  // A file with no round marker at all was never opened, which is a different
  // statement from "opened and quiet".
  assert.match(engagementLine(auditEngagement("")), /no engagement log was opened/);
});

test("the audit reads the round asked for, not the whole file", () => {
  const text = log(round(1), agent("self-review-finder-r1-ab", true), round(2), agent("self-review-finder-r2-c", false));
  assert.equal(auditEngagement(text, { round: 1 }).calls, 1, "round 1's rows stop where round 2 opens");
  assert.equal(auditEngagement(text, { round: 1 }).matched, 1);
  assert.deepEqual(auditEngagement(text, { round: 2 }).unmatched, ["self-review-finder-r2-c"]);
  // No round given: the last one opened.
  assert.equal(auditEngagement(text).calls, 1);
});

test("a torn line does not stop the rest being audited", () => {
  const audit = auditEngagement(`{"kind":"round","round":1}\n{"kind":"agen\n${JSON.stringify(agent("self-review-finder-r1-ab", true))}\n`);
  assert.equal(audit.calls, 1);
});

test("the plugin-generated test does not reuse tree-guard's own regex", async () => {
  // A check written in the terms of the thing it checks passes whenever that
  // thing is consistent with itself, which is the failure being audited. The
  // proof: a name tree-guard's REVIEWER does NOT match is still recognised here
  // as one this plugin generated, which is what makes the first clause fire.
  const guard = await import("../tree-guard.mjs");
  const name = "self-review-applier-r2";
  assert.equal(guard.evaluate({ agent_id: "a1", agent_type: name, tool_name: "Bash", tool_input: { command: "git checkout ." } }), null,
    "the applier is not a reviewer, so the guard is right not to match it");
  const audit = auditEngagement(log(round(1), agent(name, false)));
  assert.deepEqual(audit.unmatched, [], "an applier is not a type the guard covers, so this is not evidence its regex died");
  assert.deepEqual(audit.uncovered, [{ agentType: name, rows: 1 }],
    "but the audit still knows it is a name this plugin generated, and that a shell ran under it unwatched");
  assert.match(engagementLine(audit), /a name the guard does not cover/);
});

test("the covered list and tree-guard's own regex cannot drift apart in silence", async () => {
  // COVERED decides which of two different failures an unmatched row is, and it
  // is deliberately not tree-guard's constant. Deliberate independence is only
  // safe if a divergence is caught: if tree-guard stops matching a type this
  // file calls covered, that type's rows would be filed as `inert` — true — but
  // if the guard STARTS covering one this file does not, an unwatched shell
  // would be filed as covered-and-matched and vanish. So the overlap is asserted.
  const guard = await import("../tree-guard.mjs");
  const denied = (agentType) =>
    guard.evaluate({ agent_id: "a1", agent_type: agentType, tool_name: "Bash", tool_input: { command: "git checkout ." } });
  for (const type of ["self-review-finder-r1-ab", "self-review-verifier-r1", "self-review-cold-grader-r1-x", "self-review-ticket-validator"]) {
    assert.ok(denied(type), `tree-guard must cover ${type}, which engagement.mjs counts as covered`);
  }
});

test("every role this plugin ships is classified by OURS, not just the three it covers", () => {
  // The other direction of the same drift, and the one the first test cannot
  // see. OURS decides whether a row is EXPLAINED at all: a role it does not
  // match is neither `inert` nor `uncovered`, so its rows land in the generic
  // `engaged: N/M` ratio and an inert guard over that role reads as a partial
  // match. Deriving the list from the shipped agent files is what keeps a
  // fifth role from being silently unclassified — a hand-copied fourth
  // spelling of the same names is what this is replacing.
  const dir = path.join(PLUGIN_ROOT, "agents");
  const roles = readdirSync(dir)
    .filter((file) => file.startsWith("self-review-") && file.endsWith(".md"))
    .map((file) => file.slice(0, -3));
  assert.ok(roles.length >= 4, `only ${roles.length} agent files found — the walk, not the rule, is what failed`);
  const unclassified = roles.filter((role) => !OURS.test(`${role}-r1-ab`));
  assert.deepEqual(unclassified, [],
    "a role this plugin ships that OURS does not match falls through both explanatory branches of the audit");
});

test("the two sides may spell the same repository differently and still meet", () => {
  // The failure this closes, measured on 2026-09-04: round.sh opens the log
  // keyed by `git rev-parse --show-toplevel` and tree-guard notes it keyed by
  // the payload's `cwd`. Through a symlinked checkout those are two strings for
  // one repository, and hashing them raw made two logs — so every guarded call
  // went into a file nothing read and the audit printed nothing, which is
  // byte-identical to a round in which no reviewer ran a shell.
  const dir = logDir();
  const real = mkdtempSync(path.join(tmpdir(), "repo-real-"));
  const link = path.join(mkdtempSync(path.join(tmpdir(), "repo-link-")), "repo");
  symlinkSync(real, link);

  openEngagement(real, 1, { logDir: dir });                                  // round.sh: the git toplevel
  assert.ok(noteEngagement(link, "self-review-finder-r1-ab", true, { session: "s1", logDir: dir }), "the symlinked spelling must find the same log");
  assert.ok(noteEngagement(`${real}/`, "self-review-finder-r1-cd", true, { session: "s1", logDir: dir }), "a trailing slash is the same repository");
  assert.equal(auditEngagement(readFileSync(engagementFile(real, dir), "utf8"), { round: 1 }).calls, 2);
});

test("a call from a subdirectory finds the round its repository opened", () => {
  // A session started in <repo>/plugin gives the guard that cwd while round.sh
  // opened the log under <repo>. Same class as the symlink, different door.
  const dir = logDir();
  const repo = mkdtempSync(path.join(tmpdir(), "repo-sub-"));
  const inner = path.join(repo, "plugin", "hooks");
  mkdirSync(inner, { recursive: true });
  openEngagement(repo, 2, { logDir: dir });
  assert.ok(noteEngagement(inner, "self-review-finder-r2-ab", true, { session: "s1", logDir: dir }));
  assert.equal(auditEngagement(readFileSync(engagementFile(repo, dir), "utf8"), { round: 2 }).matched, 1);
});

test("an unopened round reports that it proved nothing, and never borrows another round's rows", () => {
  // round.sh ends the open call in `|| true`, so a failed open is silent while
  // an earlier round's rows sit in the same append-only file. Substituting them
  // printed a green engagement line for a round the guard never watched — the
  // absence of the measurement manufacturing a pass.
  const dir = logDir();
  const repo = "/repo-unopened";
  openEngagement(repo, 1, { logDir: dir });
  noteEngagement(repo, "self-review-finder-r1-ab", true, { session: "s1", logDir: dir });
  noteEngagement(repo, "self-review-finder-r1-cd", true, { session: "s1", logDir: dir });
  const text = readFileSync(engagementFile(repo, dir), "utf8");

  const round2 = auditEngagement(text, { round: 2 });
  assert.deepEqual(round2, { calls: 0, matched: 0, unmatched: [], uncovered: [], unattributed: 0, blind: false, opened: false });
  assert.match(engagementLine(round2), /no engagement log was opened/);
  assert.doesNotMatch(engagementLine(round2), /engaged: 2\/2/, "round 1's rows are not round 2's evidence");

  const round1 = auditEngagement(text, { round: 1 });
  assert.equal(round1.opened, true);
  assert.match(engagementLine(round1), /engaged: 2\/2/);
});
