// Run: node --test plugin/hooks/wait-advice.test.mjs   (or ./test.sh for everything)
//
// Five shipped files state how to wait for a reviewer — SKILL.md's rule 1 and
// its "things that break the loop" bullet, poll-guard's denial, and the Stop
// gate's two block reasons — in four registers that cannot share a source: a
// PreToolUse denial string, a Stop reason string, and markdown a model reads
// and that can import nothing. They were kept in step by hand, and that failed
// in the obvious way: 0.7.2 rewrote one gate message and pinned it, and round 2
// of its own review found the second copy, in the same file, in a branch no
// test reached. Three of the five now carry a per-message assertion; those stay
// — they assert the RENDERED string, which this cannot. What this adds is the
// part no per-message test can have: detection of a SIXTH site.
//
// It lives beside no-network.test.mjs, and for the same reason: a claim about
// every shipped file is tested by walking every shipped file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT } from "./lib/config.mjs";
import { walkFiles } from "./lib/tree.mjs";

// Shipped prose and code, not the tests — a test may quote the retired wording
// in order to assert it is gone.
// walkFiles returns paths RELATIVE to the root, so every read joins them back.
const shipped = () =>
  walkFiles(PLUGIN_ROOT)
    .filter((file) => /\.(mjs|js|sh|md|json)$/.test(file) && !file.endsWith(".test.mjs"))
    .map((file) => [file, path.join(PLUGIN_ROOT, file)]);

// The retired instruction, in the exact shouted spelling both gate messages
// used. Only this spelling: "end the turn" in lower case appears in seven true
// sentences that describe the FALLBACK ("that is the fallback for a wait.mjs
// that cannot run"), and a test that forbade the phrase would forbid its own
// prohibition.
const RETIRED = /END YOUR TURN/;

// A file that discusses waiting for reviewers at all. Deliberately narrow: it
// is the context that must name the script, not every mention of an agent.
const WAIT_CONTEXT = /wait(?:ing|s)? (?:for|on) (?:the |a |every |all )?(?:reviewer|finder|subagent|agent)|after (?:spawning|launching) reviewers|\bListAgents\b/i;

test("no shipped file still teaches the wait this release retired", () => {
  const offenders = shipped().filter(([, full]) => RETIRED.test(readFileSync(full, "utf8"))).map(([rel]) => rel);
  assert.deepEqual(offenders, [],
    "these files tell the model to end its turn to wait; the wait is scripts/wait.mjs, in one call");
});

test("a shipped file that tells the model how to wait for a reviewer names the script", () => {
  // File-level, and that is its limit: it catches a new FILE that gives wait
  // advice without naming wait.mjs, not a stray paragraph inside a file that
  // already names it. The per-message assertions in poll-guard.test.mjs and
  // self-review-gate.test.mjs cover the rendered strings; this covers the tree.
  const silent = shipped()
    .map(([rel, full]) => [rel, readFileSync(full, "utf8")])
    .filter(([, text]) => WAIT_CONTEXT.test(text) && !/wait\.mjs/.test(text))
    .map(([rel]) => rel);
  assert.deepEqual(silent, [],
    "a file that says how to wait for a reviewer must say to use scripts/wait.mjs");
  // An empty offender list reads the same whether the rule holds or the context
  // pattern matches nothing at all, which is the inert-mechanism shape this
  // repo has now shipped three times. So the count is asserted too: the four
  // files that state the rule today are SKILL.md, poll-guard.mjs,
  // self-review-gate.mjs and README.md.
  const matched = shipped().filter(([, full]) => WAIT_CONTEXT.test(readFileSync(full, "utf8")));
  assert.ok(matched.length >= 4, `the wait-context pattern matched only ${matched.length} shipped files; it has stopped engaging`);
});

test("the patterns trip on what they are for, and not on a true sentence about the fallback", () => {
  // Proving the mechanism engaged, which is what angle F asks of anything that
  // can be silently inert: an assertion over a tree that happens to be clean
  // reads exactly like an assertion whose pattern matches nothing.
  assert.match("then END YOUR TURN to let it run", RETIRED);
  assert.doesNotMatch("that is the fallback for a wait.mjs that cannot run, not the way to wait", RETIRED);
  assert.match("After spawning reviewers, wait in ONE call", WAIT_CONTEXT);
  assert.match("waiting for the reviewer to report", WAIT_CONTEXT);
  assert.match("Do not call ListAgents to wait", WAIT_CONTEXT);
  assert.doesNotMatch("the applier reports applied / deviated / blocked", WAIT_CONTEXT);
});

// The same shape one layer over: an agent whose report is its last message.
//
// `salvage.mjs` prints an agent's FINAL message and nothing else, so a reporting
// agent that delivers through `SendMessage` and signs off in prose delivers
// nothing the lead can read. Measured on 2026-09-03 against this session's own
// transcripts: four of five applier runs ended in prose or a markdown table
// rather than the JSON their definition contracts for, and two of the four said
// "Report sent to team-lead" — the report had gone out through the channel that
// dropped three reviewer reports for 2h49m the same day.
const AGENT_FILES = () =>
  walkFiles(path.join(PLUGIN_ROOT, "agents"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => [path.join("agents", file), path.join(PLUGIN_ROOT, "agents", file)]);

test("every agent that reports says its last message is the report, and forbids SendMessage", () => {
  const files = AGENT_FILES();
  assert.ok(files.length >= 4, `only ${files.length} agent files walked — the walk, not the rule, is what failed`);
  const reporting = files.filter(([, full]) => /^## Output — exactly this JSON/m.test(readFileSync(full, "utf8")));
  assert.ok(reporting.length >= 4,
    `only ${reporting.length} agent files declare a JSON output — an empty offender list below would prove nothing`);
  const silent = reporting
    .filter(([, full]) => {
      const text = readFileSync(full, "utf8");
      return !/last message is the report/i.test(text) || !/SendMessage/.test(text);
    })
    .map(([rel]) => rel);
  assert.deepEqual(silent, [],
    "an agent whose report is collected by salvage.mjs must be told the last message IS the report, and told not to send it through SendMessage");
});
