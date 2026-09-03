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
