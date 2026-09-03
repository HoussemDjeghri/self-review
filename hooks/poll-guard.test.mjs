// Run: node --test plugin/hooks/poll-guard.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "poll-guard.mjs");
let seq = 0;
const stamp = () => new Date(1_700_000_000_000 + ++seq * 1000).toISOString();
const human = (text) => ({ type: "user", timestamp: stamp(), message: { role: "user", content: text } });
const said = (text) => ({ type: "assistant", timestamp: stamp(), message: { role: "assistant", content: [{ type: "text", text }] } });
const notification = () => ({ type: "user", userType: "external", timestamp: stamp(), message: { role: "user", content: "<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>" } });
// Real shapes, captured 2026-08-22: a completion attached to the next message
// (it landed mid-turn), a named agent's mailbox message, and a Monitor event
// (no <status>, only an <event>).
const attached = () => ({ type: "attachment", timestamp: stamp(), attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>" } });
const teammate = () => human('Another Claude session sent a message:\n<teammate-message teammate_id="r1-a" color="pink">\n{"type":"idle_notification","from":"r1-a","timestamp":"2026-08-22T04:54:22.162Z","idleReason":"available"}\n</teammate-message>');
const monitorEvent = () => ({ type: "user", userType: "external", timestamp: stamp(), message: { role: "user", content: '<task-notification>\n<task-id>byethc2ei</task-id>\n<summary>Monitor event: "bridger channel"</summary>\n<event>#244 status: closed</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>' } });
function call(name, input, output = "ok") {
  const id = `${name}${++seq}`;
  return [
    { type: "assistant", timestamp: stamp(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] } },
  ];
}
const listAgents = () => call("ListAgents", {}, "Subagents (1): ag1 · running");
const peek = () => call("TaskOutput", { task_id: "ag1", block: false, timeout: 0 }, "running");
const sidechainNoise = () => ({ type: "assistant", isSidechain: true, timestamp: stamp(), message: { role: "assistant", content: [{ type: "tool_use", id: `sc${++seq}`, name: "ListAgents", input: {} }] } });

function run(entries, tool = { tool_name: "ListAgents", tool_input: {} }, env = {}, guard = GUARD) {
  const dir = mkdtempSync(path.join(tmpdir(), "pg-"));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, entries.flat().map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  const childEnv = { ...process.env };
  delete childEnv.POLL_GUARD;
  Object.assign(childEnv, env);
  const res = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: "/tmp", hook_event_name: "PreToolUse", ...tool }),
    env: childEnv, encoding: "utf8",
  });
  assert.equal(res.status, 0, `guard must exit 0, stderr: ${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("the first two status checks in a turn are allowed", () => {
  assert.equal(run([human("go"), said("spawned")]), null);
  assert.equal(run([human("go"), ...listAgents()]), null);
});

test("the third ListAgents since anything new arrived is denied, with the reason", () => {
  const out = run([human("go"), ...listAgents(), ...listAgents(), said("still waiting")]);
  assert.ok(denied(out));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /\[poll-guard\] Denied: this would be status check #3/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /end your turn/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /scripts\/wait\.mjs/,
    "the denial must say how to wait, not only how not to");
  assert.match(out.systemMessage, /poll-guard/);
});

test("TaskOutput with block=false counts as a check; block=true never does and is never denied", () => {
  assert.ok(denied(run([human("go"), ...listAgents(), ...peek()])));
  const blocking = call("TaskOutput", { task_id: "ag1", block: true, timeout: 600000 }, "done");
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), ...blocking], { tool_name: "TaskOutput", tool_input: { task_id: "ag1", block: true, timeout: 600000 } }), null);
  assert.ok(denied(run([human("go"), ...listAgents(), ...listAgents()], { tool_name: "TaskOutput", tool_input: { task_id: "ag1", block: false, timeout: 0 } })));
});

test("a task completion, a teammate message, or a new human prompt resets the count", () => {
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), notification(), said("it reported")]), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), attached(), said("it reported")]), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), teammate(), said("it reported")]), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), human("any news?")]), null);
});

test("a Monitor event or a local slash command does not reset the count", () => {
  assert.ok(denied(run([human("go"), ...listAgents(), ...listAgents(), monitorEvent(), monitorEvent(), said("tick")])));
  assert.ok(denied(run([human("go"), ...listAgents(), ...listAgents(), human("<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>")])));
});

test("a hook-feedback (isMeta) message does not reset the count", () => {
  const meta = { type: "user", isMeta: true, timestamp: stamp(), message: { role: "user", content: "Stop hook feedback: x" } };
  assert.ok(denied(run([human("go"), ...listAgents(), ...listAgents(), meta])));
});

test("only answered checks count (the call being evaluated may already be in the transcript)", () => {
  const pendingUse = { type: "assistant", timestamp: stamp(), message: { role: "assistant", content: [{ type: "tool_use", id: "open1", name: "ListAgents", input: {} }] } };
  assert.equal(run([human("go"), ...listAgents(), pendingUse]), null);
});

test("sidechain entries, other tools, and POLL_GUARD=off are ignored", () => {
  assert.equal(run([human("go"), sidechainNoise(), sidechainNoise(), sidechainNoise()]), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents()], { tool_name: "Read", tool_input: { file_path: "/x" } }), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents()], undefined, { POLL_GUARD: "off" }), null);
  assert.equal(run([human("go"), ...listAgents(), ...listAgents(), ...listAgents()], undefined, { POLL_GUARD_MAX: "5" }), null);
});

test("a missing transcript or malformed lines never break the tool call", () => {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ transcript_path: "/nonexistent/t.jsonl", tool_name: "ListAgents", tool_input: {} }), encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
  assert.equal(run(["{not json", human("go"), ...listAgents()]), null);
  assert.ok(denied(run(["{not json", human("go"), ...listAgents(), ...listAgents()])));
});

test("pollGuard.maxChecks from a user config sets the cap", () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "pgcfg-")), "config.json");
  writeFileSync(cfg, JSON.stringify({ pollGuard: { maxChecks: 1 } }));
  const turn = [human("go"), ...listAgents(), said("waiting")];
  assert.ok(denied(run(turn, undefined, { SELF_REVIEW_CONFIG: cfg })), "second check denied at maxChecks=1");
  assert.ok(!denied(run(turn)), "default cap still allows it");
});

test("a missing config/defaults.json does not crash the guard: the fallback cap applies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pgplug-"));
  cpSync(path.join(path.dirname(GUARD)), path.join(root, "hooks"), { recursive: true });
  const turn = [human("go"), ...listAgents(), ...listAgents(), said("waiting")];
  assert.ok(denied(run(turn, undefined, {}, path.join(root, "hooks/poll-guard.mjs"))));
});
