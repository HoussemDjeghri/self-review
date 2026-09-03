// Run: node --test plugin/scripts/salvage.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SALVAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "salvage.mjs");
let seq = 0;
const stamp = () => new Date(1_700_000_000_000 + ++seq * 1000).toISOString();
const entry = (content, stop = null) => ({ type: "assistant", timestamp: stamp(), message: { role: "assistant", stop_reason: stop, usage: { input_tokens: 1000, cache_read_input_tokens: 99_000 }, content } });
const uses = (name) => ({ type: "tool_use", id: `t${++seq}`, name, input: {} });
const result = () => ({ type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const text = (t) => ({ type: "text", text: t });
const banner = () => ({ type: "assistant", timestamp: stamp(), message: { role: "assistant", stop_reason: "stop_sequence", usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, content: [text("You've hit your session limit · resets 3:30pm")] } });
const jsonl = (es) => es.map((e) => JSON.stringify(e)).join("\n") + "\n";

function layout() {
  const root = mkdtempSync(path.join(tmpdir(), "salv-"));
  const dir = path.join(root, "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agent-afind1-0123456789abcdef.jsonl"), jsonl([
    entry([text("reading the scope"), uses("Read")], "tool_use"),
    result(),
    entry([text('```json\n[{"file":"src/x.ts","line":42,"summary":"the report"}]\n```')], "end_turn"),
  ]));
  writeFileSync(path.join(dir, "agent-afind2-fedcba9876543210.jsonl"), jsonl([
    entry([text("notes: suspect x.ts:42 double free")], "end_turn"),
    entry([uses("Bash")], "tool_use"), // killed while a tool call was in flight
    banner(), // the harness's session-limit notice: an assistant entry with zeroed usage
  ]));
  writeFileSync(path.join(dir, "not-a-transcript.txt"), "ignore me\n");
  return { root, dir };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SALVAGE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("the listing names every agent with its status, call count and context", () => {
  const { dir } = layout();
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /afind1-0123456789abcdef\s+finished\s+2 calls/);
  assert.match(r.stdout, /afind2-fedcba9876543210\s+active\s+2 calls  ctx 100k/);
  assert.match(r.stdout, /100k/);
  assert.ok(!r.stdout.includes("not-a-transcript"));
});

test("naming an agent prints its last message; --all-text prints everything it said", () => {
  const { dir } = layout();
  const done = run([dir, "find1"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /=== .*find1.* finished/);
  assert.match(done.stdout, /"file":"src\/x\.ts"/);
  assert.ok(!done.stdout.includes("reading the scope"));
  const partial = run([dir, "find2"]);
  assert.match(partial.stdout, /active/);
  assert.match(partial.stdout, /suspect x\.ts:42/);
  assert.ok(!partial.stdout.includes("session limit"), "harness banners are not the agent's work");
  const all = run([dir, "find1", "--all-text"]);
  assert.ok(all.stdout.includes("reading the scope"));
});

test("the place can be the session dir, the session jsonl, or a bare id under the projects root", () => {
  const { root, dir } = layout();
  assert.match(run([path.dirname(dir)]).stdout, /afind1/);
  writeFileSync(path.join(root, "sess-1.jsonl"), "");
  assert.match(run([path.join(root, "sess-1.jsonl")]).stdout, /afind1/);
  const cfg = mkdtempSync(path.join(tmpdir(), "salv-cfg-"));
  const proj = path.join(cfg, "projects", "-Users-x-proj");
  mkdirSync(path.join(proj, "sess-9", "subagents"), { recursive: true });
  writeFileSync(path.join(proj, "sess-9", "subagents", "agent-az9-aa.jsonl"), jsonl([entry([text("hi")], "end_turn")]));
  assert.match(run(["sess-9"], { CLAUDE_CONFIG_DIR: cfg }).stdout, /az9/);
});

test("a torn final line and a zero-call transcript are handled", () => {
  const { dir } = layout();
  writeFileSync(path.join(dir, "agent-atorn-1234.jsonl"),
    jsonl([entry([text("all good")], "end_turn")]) + JSON.stringify(entry([text("mid-write")])).slice(0, 40));
  writeFileSync(path.join(dir, "agent-azero-5678.jsonl"),
    jsonl([{ type: "user", timestamp: stamp(), message: { role: "user", content: "brief" } }]));
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /atorn-1234\s+finished\s+1 calls/);
  assert.match(r.stdout, /azero-5678\s+active\s+0 calls/);
  assert.match(run([dir, "azero"]).stdout, /\(no text yet\)/);
});

// The status is about silence, not about the transcript alone: the same file
// reads `active` while it is warm and `dead` once nothing has touched it for
// longer than a reviewer's longest single tool call.
test("a transcript nothing has written to for a long time reads dead, not active", () => {
  const { dir } = layout();
  const cut = path.join(dir, "agent-afind2-fedcba9876543210.jsonl");
  const longAgo = Date.now() / 1000 - 20 * 60;
  utimesSync(cut, longAgo, longAgo);
  assert.match(run([dir]).stdout, /afind2-fedcba9876543210\s+dead\s+2 calls/);
});

test("a tilde CLAUDE_CONFIG_DIR is expanded, like the sibling hooks do", () => {
  const home = mkdtempSync(path.join(tmpdir(), "salv-home-"));
  const proj = path.join(home, "cfg", "projects", "-Users-x-p");
  mkdirSync(path.join(proj, "sess-7", "subagents"), { recursive: true });
  writeFileSync(path.join(proj, "sess-7", "subagents", "agent-atil-bb.jsonl"), jsonl([entry([text("hi")], "end_turn")]));
  assert.match(run(["sess-7"], { HOME: home, CLAUDE_CONFIG_DIR: "~/cfg" }).stdout, /atil/);
});

test("an unknown place fails loudly and an unknown name is reported", () => {
  const missing = run(["/nope/nothing-here"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no subagent transcripts/i);
  const { dir } = layout();
  const miss = run([dir, "ghost"]);
  assert.notEqual(miss.status, 0);
  assert.match(miss.stderr, /ghost/);
});
