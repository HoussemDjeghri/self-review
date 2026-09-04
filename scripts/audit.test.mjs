// Run: node --test plugin/scripts/audit.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregate, appliedBy, auditSession, candidatesOf, overlapOf, ownerWindows, parseSummary, reflagOf, reflagRows, recordsByReview } from "./audit.mjs";

const SCRIPT = fileURLToPath(new URL("audit.mjs", import.meta.url));
// auditSession's default logDir is the machine's real ~/.claude/self-review,
// whose log.jsonl grows every time a review converges — including while this
// suite runs. Every case here reads an empty directory instead.
const NO_LOG = mkdtempSync(path.join(tmpdir(), "audit-nolog-"));
const audit = (file, logDir = NO_LOG) => auditSession(file, { logDir });

const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 5 };
let nextId = 0;
const assistant = (timestamp, content) => ({
  type: "assistant", timestamp,
  message: { id: `msg-${nextId++}`, model: "claude-sonnet-5", usage, content },
});
const spawn = (name) => ({ type: "tool_use", name: "Agent", input: { subagent_type: "self-review-finder", name, prompt: "reviewer 1 of 2 in round 1 of a self-review" } });
const bashMarker = (summary) => ({ type: "tool_use", name: "Bash", input: { command: `/plugin/scripts/converged.sh "${summary}"` } });
const fileMarker = (summary) => ({ type: "tool_use", name: "Write", input: { file_path: "/tmp/x/self-review/CONVERGED.json", content: JSON.stringify({ summary }) } });
// The typed forms, as converged.sh and the gate write them since 0.5.0. The two
// above are the legacy shapes, kept because old transcripts still hold them.
const bashMarkerBare = (summary) => ({ type: "tool_use", name: "Bash", input: { command: `/plugin/scripts/converged.sh ${summary}` } });
const bashMarkerTyped = (flags) => ({ type: "tool_use", name: "Bash", input: { command: `/plugin/scripts/converged.sh ${flags}` } });
const fileMarkerTyped = (record) => ({ type: "tool_use", name: "Write", input: { file_path: "/tmp/x/self-review/CONVERGED.json", content: JSON.stringify(record) } });

// A session on disk: <dir>/<id>.jsonl plus <dir>/<id>/subagents/agent-*.jsonl,
// which is the layout Claude Code writes.
function session(entries, agents = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  const file = path.join(dir, "sess.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (agents.length) mkdirSync(path.join(dir, "sess", "subagents"), { recursive: true });
  for (const [name, lines, meta] of agents) {
    const base = path.join(dir, "sess", "subagents", `agent-${name}`);
    writeFileSync(`${base}.jsonl`, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (meta) writeFileSync(`${base}.meta.json`, JSON.stringify(meta));
  }
  return file;
}

const finderTranscript = (timestamp, toolPath) => [
  { type: "user", timestamp, message: { content: "You are reviewer 1 of 2 in round 1 of a self-review.\n\nYOUR ANGLE — A" } },
  assistant(timestamp, [{ type: "tool_use", name: "Read", input: { file_path: toolPath } }]),
];
const verifierTranscript = (timestamp) => [
  { type: "user", timestamp, message: { content: "Verify these self-review candidates; return CONFIRMED / PLAUSIBLE / REFUTED." } },
  assistant(timestamp, [{ type: "text", text: "CONFIRMED" }]),
];

test("a marker summary parses as key=value tokens plus the not-converged literal", () => {
  const parsed = parseSummary("rounds=2 fixed=3 dismissed=1 open=0 tier=M adapter=grep forced=S not-converged oddity");
  assert.equal(parsed.rounds, 2);
  assert.equal(parsed.fixed, 3);
  assert.equal(parsed.tier, "M");
  assert.equal(parsed.adapter, "grep");
  assert.equal(parsed.forced, "S");
  assert.equal(parsed.outcome, "not-converged");
  assert.equal(parseSummary("tier=S forced=S computed=L").computed, "L", "a forced tier is only countable against the one the rules chose");
  assert.deepEqual(parsed.notes, ["oddity"]);
});

test("the typed record's outcome and reason parse, and a hatch carries no counts", () => {
  const parsed = parseSummary("outcome=not-applicable reason=user-declined");
  assert.equal(parsed.outcome, "not-applicable");
  assert.equal(parsed.reason, "user-declined");
  assert.equal(parsed.rounds, null, "a non-review must not present as rounds=0");
  assert.deepEqual(parsed.notes, []);
  assert.equal(parseSummary("outcome=converged rounds=1 fixed=0 dismissed=0 open=0").outcome, "converged");
});

// 29 of the first 112 markers are this shape: the escape hatch before it had a
// name. Counting them as converged reviews dragged every per-tier average.
test("a legacy row with zero rounds and no outcome is not a converged review", () => {
  const parsed = parseSummary("rounds=0 fixed=0 dismissed=0 open=0 — review does not apply: docs only");
  assert.equal(parsed.outcome, "not-applicable");
  assert.equal(parsed.rounds, 0);
});

test("an explicit outcome always wins over the zero-rounds rule", () => {
  assert.equal(parseSummary("outcome=converged rounds=0 fixed=0 dismissed=0 open=0").outcome, "converged");
});

// `row.dismissed += "1(rebutted,"` made a tier's total the string "01(rebutted,".
test("a count that is not an integer stays null and becomes a note", () => {
  const parsed = parseSummary("rounds=3 fixed=2 dismissed=1(rebutted, sustained) open=0");
  assert.equal(parsed.dismissed, null);
  assert.equal(parsed.rounds, 3);
  assert.ok(parsed.notes.includes("dismissed=1(rebutted,"));
  assert.equal(parseSummary("rounds=2of3").rounds, null);
  assert.equal(parseSummary("open=0;").open, null);
});

test("an unrecognised outcome value is a note, not a silent outcome", () => {
  const parsed = parseSummary("outcome=done rounds=1 fixed=0 dismissed=0 open=0");
  assert.equal(parsed.outcome, "converged");
  assert.ok(parsed.notes.includes("outcome=done"));
});

test("a summary with no key=value tokens still reports converged with the text kept", () => {
  const parsed = parseSummary("reviewed by hand, nothing to fix");
  assert.equal(parsed.outcome, "converged");
  assert.equal(parsed.rounds, null);
  assert.ok(parsed.notes.includes("reviewed"));
});

test("a review runs from the first reviewer spawn to the marker, with its agents attributed", () => {
  const file = session(
    [
      assistant("2026-08-23T10:00:00Z", [{ type: "text", text: "unrelated work before the review" }]),
      assistant("2026-08-23T10:01:00Z", [spawn("r1-abd"), spawn("r1-cef")]),
      assistant("2026-08-23T10:20:00Z", [{ type: "text", text: "fixing" }]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=2 dismissed=0 open=0 tier=M adapter=grep")]),
      assistant("2026-08-23T10:40:00Z", [{ type: "text", text: "after the review" }]),
    ],
    [
      ["r1-abd", finderTranscript("2026-08-23T10:02:00Z", "/w/round-1/scope.diff")],
      ["r1-cef", finderTranscript("2026-08-23T10:03:00Z", "/repo/src/a.ts")],
      ["late", finderTranscript("2026-08-23T11:00:00Z", "/repo/src/b.ts")],
    ]);

  const { reviews } = audit(file);
  assert.equal(reviews.length, 1);
  const [review] = reviews;
  assert.equal(review.tier, "M");
  assert.equal(review.outcome, "converged");
  assert.equal(review.fixed, 2);
  assert.equal(review.turns, 3, "spawn, fix and marker turns count; the ones outside the window do not");
  assert.equal(review.agents.finders, 2, "an agent that started after the marker belongs to no review");
  assert.equal(review.tooling.calls, 1, "only the reviewer that read the scope diff counts as tooling");
  assert.equal(review.tooling.ofToolCalls, 2);
  assert.equal(review.tokens.finders.calls, 2);
  assert.ok(review.tokens.main.billedInput > 0);
});

test("the scratch-file marker ends a review exactly like the script", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [fileMarker("rounds=2 fixed=0 dismissed=1 open=0 tier=S")]),
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.tier, "S");
  assert.equal(review.dismissed, 1);
  assert.equal(review.marker, "rounds=2 fixed=0 dismissed=1 open=0 tier=S");
});

test("a review that never marked is reported as unmarked, not as converged", () => {
  const file = session([assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")])]);
  const [review] = audit(file).reviews;
  assert.equal(review.outcome, "unmarked");
  assert.equal(review.marker, null);
  assert.equal(review.endedAt, null);
});

test("verifiers are counted apart from finders", () => {
  const file = session(
    [
      assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=1 tier=L")]),
    ],
    [["r1-abd", finderTranscript("2026-08-23T10:02:00Z", "/repo/a.ts")], ["v1", verifierTranscript("2026-08-23T10:10:00Z")]]);
  const [review] = audit(file).reviews;
  assert.equal(review.agents.finders, 1);
  assert.equal(review.agents.verifiers, 1);
  assert.equal(review.tokens.verifier.calls, 1);
});

test("two reviews in one session are two reviews", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1")]),
    assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=1 tier=S")]),
    assistant("2026-08-23T11:01:00Z", [spawn("r2")]),
    assistant("2026-08-23T11:30:00Z", [bashMarker("rounds=2 fixed=0 tier=M not-converged")]),
  ]);
  const { reviews } = audit(file);
  assert.deepEqual(reviews.map((r) => [r.tier, r.outcome]), [["S", "converged"], ["M", "not-converged"]]);
});

test("the dispatcher's sidecar names the agent and its role, whatever the brief looked like", () => {
  // The real files are agent-a<name>-<hash>.jsonl, and a brief handed over as a
  // file pointer carries no angle text for the heuristics to match.
  const pointer = [
    { type: "user", timestamp: "2026-08-23T10:02:00Z", message: { content: "<teammate-message>\nYour complete brief is the file /tmp/x/self-review/round-1/briefs/r1-cd.md — Read it first." } },
    assistant("2026-08-23T10:02:30Z", [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x/self-review/round-1/briefs/r1-cd.md" } }]),
  ];
  const file = session(
    [
      assistant("2026-08-23T10:01:00Z", [spawn("r1-cd")]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=1 tier=L")]),
    ],
    [["ar1-cd-d7e007c386c1cc6d", pointer, { name: "r1-cd", customAgentType: "self-review-finder" }]]);
  const [review] = audit(file).reviews;
  assert.equal(review.agents.finders, 1, "a pointer brief is still a finder");
  assert.deepEqual(review.agents.names, ["r1-cd"], "the name comes from the sidecar, not the file name");
});

test("without a sidecar the agent name loses its wrapper, not its identity", () => {
  const file = session(
    [
      assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 tier=M")]),
    ],
    [["ar1-ab-58d713b846e9b1d6", finderTranscript("2026-08-23T10:02:00Z", "/repo/a.ts")]]);
  assert.deepEqual(audit(file).reviews[0].agents.names, ["r1-ab"]);
});

test("a marker that survives only in log.jsonl still closes its review", () => {
  const cwd = "/repo/project";
  const withCwd = (entry) => ({ ...entry, cwd });
  const file = session([
    withCwd(assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")])),
    withCwd(assistant("2026-08-23T10:20:00Z", [{ type: "text", text: "the marker call has aged out of this transcript" }])),
  ]);
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-log-"));
  writeFileSync(path.join(logDir, "log.jsonl"),
    [{ ts: "2026-08-22T09:00:00Z", cwd, summary: "rounds=9 tier=L" },
     { ts: "2026-08-23T10:25:00Z", cwd, summary: "rounds=2 fixed=3 tier=M" },
     { ts: "2026-08-23T10:26:00Z", cwd: "/somewhere/else", summary: "rounds=1 tier=S" }]
      .map((r) => JSON.stringify(r)).join("\n") + "\n");

  const [review] = audit(file, logDir).reviews;
  assert.equal(review.outcome, "converged");
  assert.equal(review.markerSource, "log");
  assert.equal(review.tier, "M", "the entry inside the window wins, not the older one");
  assert.equal(review.fixed, 3);
  assert.ok(Date.parse(review.endedAt) > Date.parse("2026-08-23T10:20:00Z"),
    "the marker may sit just past the last visible entry — that is the case this fallback is for");
});

test("the review says which model each reviewer actually ran on", () => {
  // The finder pin lives in two places — the agent file's frontmatter and the
  // per-row model tier.mjs plans — and a subagent inherits the session's model
  // wherever a pin is missing. An opus finder costs several times a sonnet one,
  // so the review reports what ran rather than what was meant to run.
  const cwd = "/repo/project";
  const withCwd = (entry) => ({ ...entry, cwd });
  const file = session([
    withCwd(assistant("2026-08-23T10:01:00Z", [spawn("r1-ab"), spawn("r1-g")])),
    withCwd(assistant("2026-08-23T10:20:00Z", [fileMarker("rounds=1 fixed=1 tier=L converged")])),
  ], [
    ["r1-ab", finderTranscript("2026-08-23T10:02:00Z", "/plugin/scripts/brief.mjs"), { name: "r1-ab", subagent_type: "self-review-finder" }],
    ["r1-g", finderTranscript("2026-08-23T10:03:00Z", "/plugin/scripts/brief.mjs").map((entry) => (entry.message?.model ? { ...entry, message: { ...entry.message, model: "claude-opus-5" } } : entry)), { name: "r1-g", subagent_type: "self-review-finder" }],
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.agents.finders, 2);
  assert.deepEqual(review.agents.models.finders, { "claude-sonnet-5": 1, "claude-opus-5": 1 });
  assert.deepEqual(review.agents.models.verifiers, {});
});

test("a convergence decision is not a marker, and a review is UNMEASURED until every round logged one", () => {
  const cwd = "/repo/project";
  const withCwd = (entry) => ({ ...entry, cwd });
  // `findings.mjs converge` appends to the same log the marker fallback reads.
  // A converge row carries no summary, so adopting one as a marker would end a
  // review with an empty summary and call it converged.
  const file = session([
    withCwd(assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")])),
    withCwd(assistant("2026-08-23T10:20:00Z", [fileMarker("rounds=3 fixed=2 tier=L converged")])),
  ]);
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-converge-"));
  const row = (over) => ({ ts: "2026-08-23T10:10:00Z", kind: "converge", cwd, review: "self-review", budget: 2, w: 3, earned: false, tail: null, verdict: "CONTINUE", ...over });
  writeFileSync(path.join(logDir, "log.jsonl"),
    [row({ ts: "2026-08-23T10:05:00Z", round: 1 }),
     row({ ts: "2026-08-23T10:10:00Z", round: 2, earned: true, tail: "blocker" }),
     // The same round decided twice: a round re-run after more fixes decides
     // again, and the last decision is the one that held.
     row({ ts: "2026-08-23T10:12:00Z", round: 2, earned: false, tail: "minor" }),
     // Another session's review, inside the window, must not be counted here.
     row({ ts: "2026-08-23T10:13:00Z", round: 7, cwd: "/somewhere/else" })]
      .map((r) => JSON.stringify(r)).join("\n") + "\n");

  const [review] = audit(file, logDir).reviews;
  assert.equal(review.markerSource, "transcript");
  assert.equal(review.outcome, "converged");
  // The sharp case for the guard: no marker in the transcript, so the log
  // fallback runs and the converge rows are the only entries in the window.
  const unmarked = session([
    withCwd(assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")])),
    withCwd(assistant("2026-08-23T10:20:00Z", [{ type: "text", text: "no marker here" }])),
  ]);
  const [orphan] = audit(unmarked, logDir).reviews;
  assert.equal(orphan.outcome, "unmarked", "a converge row must never be adopted as a marker");
  assert.equal(orphan.markerSource, null);
  assert.equal(review.converge.rows, 2, "two rounds decided, the repeat deduped to its last decision");
  assert.deepEqual(review.converge.earned, [], "the last decision on round 2 did not grant a round");
  // Three rounds ran, two decisions were logged: the record is incomplete, so
  // hypothesis (b) is unmeasured here — not "nothing was earned".
  assert.equal(review.converge.measured, false);
});

test("every round accounted for is what makes the earned rule measurable", () => {
  const cwd = "/repo/project";
  const withCwd = (entry) => ({ ...entry, cwd });
  const file = session([
    withCwd(assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")])),
    withCwd(assistant("2026-08-23T10:20:00Z", [fileMarker("rounds=2 fixed=1 tier=M converged")])),
  ]);
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-converge-full-"));
  writeFileSync(path.join(logDir, "log.jsonl"),
    [{ ts: "2026-08-23T10:05:00Z", kind: "converge", cwd, review: "self-review", round: 1, budget: 2, verdict: "CONTINUE", earned: false, tail: "major", w: 2 },
     { ts: "2026-08-23T10:15:00Z", kind: "converge", cwd, review: "self-review", round: 2, budget: 2, verdict: "CONTINUE", earned: true, tail: "blocker", w: 3 }]
      .map((r) => JSON.stringify(r)).join("\n") + "\n");
  const [review] = audit(file, logDir).reviews;
  assert.deepEqual({ rows: review.converge.rows, earned: review.converge.earned, measured: review.converge.measured },
    { rows: 2, earned: [2], measured: true });
});

test("a review the log cannot explain either stays unmarked", () => {
  const file = session([assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")])]);
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-log-"));
  writeFileSync(path.join(logDir, "log.jsonl"), JSON.stringify({ ts: "2026-08-21T10:25:00Z", summary: "rounds=1" }) + "\n");
  const [review] = audit(file, logDir).reviews;
  assert.equal(review.outcome, "unmarked");
  assert.equal(review.markerSource, null);
});

test("the CLI reports bad input instead of throwing a stack trace at the user", () => {
  const run = (args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  const missing = run(["/nonexistent/session.jsonl"]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /audit.mjs: not a session transcript/);
  assert.doesNotMatch(missing.stderr, /at .*node:fs/, "no stack trace");
  assert.equal(run(["--log-dir"]).status, 2);

  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-ab")]),
    assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=2 tier=M")]),
  ]);
  const ok = run([file, "--log-dir", NO_LOG]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /== REVIEWS ==/);
  assert.match(ok.stdout, /tier=M converged rounds=1 fixed=2/);
  assert.match(run([file, "--json", "--log-dir", NO_LOG]).stdout, /"markerSource": "transcript"/);
});

test("a marker logged after the session ended belongs to a later review, not this one", () => {
  // log.jsonl is shared by every session in the repo: an abandoned review must
  // not adopt the marker of an unrelated review that ran days later.
  const cwd = "/repo/project";
  const file = session([{ ...assistant("2026-08-20T09:00:00Z", [spawn("r1-ab")]), cwd }]);
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-log-"));
  writeFileSync(path.join(logDir, "log.jsonl"),
    JSON.stringify({ ts: "2026-08-25T14:00:00Z", cwd, summary: "rounds=3 fixed=9 dismissed=2 tier=L" }) + "\n");
  const [review] = audit(file, logDir).reviews;
  assert.equal(review.outcome, "unmarked");
  assert.equal(review.markerSource, null);
  assert.equal(review.fixed, null);
});

// --- F6: overlap between the angles of one round ---------------------------

const filed = (timestamp, rows, tail = "") => [
  { type: "user", timestamp, message: { content: `Read /w/self-review/round-1/briefs/r1-ab.md and follow it.` } },
  assistant(timestamp, [{ type: "text", text: "```json\n" + JSON.stringify(rows) + "\n```\n" + tail }]),
];

test("a finder's candidates are read from its array whether it ends with one or signs off after it", () => {
  const rows = [{ file: "src/a.ts", line: 42, class: "correctness" }];
  assert.deepEqual(candidatesOf(filed("2026-08-23T10:02:00Z", rows)),
    [{ file: "src/a.ts", line: 42, cls: "correctness" }]);

  // The shape a lead-and-teammates round leaves behind: the array went out as a
  // SendMessage argument and the last thing in the transcript is prose about it.
  const sent = [
    { type: "user", timestamp: "2026-08-23T10:02:00Z", message: { content: "Read /w/self-review/round-1/briefs/r1-ab.md" } },
    assistant("2026-08-23T10:03:00Z", [{ type: "tool_use", name: "SendMessage", input: { to: "team-lead", message: `here they are\n${JSON.stringify(rows)}` } }]),
    assistant("2026-08-23T10:04:00Z", [{ type: "text", text: "Findings sent to team-lead: 1 candidate. Nothing else survived." }]),
  ];
  assert.deepEqual(candidatesOf(sent), [{ file: "src/a.ts", line: 42, cls: "correctness" }]);
});

test("a located row outranks a quoted empty array, and prose alone reads as unknown", () => {
  const rows = [{ file: "src/a.ts", line: 7, category: "pitfall" }];
  const late = [
    ...filed("2026-08-23T10:02:00Z", rows),
    assistant("2026-08-23T10:05:00Z", [{ type: "text", text: "Reported `[]` to team-lead — nothing further." }]),
  ];
  assert.deepEqual(candidatesOf(late), [{ file: "src/a.ts", line: 7, cls: "pitfall" }],
    "the sign-off's [] is prose about the array, not a second answer");

  assert.deepEqual(candidatesOf(filed("2026-08-23T10:02:00Z", [])), [], "an empty array is a real answer");
  assert.equal(candidatesOf([
    { type: "user", timestamp: "2026-08-23T10:02:00Z", message: { content: "round-1/briefs/r1-ab.md" } },
    assistant("2026-08-23T10:03:00Z", [{ type: "text", text: "I reviewed src/a.ts and found nothing worth filing." }]),
  ]), null, "unknown is not zero — a share over unparsed rows would read as agreement");
  assert.equal(candidatesOf([assistant("2026-08-23T10:03:00Z", [{ type: "text", text: 'Read ["a", "b"]' }])]), null,
    "an array of strings is some other list");
});

test("a bracket in the prose before an unfenced array does not hide it", () => {
  // One indexOf("[") took the first bracket in the message, so a markdown link
  // made the slice unparseable — and the search fell back to an OLDER message,
  // reporting a previous round's candidates as this finder's.
  const row = (file) => JSON.stringify([{ file, line: 12, class: "correctness" }]);
  const linked = [
    { type: "user", timestamp: "2026-08-23T10:02:00Z", message: { content: "round-1/briefs/r1-ab.md" } },
    assistant("2026-08-23T10:03:00Z", [{ type: "text", text: `Findings:\n${row("plugin/hooks/old.mjs")}` }]),
    assistant("2026-08-23T10:04:00Z", [{ type: "text", text: `See [details](http://x) first.\nFindings:\n${row("plugin/hooks/new.mjs")}` }]),
  ];
  assert.deepEqual(candidatesOf(linked), [{ file: "plugin/hooks/new.mjs", line: 12, cls: "correctness" }],
    "the newest message's array, not the older one that happened to parse");
});

test("a location is read from whichever field the finder's schema of the day used", () => {
  const [ranged, suffixed] = candidatesOf(filed("2026-08-23T10:02:00Z", [
    { file: "README.md", lines: "353-356", category: "accuracy" },
    { file: "tools/release.sh:82-96, CHANGELOG.md:7", class: "Correctness" },
  ]));
  assert.deepEqual(ranged, { file: "README.md", line: 353, cls: "accuracy" });
  assert.deepEqual(suffixed, { file: "tools/release.sh", line: 82, cls: "correctness" });
});

test("a finder whose brief was inlined is placed by its own name", () => {
  // The fallback roundOf() keeps for exactly this case had no fixture: every
  // other transcript here names its round in the first user message, so only
  // the path arm was ever exercised. The names below are the shape the
  // generators actually emit — a fixture in the retired unprefixed shape
  // tests the arm against input that can no longer occur.
  const inlined = (timestamp, rows) => [
    { type: "user", timestamp, message: { content: "YOUR ANGLE — A · line-by-line scan. Findings as JSON." } },
    assistant(timestamp, [{ type: "text", text: "```json\n" + JSON.stringify(rows) + "\n```" }]),
  ];
  const row = [{ file: "src/a.ts", line: 42, class: "correctness" }];
  const file = session(
    [
      assistant("2026-08-23T10:01:00Z", [spawn("self-review-finder-r2-ab"), spawn("self-review-finder-r12-cd"), spawn("v1")]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=12 fixed=1 tier=L")]),
    ],
    [["aself-review-finder-r2-ab-d7e007c386c1cc6d", inlined("2026-08-23T10:02:00Z", row), { name: "self-review-finder-r2-ab", customAgentType: "self-review-finder" }],
     ["aself-review-finder-r12-cd-d7e007c386c1cc6e", inlined("2026-08-23T10:03:00Z", row), { name: "self-review-finder-r12-cd", customAgentType: "self-review-finder" }],
     ["av1-8a93200c18eeed9e", verifierTranscript("2026-08-23T10:10:00Z"), { name: "v1", customAgentType: "self-review-verifier" }]]);
  const [review] = audit(file).reviews;
  assert.deepEqual(review.overlap.map((r) => r.round), [2, 12],
    "the leading r<digits> of the agent's name, greedy so a two-digit round is not read as one");
  assert.equal(review.agents.verifiers, 1, "and `v1` is not round 1: a name with no leading r rounds to null, not a number");
});

test("overlap counts a candidate two finders of the same round filed, on the same or an adjacent line", () => {
  const finder = (name, round, candidates) => ({ name, round, candidates });
  const at = (file, line, cls) => ({ file, line, cls });
  const [round1] = overlapOf([
    finder("r1-ab", 1, [at("src/a.ts", 42, "correctness"), at("src/b.ts", 10, "reuse")]),
    finder("r1-cd", 1, [at("src/a.ts", 43, "correctness"), at("src/b.ts", 10, "efficiency"), at("src/c.ts", 90, "reuse")]),
  ]);
  assert.equal(round1.finders, 2);
  assert.equal(round1.total, 5);
  assert.equal(round1.shared, 2, "src/a.ts:42 and :43 are the same defect; same line but a different class is not");
  assert.deepEqual(round1.candidates, [{ name: "r1-ab", count: 2 }, { name: "r1-cd", count: 3 }]);

  const [own] = overlapOf([finder("r1-ab", 1, [at("src/a.ts", 42, "correctness"), at("src/a.ts", 42, "correctness")])]);
  assert.equal(own.shared, 0, "a finder filing the same thing twice is not two angles agreeing");

  const [unknownLine] = overlapOf([
    finder("r1-ab", 1, [at("src/a.ts", null, "correctness")]),
    finder("r1-cd", 1, [at("src/a.ts", 900, "correctness")]),
  ]);
  assert.equal(unknownLine.shared, 2, "an unparsed line decides on file and class rather than scoring as disagreement");

  const rounds = overlapOf([finder("r1-ab", 1, [at("src/a.ts", 42, "correctness")]), finder("r2-ab", 2, [at("src/a.ts", 42, "correctness")])]);
  assert.deepEqual(rounds.map((row) => row.round), [1, 2], "rounds are counted apart — a later round re-raising a fix is the loop working");
  assert.equal(rounds[0].shared, 0);

  const [blind] = overlapOf([finder("r1-ab", 1, null), finder("r1-cd", 1, [at("src/a.ts", 42, "correctness")])]);
  assert.deepEqual({ finders: blind.finders, unread: blind.unread, total: blind.total }, { finders: 2, unread: 1, total: 1 });
});

test("the report prints one overlap line per round, from the transcripts", () => {
  const rows = [{ file: "src/a.ts", line: 42, class: "correctness" }];
  const file = session(
    [
      assistant("2026-08-23T10:01:00Z", [spawn("r1-ab"), spawn("r1-cd")]),
      assistant("2026-08-23T10:30:00Z", [bashMarker("rounds=1 fixed=1 tier=M")]),
    ],
    [
      ["r1-ab", filed("2026-08-23T10:02:00Z", rows)],
      ["r1-cd", filed("2026-08-23T10:03:00Z", [{ file: "src/a.ts", line: 42, class: "correctness" }, { file: "src/z.ts", line: 1, class: "reuse" }])],
    ]);
  const [review] = audit(file).reviews;
  assert.deepEqual(review.overlap, [{
    round: 1, finders: 2, unread: 0,
    candidates: [{ name: "r1-ab", count: 1 }, { name: "r1-cd", count: 2 }],
    total: 3, shared: 2,
  }]);
  const out = spawnSync("node", [SCRIPT, file, "--log-dir", NO_LOG], { encoding: "utf8" });
  assert.match(out.stdout, /round 1: 2 finders · candidates r1-ab=1 r1-cd=2 · also filed by another finder 2\/3 \(67%\)/);
});

// A per-tier row divides by the reviews, and a not-applicable window is not one.
const review = (fields) => ({
  tier: "M", outcome: "converged", rounds: 2, fixed: 1, dismissed: 0,
  agents: { finders: 4, verifiers: 1 }, turns: 6,
  tokens: { main: { billedInput: 1e6, output: 0 }, finders: { billedInput: 0, output: 0 }, verifier: { billedInput: 0, output: 0 } },
  ...fields,
});

test("a not-applicable window is reported beside n, not divided into it", () => {
  const [row] = aggregate([review({}), review({ outcome: "not-applicable", rounds: null, fixed: null, dismissed: null, agents: { finders: 0, verifiers: 0 }, turns: 1, tokens: { main: { billedInput: 0, output: 0 }, finders: { billedInput: 0, output: 0 }, verifier: { billedInput: 0, output: 0 } } })]);
  assert.equal(row.reviews, 2, "the window still counts as a window");
  assert.equal(row.counted, 1, "only the review is a review");
  assert.equal(row.rounds / row.counted, 2, "rounds/review must not be halved by the non-review");
});

test("the typed script marker is read as the record it is, not as a summary string", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [bashMarkerTyped("--converged --rounds 2 --fixed 3 --dismissed 1 --open 0 --tier M --adapter grep --intent author")]),
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.outcome, "converged");
  assert.deepEqual([review.rounds, review.fixed, review.dismissed, review.open], [2, 3, 1, 0]);
  assert.equal(review.tier, "M");
});

test("the typed file marker keeps its outcome, so a not-converged review is not read as clean", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [fileMarkerTyped({ outcome: "not-converged", rounds: 6, fixed: 4, dismissed: 2, open: 3, tier: "L", intent: "author" })]),
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.outcome, "not-converged");
  assert.deepEqual([review.rounds, review.fixed, review.dismissed, review.open], [6, 4, 2, 3]);
});

test("a --note never reaches the summary, however it is quoted", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [bashMarkerTyped('--converged --rounds 1 --fixed 0 --dismissed 0 --open 0 --intent author --note "rounds=99 --open 7 prose"')]),
  ]);
  const [review] = audit(file).reviews;
  assert.deepEqual([review.rounds, review.open], [1, 0], "the note's words must not be read as flags");
});

test("a marker the grammar refuses is not a marker, so the review stays open", () => {
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [fileMarkerTyped({ outcome: "converged", rounds: 0, fixed: 0, dismissed: 0, open: 0 })]),
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.markerSource, null, "the gate would have refused it, so the audit must not count it");
});

test("a not-applicable window inflates no per-review average, numerator or denominator", () => {
  const spent = { main: { billedInput: 2e6, output: 100 }, finders: { billedInput: 0, output: 0 }, verifier: { billedInput: 0, output: 0 } };
  const [row] = aggregate([
    review({}),
    review({ outcome: "not-applicable", rounds: null, fixed: null, dismissed: null, agents: { finders: 3, verifiers: 1 }, turns: 5, tokens: spent }),
  ]);
  assert.equal(row.counted, 1);
  assert.equal(row.turns / row.counted, 6, "the non-review's turns must not join the numerator");
  assert.equal(row.agents / row.counted, 5, "nor its agents");
  assert.equal(row.billedInput / row.counted, 1e6, "nor its tokens");
});

test("the legacy script marker is still read when it was never quoted", () => {
  // The pre-0.5.0 script did `summary="$*"`, so an unquoted tail was a valid
  // marker and old transcripts hold them.
  const file = session([
    assistant("2026-08-23T10:01:00Z", [spawn("r1-abd")]),
    assistant("2026-08-23T10:30:00Z", [bashMarkerBare("rounds=2 fixed=3 dismissed=1 open=0 tier=M")]),
  ]);
  const [review] = audit(file).reviews;
  assert.equal(review.markerSource, "transcript");
  assert.deepEqual([review.rounds, review.fixed, review.dismissed, review.open, review.tier], [2, 3, 1, 0, "M"]);
});

// ---------- the re-flag instrument (F10c's number, F10i's build) ------------

const rec = (round, verdict, file, line, cls = "correctness", review = "r@1") =>
  ({ review, round, verdict, file, line, class: cls, ts: `2026-09-03T1${round}:00:00.000Z` });

test("a fix a later round files again is a re-flag; one no round could re-file is not counted", () => {
  const records = [
    rec(1, "fixed", "src/a.mjs", 10),
    rec(1, "fixed", "src/b.mjs", 40),
    rec(1, "dismissed", "src/c.mjs", 5),
    rec(2, "fixed", "src/a.mjs", 11),   // adjacent line, same class: the same defect
    rec(3, "fixed", "src/z.mjs", 1),    // round 3 is last — nothing could re-file it
  ];
  assert.deepEqual(reflagOf(records), [
    { review: "r@1", round: 1, fixed: 2, recited: 1 },
    { review: "r@1", round: 2, fixed: 1, recited: 0 },
  ], "round 3 is absent because there is no round 4 to have found it again");
});

test("a re-flag needs the same class, and an unknown line does not score as disagreement", () => {
  // Scoring an unparsed line as "different" would report a fix that did not
  // hold as one that did, which is the direction that hides the defect.
  const differentClass = [rec(1, "fixed", "src/a.mjs", 10), rec(2, "fixed", "src/a.mjs", 10, "conventions")];
  assert.deepEqual(reflagOf(differentClass)[0], { review: "r@1", round: 1, fixed: 1, recited: 0 });

  const unknownLine = [rec(1, "fixed", "src/a.mjs", 10), { ...rec(2, "fixed", "src/a.mjs", 10), line: null }];
  assert.equal(reflagOf(unknownLine)[0].recited, 1, "file and class decide when a line is missing");

  const farApart = [rec(1, "fixed", "src/a.mjs", 10), rec(2, "fixed", "src/a.mjs", 90)];
  assert.equal(reflagOf(farApart)[0].recited, 0);
});

test("a round with an applier is attributed to it, and a round without one to the lead", () => {
  const label = appliedBy([{ round: 2, depth: 1 }, { round: 3, depth: 2 }, { round: null, depth: 1 }]);
  assert.equal(label(1), "lead", "no applier that round: the lead's own hand is the baseline");
  assert.equal(label(2), "applier@1");
  assert.equal(label(3), "applier@2", "an applier the orchestrator dispatched is a different arm");
});

test("a recorded review is claimed by the tightest window that contains it, not by every one that overlaps", () => {
  // Two failures, one cause. Windows are computed one session at a time and
  // cannot see each other, so "any window that contains it" let every
  // overlapping review claim the same records — measured, 3.5x the real fixed
  // total, then a further 6x from overlapping sessions — and it labelled a
  // neighbour's round with the claiming window's own appliers.
  const byReview = new Map([["a@1", [rec(1, "fixed", "src/a.mjs", 1)]]]);
  const tight = { startedAt: "2026-09-03T10:30:00.000Z", endedAt: "2026-09-03T11:30:00.000Z", appliers: [{ round: 1, depth: 1 }] };
  const wide = { startedAt: "2026-09-03T09:00:00.000Z", endedAt: "2026-09-03T23:00:00.000Z", appliers: [] };
  assert.equal(ownerWindows(byReview, [wide, tight]).get("a@1"), tight);
  assert.equal(ownerWindows(byReview, [tight, wide]).get("a@1"), tight, "and not by which one was audited first");
  assert.equal(ownerWindows(byReview, [wide]).get("a@1"), wide, "the only container still owns it");
  assert.equal(ownerWindows(byReview, [{ startedAt: "2026-09-04T00:00:00.000Z", endedAt: null, appliers: [] }]).size, 0,
    "a window that does not contain the records owns nothing");
});

test("a round's re-flag row is labelled by the appliers of the review it belongs to", () => {
  // Review B ran an applier at round 1 inside review A's longer window. Read
  // per-window, B's row was computed once correctly and once as `lead` by A,
  // and whichever the traversal reached first decided the number.
  const byReview = new Map([
    ["b@1", [rec(1, "fixed", "src/b.mjs", 10, "correctness", "b@1"), rec(2, "open", "src/b.mjs", 10, "correctness", "b@1")]],
  ]);
  const a = { startedAt: "2026-09-03T09:00:00.000Z", endedAt: "2026-09-03T23:00:00.000Z", appliers: [] };
  const b = { startedAt: "2026-09-03T10:30:00.000Z", endedAt: "2026-09-03T13:00:00.000Z", appliers: [{ round: 1, depth: 2 }] };
  const rows = reflagRows(byReview, [a, b]);
  assert.deepEqual(rows, [{ review: "b@1", round: 1, fixed: 1, recited: 1, by: "applier@2" }]);
  assert.equal(reflagRows(byReview, [a, b]).length, 1, "and it is counted once, not once per overlapping window");
});

test("a review no audited window contains is still counted, attributed to the lead", () => {
  // The session that ran it may simply not be on this disk. Dropping the row
  // would silently shrink the denominator of the rate the instrument exists for.
  const byReview = new Map([["z@1", [rec(1, "fixed", "src/z.mjs", 3, "correctness", "z@1"), rec(2, "open", "src/z.mjs", 3, "correctness", "z@1")]]]);
  assert.deepEqual(reflagRows(byReview, []), [{ review: "z@1", round: 1, fixed: 1, recited: 1, by: "lead" }]);
});

test("recordsByReview groups every findings file on disk by the review that filed it", () => {
  // The one function in the re-flag pipeline that reads the disk, and the one
  // the tests above cannot reach: they all start from a hand-built Map. Before
  // this, the only branch any test executed was the `!existsSync` early return,
  // so a grouping that dropped a second file, or let one file's review id
  // overwrite another's, would have printed a plausible wrong percentage.
  const logDir = mkdtempSync(path.join(tmpdir(), "audit-records-"));
  assert.equal(recordsByReview(logDir).size, 0, "no findings directory is an empty index, not a throw");

  const findings = path.join(logDir, "findings");
  mkdirSync(findings, { recursive: true });
  // `rec` is the in-memory shape the re-flag functions take; a record on disk
  // must also satisfy `recordProblem`, or `readRecords` counts it malformed and
  // drops it. That is the whole difference between this test and the ones
  // above, and it is why they could not have caught a bug in here.
  const onDisk = (record) => ({ severity: "major", angle: "A", summary: "s", ...record });
  const write = (name, records) =>
    writeFileSync(path.join(findings, name), records.map((one) => JSON.stringify(onDisk(one))).join("\n") + "\n");
  // Two repositories' memory files, as findingsFile names them: one review
  // spans both, which is what "grouped by review, not by file" has to mean.
  write("aaa.jsonl", [rec(1, "fixed", "src/a.mjs", 10, "correctness", "one@1"), rec(1, "fixed", "src/b.mjs", 20, "correctness", "two@1")]);
  write("bbb.jsonl", [rec(2, "open", "src/a.mjs", 11, "correctness", "one@1")]);
  // Not a findings file: the directory holds other things, and a stray
  // extension must not be parsed as records.
  writeFileSync(path.join(findings, "notes.txt"), "not json\n");

  const index = recordsByReview(logDir);
  assert.deepEqual([...index.keys()].sort(), ["one@1", "two@1"]);
  assert.equal(index.get("one@1").length, 2, "a review's records accumulate across files rather than the second file replacing the first");
  assert.deepEqual(index.get("one@1").map((one) => one.round), [1, 2]);
  assert.equal(index.get("two@1").length, 1);

  // A record with no review id belongs to no review and is skipped, not
  // grouped under `undefined` — where it would become a phantom review with a
  // re-flag row of its own.
  const { review, ...orphan } = rec(1, "fixed", "src/c.mjs", 5);
  write("ccc.jsonl", [orphan]);
  assert.equal(recordsByReview(logDir).has(undefined), false);

  // And a row that fails the schema is dropped rather than indexed: the index
  // is only ever as trustworthy as `readRecords`, which is the point of
  // reading through it instead of parsing the lines here.
  writeFileSync(path.join(findings, "ddd.jsonl"), JSON.stringify({ review: "bad@1", round: 0 }) + "\n");
  assert.equal(recordsByReview(logDir).has("bad@1"), false);
});
