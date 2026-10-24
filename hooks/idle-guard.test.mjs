// Run: node --test plugin/hooks/idle-guard.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "idle-guard.mjs");

// Shapes captured from Claude Code 2.1.310 by a logging SubagentStop hook,
// 2026-10-24: the agent's own entry is listed as type "subagent", and a shell
// it backgrounded as type "shell" with its command.
const self = { id: "abd25150eb331b382", type: "subagent", status: "running", description: "Probe agent", agent_type: "general-purpose" };
const shell = (id = "bxbzsm6f2", status = "running") => ({ id, type: "shell", status, description: "Sleep 45 seconds then echo finished", command: "sleep 45; echo finished" });
// A Monitor is listed as a shell with the command it watches, and its launch
// result names the task id (captured from a subagent, 2026-10-24, probe 3).
const monitor = (id = "b0udswv42") => ({ id, type: "shell", status: "running", description: "tick event after 30 seconds", command: "sleep 30; echo tick-event" });
const MONITOR_STARTED = (id) => `Monitor started (task ${id}, expires in 1m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`;

let seq = 0;
function launch(id, tool = "Bash", text = `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output. You will be notified when it completes — do not poll that file or sleep while waiting.`) {
  const useId = `toolu_${++seq}`;
  return [
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: useId, name: tool, input: { command: "sleep 45; echo finished", run_in_background: true } }] } },
    { type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: text }] } },
  ];
}
const said = (text) => ({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text }] } });

function run({ entries = [], tasks, active = false, transcript, env = {}, raw } = {}) {
  let transcriptPath = transcript;
  if (transcriptPath === undefined) {
    transcriptPath = path.join(mkdtempSync(path.join(tmpdir(), "ig-")), "agent.jsonl");
    writeFileSync(transcriptPath, entries.flat().map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  }
  const payload = raw ?? {
    session_id: "s", transcript_path: "/tmp/lead.jsonl", cwd: "/tmp", hook_event_name: "SubagentStop",
    stop_hook_active: active, agent_id: self.id, agent_transcript_path: transcriptPath,
    last_assistant_message: "waiting", ...(tasks === undefined ? {} : { background_tasks: tasks }),
  };
  const childEnv = { ...process.env };
  delete childEnv.IDLE_GUARD;
  Object.assign(childEnv, env);
  const res = spawnSync(process.execPath, [GUARD], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: childEnv, encoding: "utf8" });
  assert.equal(res.status, 0, `guard must exit 0, stderr: ${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}
const blocked = (out) => out?.decision === "block";

const loopOf = (out) => out.reason.split("\n").find((l) => l.startsWith("  _idle_done() {"));

test("a running shell this agent launched blocks the stop, with the in-call wait", () => {
  const out = run({ entries: [launch("bxbzsm6f2"), said("waiting")], tasks: [self, shell()] });
  assert.ok(blocked(out));
  assert.match(out.reason, /^\[idle-guard\] Not yet/);
  assert.match(out.reason, /bxbzsm6f2 \(shell: sleep 45; echo finished\)/);
  assert.match(out.reason, /timeout 600000/);
  assert.match(out.reason, /SECONDS\+570/, "the loop is bounded so one call cannot outlive the timeout");
  assert.ok(loopOf(out).includes("tail -n 1 '/tmp/tasks/bxbzsm6f2.output'"), "the path is the one its launch result named");
  assert.doesNotMatch(out.reason, /pgrep/, "no pattern guessed from the command");
  assert.match(out.reason, /does not help/, "Monitor stalls the same way and must not be offered as the wait");
  assert.match(out.reason, /still-running a second time/, "a changed marker has a way out");
  assert.match(out.reason, /you will not be stopped again/);
  assert.match(out.systemMessage, /idle-guard/);
});

test("every owned job is in the loop, and one whose launch named no file is named instead", () => {
  const two = run({ entries: [launch("bj1"), launch("bj2")], tasks: [shell("bj1"), shell("bj2")] });
  assert.ok(loopOf(two).includes("'/tmp/tasks/bj1.output'") && loopOf(two).includes("'/tmp/tasks/bj2.output'"));
  assert.match(loopOf(two), /_idle_done\(\) \{ .+ && .+; \}/, "done only when every job has ended");
  const mixed = run({ entries: [launch("bj3"), launch("b0udswv42", "Monitor", MONITOR_STARTED("b0udswv42"))], tasks: [shell("bj3"), monitor()] });
  assert.ok(loopOf(mixed).includes("'/tmp/tasks/bj3.output'"));
  assert.doesNotMatch(loopOf(mixed), /b0udswv42/);
  assert.match(mixed.reason, /Not in the loop: b0udswv42/);
  const only = run({ entries: [launch("b0udswv42", "Monitor", MONITOR_STARTED("b0udswv42"))], tasks: [monitor()] });
  assert.ok(blocked(only));
  assert.equal(loopOf(only), undefined, "no loop with nothing to watch");
  assert.match(only.reason, /Monitor ends at its own expiry/);
});

test("a path is taken only for that id, and never one holding a quote", () => {
  const other = run({ entries: [launch("bq1", "Bash", "Command running in background with ID: bq1. Output is being written to: /tmp/tasks/bq2.output. You will be notified when it completes.")], tasks: [shell("bq1")] });
  assert.equal(loopOf(other), undefined, "another task's file is not this one's");
  const quoted = run({ entries: [launch("bq3", "Bash", "Command running in background with ID: bq3. Output is being written to: /tmp/it's/tasks/bq3.output. You will be notified when it completes.")], tasks: [shell("bq3")] });
  assert.equal(loopOf(quoted), undefined);
  assert.match(quoted.reason, /Not in the loop: bq3/);
});

test("a pending shell and a running monitor it launched block too", () => {
  assert.ok(blocked(run({ entries: [launch("bp1")], tasks: [shell("bp1", "pending")] })));
  assert.ok(blocked(run({ entries: [launch("b0udswv42", "Monitor", MONITOR_STARTED("b0udswv42"))], tasks: [monitor()] })));
});

// The harness's record of a block, as it lands in the agent's transcript
// (captured from probe 4's subagent, Claude Code 2.1.310, 2026-10-24).
const record = (reason) => ({ type: "attachment", isSidechain: true, attachment: { type: "hook_blocking_error", hookName: "SubagentStop", toolUseID: "0f6c", hookEvent: "SubagentStop", blockingError: { blockingError: reason, command: `node ${GUARD}` } } });

test("with no record of an earlier block, the stop after one is let through", () => {
  assert.equal(run({ entries: [launch("bxbzsm6f2")], tasks: [self, shell()], active: true }), null);
});

test("a job an earlier block named is never blocked again, in this continuation or a later one", () => {
  const first = run({ entries: [launch("bxbzsm6f2")], tasks: [self, shell()] });
  assert.ok(blocked(first));
  const entries = [launch("bxbzsm6f2"), record(first.reason)];
  assert.equal(run({ entries, tasks: [self, shell()], active: true }), null);
  assert.equal(run({ entries, tasks: [self, shell()] }), null, "a server named once is not re-blocked at every later turn end");
  assert.match(first.reason, /not be stopped again for this job/);
});

test("a job launched after a block is blocked on its own, and the one already named is left out", () => {
  const first = run({ entries: [launch("bj1")], tasks: [self, shell("bj1")] });
  const out = run({ entries: [launch("bj1"), record(first.reason), launch("bj2")], tasks: [self, shell("bj1"), shell("bj2")], active: true });
  assert.ok(blocked(out), "stop_hook_active alone no longer lets a new job through");
  assert.match(out.reason, /still running — bj2 \(shell/);
  assert.doesNotMatch(out.reason.split("\n")[0], /bj1/);
  assert.ok(loopOf(out).includes("/tmp/tasks/bj2.output") && !loopOf(out).includes("bj1"), loopOf(out));
});

test("a multi-line command does not hide a later job from the record", () => {
  const multi = { ...shell("bm1"), command: "cd /x &&\n  npm run build <<EOF\nhi\nEOF" };
  const first = run({ entries: [launch("bm1"), launch("bm2")], tasks: [self, multi, shell("bm2")] });
  assert.match(first.reason.split("\n")[0], /bm1 \(shell: cd \/x && npm run build <<EOF hi EOF\); bm2 \(shell/);
  const entries = [launch("bm1"), launch("bm2"), record(first.reason)];
  assert.equal(run({ entries, tasks: [self, multi, shell("bm2")], active: true }), null, "both were named, so neither is blocked again");
});

test("the path is the first one named, and a long run of :/ does not stall the hook", () => {
  const later = [{ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_l", content: "bk1 see /tmp/other/tasks/bk1.output" }] } }];
  assert.ok(loopOf(run({ entries: [launch("bk1"), later], tasks: [self, shell("bk1")] })).includes("'/tmp/tasks/bk1.output'"));
  const noise = [{ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_n", content: `bk2 ${":/".repeat(80000)}` }] } }];
  const started = Date.now();
  assert.ok(blocked(run({ entries: [launch("bk2"), noise], tasks: [self, shell("bk2")] })));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("a command quoting another job's id does not mark that job as named", () => {
  const quoting = { ...shell("bn1"), command: "echo x; bn2 (shell: sleep 45)" };
  const first = run({ entries: [launch("bn1")], tasks: [self, quoting] });
  assert.match(first.reason, /^\[idle-guard\] Not yet \(bn1\):/);
  const out = run({ entries: [launch("bn1"), record(first.reason), launch("bn2")], tasks: [self, quoting, shell("bn2")], active: true });
  assert.ok(blocked(out), "bn2 was never blocked, so it is blocked now");
  assert.match(out.reason, /^\[idle-guard\] Not yet \(bn2\):/);
});

test("a record whose id list cannot be read counts as none, so the stop after it goes through", () => {
  const old = record("[idle-guard] Not yet: background work you started is still running — bo1 (shell: sleep 45).");
  assert.equal(run({ entries: [launch("bo1"), old], tasks: [self, shell("bo1")], active: true }), null);
});

test("a reason quoted in a tool result is not a record of a block", () => {
  const first = run({ entries: [launch("bj3")], tasks: [self, shell("bj3")] });
  const quoted = [{ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: first.reason }] } }];
  assert.ok(blocked(run({ entries: [launch("bj3"), quoted], tasks: [self, shell("bj3")] })));
  assert.equal(run({ entries: [launch("bj3"), quoted], tasks: [self, shell("bj3")], active: true }), null, "still bounded: no record, so the stop after a block goes through");
});

test("finished work, the agent's own entry, and other task types never block", () => {
  assert.equal(run({ entries: [launch("bxbzsm6f2")], tasks: [self, shell("bxbzsm6f2", "completed")] }), null);
  assert.equal(run({ entries: [launch("bxbzsm6f2")], tasks: [self] }), null);
  assert.equal(run({ entries: [launch("bxbzsm6f2")], tasks: [] }), null);
  assert.equal(run({ entries: [launch("bxbzsm6f2")] }), null, "no background_tasks field");
  assert.equal(run({ entries: [launch("bxbzsm6f2")], tasks: [{ id: "aprobe4-65c50f35098885e6", type: "teammate", status: "running", description: "probe4" }] }), null, "a teammate's own entry (agent-team mode)");
});

test("a task this agent did not launch is someone else's and never blocks", () => {
  // The registry has no owner field and may list the lead's or another teammate's tasks.
  assert.equal(run({ entries: [launch("bmine1"), said("done")], tasks: [shell("blead99")] }), null);
  // A mention outside a tool result (the lead naming a task in the prompt) is not a launch.
  const prompt = { type: "user", isSidechain: true, message: { role: "user", content: "the lead's task blead99 is running" } };
  assert.equal(run({ entries: [prompt, said("ok")], tasks: [shell("blead99")] }), null);
  // An id that is only a prefix of a longer token is not a match.
  assert.equal(run({ entries: [launch("bxbzsm6f2extra")], tasks: [shell("bxbzsm6f2")] }), null);
});

test("only the owned tasks are named when the list is mixed", () => {
  const out = run({ entries: [launch("bmine1")], tasks: [self, shell("blead99"), shell("bmine1")] });
  assert.ok(blocked(out));
  assert.match(out.reason, /bmine1/);
  assert.doesNotMatch(out.reason, /blead99/);
});

test("no transcript, an empty path, malformed input, or IDLE_GUARD=off never block and exit 0", () => {
  assert.equal(run({ tasks: [shell()], transcript: "" }), null);
  assert.equal(run({ tasks: [shell()], transcript: "/nonexistent/agent.jsonl" }), null);
  assert.equal(run({ raw: "{not json" }), null);
  assert.equal(run({ raw: { hook_event_name: "SubagentStop", background_tasks: "nope" } }), null);
  assert.equal(run({ entries: ["{torn line", launch("bxbzsm6f2")], tasks: [shell()], env: { IDLE_GUARD: "off" } }), null);
  assert.ok(blocked(run({ entries: ["{torn line", launch("bxbzsm6f2")], tasks: [shell()] })), "a torn line does not hide a real launch");
});

const hasBash = spawnSync("sh", ["-c", "command -v bash"]).status === 0;

/** Runs the generated loop for a job whose output file is `file`, with the
 *  bound and the poll shortened, and returns what it printed and how long. */
function runLoop(file, bound = 20) {
  const id = path.basename(file, ".output");
  const out = run({ entries: [launch(id, "Bash", `Command running in background with ID: ${id}. Output is being written to: ${file}. You will be notified when it completes — do not poll that file or sleep while waiting.`)], tasks: [shell(id)] });
  const loop = loopOf(out).replace("sleep 15", "sleep 0.2").replace("SECONDS+570", `SECONDS+${bound}`);
  const started = Date.now();
  const res = spawnSync("bash", ["-c", loop], { encoding: "utf8" });
  return { printed: res.stdout.trim(), elapsed: Date.now() - started };
}

test("the wait loop runs: it waits while the job writes, and ends on the harness's exit line", { skip: !hasBash && "needs bash" }, () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "ig-run-")), "tasks", "bx1.output");
  mkdirSync(path.dirname(file));
  writeFileSync(file, "working\n");
  const job = spawn("sh", ["-c", `sleep 1.6; printf 'done\\n[exited with code 0]\\n' >> '${file}'`], { stdio: "ignore" });
  const { printed, elapsed } = runLoop(file);
  job.kill();
  assert.equal(printed, "finished");
  assert.ok(elapsed > 1200 && elapsed < 10000, `waited ${elapsed} ms: under 1.2 s means it never waited, over 10 s means it missed the line`);
});

test("[killed] ends the wait, and an exit line that is not the whole last line does not", { skip: !hasBash && "needs bash" }, () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ig-run-")), "tasks");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "bk1.output"), "partial\n[killed]\n");
  assert.equal(runLoop(path.join(dir, "bk1.output")).printed, "finished");
  writeFileSync(path.join(dir, "bk2.output"), "echo [exited with code 0] later\n");
  assert.equal(runLoop(path.join(dir, "bk2.output"), 1).printed, "still-running");
  assert.equal(runLoop(path.join(dir, "bk3.output"), 1).printed, "still-running", "a missing file is not done");
});
