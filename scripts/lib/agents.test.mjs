// Run: node --test plugin/scripts/lib/agents.test.mjs   (or ./test.sh for everything)
//
// The status predicate is the whole reason wait.mjs is safe to block on, and
// every case below is one that was got wrong in the field: `end_turn` treated
// as required (three finished agents in four called partial), the role check
// dropped (an agent mid-tool read as finished), and the settle window absent
// (a report claimed while the model was still mid-message).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentStatus, findAgentFiles, readAgent } from "./agents.mjs";

const CONFIG = { settleSeconds: 60, staleSeconds: 660 };
let seq = 0;
const stamp = () => new Date(1_700_000_000_000 + ++seq * 1000).toISOString();
const text = (t) => ({ type: "text", text: t });
const uses = (name) => ({ type: "tool_use", id: `t${++seq}`, name, input: {} });
const said = (content, stop = null) => ({
  type: "assistant", timestamp: stamp(),
  message: { role: "assistant", stop_reason: stop, usage: { input_tokens: 1000, cache_read_input_tokens: 9000 }, content },
});
const toolResult = () => ({ type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const banner = () => ({
  type: "assistant", timestamp: stamp(),
  message: { role: "assistant", stop_reason: "stop_sequence", usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, content: [text("You've hit your session limit")] },
});

// The harness's terminal notice, in the shape measured on 2026-09-04 across
// 894 subagent transcripts: an assistant entry flagged `isApiErrorMessage`,
// `<synthetic>` model, zeroed usage, and — for the 89 quota refusals of the 93
// — a `quotaLimits` block. Two of those 89 carried the reset text with no
// block, which is why the classifier ORs the two tests and why this builder
// can produce that combination.
const apiError = (body, quotaLimits) => ({
  type: "assistant", timestamp: stamp(), isApiErrorMessage: true, error: body,
  ...(quotaLimits ? { quotaLimits } : {}),
  message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 }, content: [text(body)] },
});

let dir = null;
const transcript = (name, entries, ageSeconds = 0) => {
  dir ??= mkdtempSync(path.join(tmpdir(), "agents-"));
  const file = path.join(dir, `agent-a${name}-0123456789abcdef.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (ageSeconds) {
    const when = Date.now() / 1000 - ageSeconds;
    utimesSync(file, when, when);
  }
  return readAgent(file);
};
const at = (agent, quietSeconds) => agentStatus(agent, agent.mtimeMs + quietSeconds * 1000, CONFIG);

test("a report with a null stop_reason is finished once the file is quiet", () => {
  // 91 of 119 transcripts sampled carry a null stop_reason and only 16 carry
  // end_turn, so requiring end_turn is what made salvage.mjs wrong.
  const agent = transcript("null-stop", [said([text("here is my report")])]);
  assert.equal(at(agent, 5), "active", "not yet settled");
  assert.equal(at(agent, 61), "finished");
});

test("end_turn is believed immediately, without waiting out the settle window", () => {
  const agent = transcript("end-turn", [said([text("done")], "end_turn")]);
  assert.equal(at(agent, 0), "finished");
});

test("a text block followed by a tool call in the same message is not a report", () => {
  // Measured: a text entry is followed by the tool_use entry of the same
  // message up to 31.9 s later. Inside the settle window it still reads active.
  const agent = transcript("mid-message", [said([text("checking one thing"), uses("Read")], "tool_use")]);
  assert.equal(at(agent, 5), "active");
  assert.equal(at(agent, 61), "active", "a tool_use entry is never a report, however quiet the file goes");
  assert.equal(at(agent, 700), "dead");
});

test("a tool_result entry is not a report, however long it sits there", () => {
  // The mistake made by hand on 2026-09-03: a `user` entry of tool_result
  // blocks has no tool_use block either, so dropping the role check reported
  // two hung agents as finished.
  const agent = transcript("hung", [said([text("running the suite"), uses("Bash")], "tool_use"), toolResult()]);
  assert.equal(at(agent, 61), "active");
  assert.equal(at(agent, 700), "dead");
});

test("the harness's session-limit banner is not the agent's report", () => {
  const agent = transcript("banner", [said([text("mid-work"), uses("Bash")], "tool_use"), banner()]);
  assert.equal(agent.endsWithReport, false);
  assert.equal(at(agent, 61), "active");
});

test("readAgent reports the calls, the context, the texts and when it started", () => {
  const agent = transcript("counts", [said([text("one"), uses("Read")], "tool_use"), toolResult(), said([text("two")], "end_turn")]);
  assert.equal(agent.calls, 2, "only the entries the model was billed for");
  assert.equal(agent.ctx, 10_000);
  assert.deepEqual(agent.texts, ["one", "two"]);
  assert.ok(agent.startedMs > 0);
  assert.match(agent.stem, /^acounts-/);
});

test("a torn final line does not stop the rest being read", () => {
  const entries = [said([text("all good")], "end_turn")];
  dir ??= mkdtempSync(path.join(tmpdir(), "agents-"));
  const file = path.join(dir, "agent-atorn-aaaaaaaaaaaaaaaa.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + '{"type":"assis');
  const agent = readAgent(file);
  assert.equal(agent.calls, 1);
  assert.equal(agent.endsWithReport, true);
});

test("findAgentFiles returns a name's transcripts newest first, dropping ones older than the floor", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agents-find-"));
  mkdirSync(home, { recursive: true });
  const write = (stem, ageSeconds) => {
    const file = path.join(home, `agent-a${stem}.jsonl`);
    writeFileSync(file, JSON.stringify(said([text("x")], "end_turn")) + "\n");
    const when = Date.now() / 1000 - ageSeconds;
    utimesSync(file, when, when);
    return file;
  };
  const old = write("finder-r1-ab-1111111111111111", 3600);
  const fresh = write("finder-r1-ab-2222222222222222", 10);
  const other = write("finder-r1-cd-3333333333333333", 10);
  const since = Date.now() - 600 * 1000;
  assert.deepEqual(findAgentFiles(home, "finder-r1-ab", since), [fresh], "the previous attempt is not this round's agent");
  assert.deepEqual(findAgentFiles(home, "finder-r1-ab", 0), [fresh, old], "newest first");
  assert.deepEqual(findAgentFiles(home, "finder-r1-cd", 0), [other]);
  assert.deepEqual(findAgentFiles(path.join(home, "nope"), "finder-r1-ab", 0), []);
});

test("a longer stem that merely starts with the name loses to the name's own transcript", () => {
  // The harness renames a colliding agent by appending `-2`, so
  // `agent-aX-2-<hash>.jsonl` is a DIFFERENT agent from `agent-aX-<hash>.jsonl`
  // — and when it renamed the agent we asked for, the `-2` file is the only one
  // there is. Reproduced live on 2026-09-03: a query for a finder returned a
  // sibling's transcript, with the sibling's call count and last-write time.
  const home = mkdtempSync(path.join(tmpdir(), "agents-rank-"));
  const write = (stem, ageSeconds) => {
    const file = path.join(home, `agent-a${stem}.jsonl`);
    writeFileSync(file, JSON.stringify(said([text("x")], "end_turn")) + "\n");
    const when = Date.now() / 1000 - ageSeconds;
    utimesSync(file, when, when);
    return file;
  };
  const renamedSibling = write("finder-r1-ab-2-aaaaaaaaaaaaaaaa", 5);
  const own = write("finder-r1-ab-bbbbbbbbbbbbbbbb", 60);
  assert.deepEqual(findAgentFiles(home, "finder-r1-ab", 0), [own, renamedSibling],
    "the exact match wins even though the sibling's transcript is newer");
  assert.deepEqual(findAgentFiles(home, "finder-r1-ab-2", 0), [renamedSibling]);
});

test("a name the harness itself renamed still resolves, because ranking does not exclude", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agents-renamed-"));
  const file = path.join(home, "agent-afinder-r1-gqv-2-cccccccccccccccc.jsonl");
  writeFileSync(file, JSON.stringify(said([text("x")], "end_turn")) + "\n");
  assert.deepEqual(findAgentFiles(home, "finder-r1-gqv", 0), [file],
    "four of six agents in the round that found this were renamed this way");
});

test("a transcript ending on an API error is stalled, not active and not dead", () => {
  // Measured 2026-09-04: 93 of 894 transcripts end on one of these and NONE
  // ever continued past it. Before this, all 93 read `active` until the round
  // budget burned and were then called dead — a reviewer whose work and context
  // were intact, thrown away after 30 minutes of an idle lead.
  const agent = transcript("stalled-1", [said([text("reading"), uses("Read")]), apiError("API Error: Connection lost mid-response. The response above may be incomplete.")]);
  assert.equal(at(agent, 0), "stalled");
  assert.equal(at(agent, 5), "stalled");      // immediately, with no settle window
  assert.equal(at(agent, 100_000), "stalled"); // and it never decays into `dead`
  assert.equal(agent.apiError.kind, "transient");
});

test("a quota refusal is stalled but NOT resumable, because a nudge spends another one", () => {
  const agent = transcript("stalled-2", [said([text("reading"), uses("Read")]),
    apiError("You've hit your session limit · resets 6:20pm (Africa/Algiers)", { status: "rejected", resetsAt: 1787327400 })]);
  assert.equal(at(agent, 0), "stalled");
  assert.equal(agent.apiError.kind, "quota");
  assert.match(agent.apiError.text, /resets 6:20pm/, "the reset time is the one fact the caller needs, so it is carried verbatim");
});

test("a quota refusal with no quotaLimits block is still a quota refusal", () => {
  // Two of the 89 measured refusals had the text and no block. Either test
  // alone would have called those resumable and sent a nudge into a rejection.
  const agent = transcript("stalled-3", [said([text("x"), uses("Read")]), apiError("You've hit your session limit · resets 3:30pm (Africa/Algiers)")]);
  assert.equal(agent.apiError.kind, "quota");
});

test("an API error entry is not mistaken for the agent's report", () => {
  // It is an assistant entry carrying text and no tool_use — the report shape
  // exactly — and only the billing check keeps it out. If that check is ever
  // relaxed, this fails rather than a stalled agent being collected as done.
  const agent = transcript("stalled-4", [said([text("x"), uses("Read")]), apiError("API Error: 522")]);
  assert.equal(agent.endsWithReport, false);
  assert.equal(at(agent, 100_000), "stalled");
});

test("a healthy transcript has no apiError, so the status logic is untouched by this", () => {
  const agent = transcript("healthy-1", [said([text("done")], "end_turn")]);
  assert.equal(agent.apiError, null);
  assert.equal(at(agent, 0), "finished");
});

test("an API-error shape this plugin has not measured is `unknown`, never assumed resumable", () => {
  // The two kinds above are a closed list, taken from one machine on one day. A
  // reworded refusal or another quotaLimits.status falls through both — and
  // guessing `transient` there tells the lead to nudge a live quota refusal,
  // spending the very thing the classification exists to protect.
  const agent = transcript("stalled-5", [said([text("x"), uses("Read")]),
    apiError("Request throttled by the upstream gateway", { status: "throttled" })]);
  assert.equal(at(agent, 0), "stalled");
  assert.equal(agent.apiError.kind, "unknown");
});
