// Run: node --test plugin/scripts/wait.test.mjs   (or ./test.sh for everything)
//
// The clock is injected and `sleep` advances it, so a 570-second call runs in
// milliseconds. File mtimes are real, which is the point: the quiet time these
// tests exercise is the difference between the injected now and a real mtime,
// exactly as it is in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deadAdvice, main, makeReader, orphanAdvice, render, sessionIdFrom } from "./wait.mjs";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let seq = 0;
// Entry timestamps sit just after the round's scope.diff, as a real agent's do:
// wait.mjs uses that ordering to tell this round's agent from an earlier one.
const stamp = (baseMs) => new Date(baseMs + ++seq * 100).toISOString();
const text = (t) => ({ type: "text", text: t });
const uses = (name) => ({ type: "tool_use", id: `t${++seq}`, name, input: {} });
const said = (content, stop = null, baseMs = Date.now()) => ({
  type: "assistant", timestamp: stamp(baseMs),
  message: { role: "assistant", stop_reason: stop, usage: { input_tokens: 1000, cache_read_input_tokens: 9000 }, content },
});

// A work dir shaped like the session scratchpad, plus the subagents directory
// the harness writes transcripts into.
function layout({ names = ["self-review-finder-r1-ab"], round = 1, scopeAgeSeconds = 120 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wait-"));
  const work = path.join(root, SESSION, "scratchpad", "self-review");
  const roundDir = path.join(work, `round-${round}`);
  mkdirSync(path.join(roundDir, "briefs"), { recursive: true });
  mkdirSync(path.join(roundDir, "state"), { recursive: true });
  const subagents = path.join(root, "projects", SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  for (const name of names) writeFileSync(path.join(roundDir, "briefs", `${name}.md`), "# brief\n");
  const scope = path.join(roundDir, "scope.diff");
  writeFileSync(scope, "diff --git a/x b/x\n");
  const scopeWhen = Date.now() / 1000 - scopeAgeSeconds;
  utimesSync(scope, scopeWhen, scopeWhen);
  return { root, work, roundDir, subagents };
}

const spawn = ({ subagents, name, entries, hash = "0123456789abcdef", ageSeconds = 0 }) => {
  const file = path.join(subagents, `agent-a${name}-${hash}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (ageSeconds) {
    const when = Date.now() / 1000 - ageSeconds;
    utimesSync(file, when, when);
  }
  return file;
};

const report = (baseMs) => [said([text("reading"), uses("Read")], "tool_use", baseMs), said([text('```json\n[]\n```')], "end_turn", baseMs)];
const working = (baseMs) => [said([text("reading"), uses("Read")], "tool_use", baseMs)];
// The harness's terminal API-error notice — the shape measured on 2026-09-04.
const stalledOn = (body, quotaLimits, baseMs = Date.now()) => [
  said([text("reading"), uses("Read")], "tool_use", baseMs),
  { type: "assistant", timestamp: stamp(baseMs), isApiErrorMessage: true, error: body, ...(quotaLimits ? { quotaLimits } : {}),
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 }, content: [text(body)] } },
];

// Runs main with a clock that only moves when the script sleeps, so a call that
// blocks for its full ceiling costs no wall-clock time here.
async function run(argv, { start = Date.now(), config } = {}) {
  const lines = [];
  let clock = start;
  const previous = process.env.SELF_REVIEW_CONFIG;
  if (config) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "wait-cfg-")), "config.json");
    writeFileSync(file, JSON.stringify({ wait: config }));
    process.env.SELF_REVIEW_CONFIG = file;
  }
  try {
    const code = await main(argv, {
      log: (line) => lines.push(line),
      now: () => clock,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
    });
    return { code, out: lines.join("\n"), elapsed: clock - start };
  } finally {
    if (config) {
      if (previous === undefined) delete process.env.SELF_REVIEW_CONFIG;
      else process.env.SELF_REVIEW_CONFIG = previous;
    }
  }
}

test("every reviewer finished: exits 0 at once, names them, and points at the collect step", async () => {
  const { work, subagents, roundDir } = layout({ names: ["f-ab", "f-cd"] });
  spawn({ subagents, name: "f-ab", entries: report() });
  spawn({ subagents, name: "f-cd", entries: report(), hash: "fedcba9876543210" });
  writeFileSync(path.join(roundDir, "state", "f-ab.jsonl"), '{"summary":"one"}\n{"summary":"two"}\n');
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /f-ab\s+finished\s+.*2 calls\s+2 filed/);
  // "no file" and "0 filed" are different news and the table must not spell
  // them the same: f-cd never wrote a lifeboat, which is normal for a finder
  // with nothing to report — a lead that reads it as "found nothing" when the
  // findings are on disk under another name stops trusting the column.
  assert.match(r.out, /f-cd\s+finished\s+.*no file/);
  assert.match(r.out, /# settled — 2 finished, 0 stalled, 0 dead/);
  assert.equal(r.elapsed, 0, "a settled round does not sleep");
});

test("the filed column counts candidates, not lines", async () => {
  // Reproduced live on 2026-09-08, round 7 of this repo's own review: a finder
  // with nothing to report wrote `[]` into its lifeboat — the empty-list form
  // its own agent file tells it to return — and the column read `1 filed`. The
  // lead went looking for a candidate that did not exist. The mirror case is
  // worse: a dying finder salvaged as one JSON array puts every candidate it
  // had on a single line, which the same count renders as `1`.
  const { work, subagents, roundDir } = layout({ names: ["f-ab", "f-cd"] });
  spawn({ subagents, name: "f-ab", entries: report() });
  spawn({ subagents, name: "f-cd", entries: report(), hash: "fedcba9876543210" });
  writeFileSync(path.join(roundDir, "state", "f-ab.jsonl"), "[]\n");
  writeFileSync(path.join(roundDir, "state", "f-cd.jsonl"), '[{"summary":"one"},{"summary":"two"}]\n{"summary":"three"}\n');
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.match(r.out, /f-ab\s+finished\s+.*0 filed/, "an empty list is zero candidates, not one line");
  assert.match(r.out, /f-cd\s+finished\s+.*3 filed/, "an array line contributes its length");
});

test("the names default to the round's brief stems", async () => {
  const { work, subagents } = layout({ names: ["f-ab", "f-cd"] });
  spawn({ subagents, name: "f-ab", entries: report() });
  spawn({ subagents, name: "f-cd", entries: report(), hash: "fedcba9876543210" });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# wait round 1 · 2 agents · call 1/);
});

test("a reviewer still working holds the call to the ceiling, then exit 1 says call again", async () => {
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: working() });
  const r = await run(["--work", work, "--round", "1", "--session", subagents], { config: { callSeconds: 200, settleSeconds: 60, staleSeconds: 660, budgetMinutes: 30 } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /f-ab\s+active/);
  assert.match(r.out, /1 still active, \d+m of budget left — call wait\.mjs again/);
  assert.ok(r.elapsed >= 200_000, `blocked for ${r.elapsed}ms`);
});

test("a short call ceiling still cannot return before the two-minute floor", async () => {
  // Otherwise a misconfigured ceiling turns the wait back into a poll, which is
  // the turn-per-check cost the whole script exists to remove.
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: working() });
  const r = await run(["--work", work, "--round", "1", "--session", subagents], { config: { callSeconds: 5, settleSeconds: 60, staleSeconds: 660, budgetMinutes: 30 } });
  assert.equal(r.code, 1);
  assert.ok(r.elapsed >= 120_000, `returned after ${r.elapsed}ms`);
});

test("a reviewer silent past the stale limit is dead, and the round settles without it", async () => {
  const { work, subagents } = layout({ names: ["f-ab", "f-cd"], scopeAgeSeconds: 25 * 60 });
  spawn({ subagents, name: "f-ab", entries: report() });
  spawn({ subagents, name: "f-cd", entries: working(Date.now() - 20 * 60_000), hash: "fedcba9876543210", ageSeconds: 20 * 60 });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /f-cd\s+dead/);
  assert.match(r.out, /# settled — 1 finished, 0 stalled, 1 dead/);
  // SKILL.md §2f promises the tool prints the next action with the name already
  // substituted, and sends the lead to references/recovery.md for everything else.
  // A dead row whose remedy the lead has to assemble by hand breaks that promise.
  // The path is a mktemp dir, so it can carry regex metacharacters; escape it
  // rather than rely on today's temp-name alphabet.
  const rx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(r.out, new RegExp(`salvage\\.mjs" ${rx(subagents)} f-cd$`, "m"));
  assert.doesNotMatch(r.out, /salvage\.mjs.* f-ab/, "a finished reviewer is collected, not salvaged");
});

test("the round's wait budget is spent: exit 3, and the active ones are to be treated as dead", async () => {
  const { work, roundDir, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: working() });
  writeFileSync(path.join(roundDir, "wait.json"), JSON.stringify({
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), names: ["f-ab"], calls: 3,
  }));
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /budget spent after 30m — treat the 1 still active as dead/);
  assert.match(r.out, /call 4/, "the call count carries across calls");
});

test("calling again after the budget is spent is refused, not answered cheaply", async () => {
  // Exit 3 returns in milliseconds — there is nothing left to wait for — so
  // without this the terminal case is the cheapest call in the script, and a
  // lead that keeps calling has rebuilt the poll loop on a path poll-guard
  // cannot see (it gates ListAgents and TaskOutput, not Bash).
  const { work, roundDir, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: working() });
  writeFileSync(path.join(roundDir, "wait.json"), JSON.stringify({
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), names: ["f-ab"], calls: 1,
  }));
  assert.equal((await run(["--work", work, "--round", "1", "--session", subagents])).code, 3);
  assert.equal(JSON.parse(readFileSync(path.join(roundDir, "wait.json"), "utf8")).spent, true);
  await assert.rejects(
    () => run(["--work", work, "--round", "1", "--session", subagents]),
    (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /already spent/);
      assert.match(error.message, /§2f/);
      return true;
    });
  assert.equal(JSON.parse(readFileSync(path.join(roundDir, "wait.json"), "utf8")).calls, 3,
    "a refused call is still a call, and the record must show it");
});

test("a different set of names starts its own wait and its own budget", async () => {
  // The verifier's wait follows the finders' in the same round directory; it
  // must not inherit the budget the finders already spent.
  const { work, roundDir, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "self-review-verifier-r1", entries: report() });
  writeFileSync(path.join(roundDir, "wait.json"), JSON.stringify({
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), names: ["f-ab"], calls: 3,
  }));
  const r = await run(["--work", work, "--round", "1", "--session", subagents, "self-review-verifier-r1"]);
  assert.equal(r.code, 0, r.out);
  const state = JSON.parse(readFileSync(path.join(roundDir, "wait.json"), "utf8"));
  assert.deepEqual(state.names, ["self-review-verifier-r1"]);
  assert.equal(state.calls, 1);
});

test("a name with no transcript is active, and dead once this wait has waited out the stale limit", async () => {
  const { work, subagents } = layout({ names: ["f-ab"] });
  const first = await run(["--work", work, "--round", "1", "--session", subagents], { config: { callSeconds: 130, settleSeconds: 60, staleSeconds: 660, budgetMinutes: 30 } });
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /f-ab\s+active\s+.*\(no transcript\)/);
  // A later call, twelve minutes after this wait began, with the agent still
  // never having written a line.
  const later = await run(["--work", work, "--round", "1", "--session", subagents], { start: Date.now() + 12 * 60_000 });
  assert.equal(later.code, 0, later.out);
  assert.match(later.out, /f-ab\s+dead\s+.*\(no transcript\)/);
});

test("a previous attempt's transcript under the same name is not this round's agent", async () => {
  const { work, subagents, roundDir } = layout({ names: ["f-ab"] });
  const stale = spawn({ subagents, name: "f-ab", entries: report(Date.now() - 3600_000), hash: "1111111111111111", ageSeconds: 3600 });
  spawn({ subagents, name: "f-ab", entries: working(), hash: "2222222222222222" });
  assert.ok(readFileSync(stale, "utf8").includes("end_turn"));
  // scope.diff was written when this round began, so the hour-old transcript
  // predates it and must not settle the wait.
  const r = await run(["--work", work, "--round", "1", "--session", subagents], { config: { callSeconds: 130, settleSeconds: 60, staleSeconds: 660, budgetMinutes: 30 } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /f-ab\s+active/);
  assert.ok(path.join(roundDir, "scope.diff"));
});

test("no transcript directory fails loudly and names the fallback", async () => {
  const { work } = layout();
  await assert.rejects(
    () => run(["--work", work, "--round", "1", "--session", "/nope/subagents"]),
    (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /no subagent transcripts/);
      assert.match(error.message, /ending the turn/);
      return true;
    });
});

test("usage errors are refused rather than guessed at", async () => {
  const { work, subagents } = layout();
  const refuses = async (argv, pattern) => {
    await assert.rejects(() => run(argv), (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, pattern);
      return true;
    });
  };
  await refuses(["--round", "1"], /--work is required/);
  await refuses(["--work", work, "--round", "0"], /positive integer/);
  await refuses(["--work", work, "--round", "1", "--wat", "x"], /unknown argument --wat/);
  await refuses(["--work", work, "--round", "9", "--session", subagents], /no names given and no briefs/);
  await refuses(["--work", "/tmp/no-session-id-here", "--round", "1", "f-ab"], /pass --session/);
});

test("the session id comes from the scratchpad path, so the normal call needs no --session", () => {
  assert.equal(sessionIdFrom(`/tmp/x/${SESSION}/scratchpad/self-review`), SESSION);
  assert.equal(sessionIdFrom(`/tmp/x/${SESSION}/scratchpad`), SESSION);
  assert.equal(sessionIdFrom("/tmp/x/not-a-uuid/scratchpad/self-review"), null);
  assert.equal(sessionIdFrom("/tmp/work"), null);
});

test("a transcript is re-parsed only when it has grown", () => {
  const { subagents } = layout();
  const file = spawn({ subagents, name: "f-ab", entries: working() });
  const read = makeReader();
  const first = read(file);
  assert.equal(read(file), first, "unchanged: the same object, not a re-parse");
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify(said([text("done")], "end_turn")) + "\n");
  const when = Date.now() / 1000 + 1;
  utimesSync(file, when, when);
  const second = read(file);
  assert.notEqual(second, first);
  assert.equal(second.endsWithReport, true);
});

test("the table survives having no rows to pad against", () => {
  const rows = [{ name: "f-ab", status: "dead", lastAt: "—", calls: 0, stateLines: 0, note: "no transcript" }];
  // Anchored at the head only: the dead row's own salvage advice follows the
  // verdict, and this test is about the padding, not about what comes after.
  assert.match(render(rows, "# verdict"), /^f-ab {2}dead {6}last —.* {3}0 calls {2}0 filed {2}\(no transcript\)\n# verdict\n/);
});

test("a SIGTERM prints the table rather than losing it", async () => {
  // The Bash tool's own timeout kills the script when a call outruns it; a wait
  // that dies silently there tells the lead nothing, which is the failure this
  // whole script replaces. The in-process tests above cannot reach this path.
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: working() });
  const child = execFile(process.execPath,
    [fileURLToPath(new URL("wait.mjs", import.meta.url)), "--work", work, "--round", "1", "--session", subagents]);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.match(out, /# wait round 1 · 1 agent · call 1/, "the header is printed before it blocks");
  child.kill("SIGTERM");
  assert.equal(await done, 1);
  assert.match(out, /f-ab\s+active/);
  assert.match(out, /# interrupted — 0 finished, 0 stalled, 0 dead, 1 active/);
});

test("a reviewer stalled on a transient API error settles the round at once and is told to resume", async () => {
  // The owner hit this by hand: a reviewer stopped on an API error and sat
  // there until they nudged it. Before this, it read `active` for the whole
  // 30-minute budget and was then reported dead — losing intact work.
  const { work, subagents } = layout({ names: ["f-ab", "f-cd"] });
  spawn({ subagents, name: "f-ab", entries: report() });
  spawn({ subagents, name: "f-cd", entries: stalledOn("API Error: Connection lost mid-response. The response above may be incomplete."), hash: "fedcba9876543210" });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.elapsed, 0, "a stalled agent will never write again, so waiting on it is dead time");
  assert.match(r.out, /f-cd\s+stalled/);
  assert.match(r.out, /# settled — 1 finished, 1 stalled, 0 dead/);
  assert.match(r.out, /Connection lost mid-response/, "the error text decides the remedy, so it is quoted");
  assert.match(r.out, /resume it: SendMessage to "f-cd"/);
  assert.doesNotMatch(r.out, /f-cd.*→ a quota refusal/s);
});

test("a reviewer stalled on a quota refusal is told to wait for the reset, not to nudge", async () => {
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: stalledOn("You've hit your session limit · resets 6:20pm (Africa/Algiers)", { status: "rejected" }) });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /f-ab\s+stalled/);
  assert.match(r.out, /resets 6:20pm/);
  assert.match(r.out, /a quota refusal: a nudge now only spends another one/);
  assert.doesNotMatch(r.out, /SendMessage/, "nudging a refused quota just spends another refusal");
});

test("no stalled reviewer means no stall advice at all", async () => {
  // The mirror assertion: advice that prints unconditionally is noise, and an
  // empty advice block reads the same whether the rule holds or the status was
  // never computed. The two tests above prove it engages.
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: report() });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.doesNotMatch(r.out, /stalled reviewer is NOT a dead one/);
});

test("an unmeasured stall shape tells the lead to read the error, not which way to act", async () => {
  const { work, subagents } = layout({ names: ["f-ab"] });
  spawn({ subagents, name: "f-ab", entries: stalledOn("Request throttled by the upstream gateway", { status: "throttled" }) });
  const r = await run(["--work", work, "--round", "1", "--session", subagents]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /f-ab\s+stalled/);
  assert.match(r.out, /shape this plugin has not measured: READ the error above/);
  assert.doesNotMatch(r.out, /resume it: SendMessage/, "the safe default is not a guess in either direction");
});

test("a state file belonging to no waited-on reviewer is named, not silently ignored", () => {
  const rows = [{ name: "f-ab", status: "finished", lastAt: "—", calls: 1, stateLines: 1, note: "" }];
  const listed = ["f-ab.jsonl", "f-cd-respawned.jsonl", "notes.txt"];
  const advice = orphanAdvice(rows, "/w/round-1/state", listed);
  assert.match(advice.join("\n"), /1 state file in this round belongs to no reviewer above — an earlier attempt/);
  assert.match(advice.join("\n"), /Its candidates are still on disk/);
  assert.match(advice.join("\n"), /f-cd-respawned\.jsonl/);
  assert.doesNotMatch(advice.join("\n"), /notes\.txt/, "only .jsonl state files are candidates");
  assert.doesNotMatch(advice.join("\n"), /f-ab\.jsonl/, "a file matching a waited-on name is not an orphan");
});

test("the orphan advice agrees with the count in both branches, not just on the noun", () => {
  const rows = [{ name: "f-ab", status: "finished", lastAt: "—", calls: 1, stateLines: 1, note: "" }];
  const advice = orphanAdvice(rows, "/w/round-1/state", ["f-cd.jsonl", "f-ef.jsonl"]).join("\n");
  // Conjugating only `file` left "3 state files … an earlier attempt … Its
  // candidates" — the same disagreement, moved to the other branch.
  assert.match(advice, /2 state files in this round belong to no reviewer above — earlier attempts/);
  assert.match(advice, /Their candidates are still on disk/);
  assert.doesNotMatch(advice, /belongs/);
  assert.doesNotMatch(advice, /\bIts\b/);
});

test("a round where every state file is accounted for adds nothing to the table", () => {
  const rows = [{ name: "f-ab", status: "finished", lastAt: "—", calls: 1, stateLines: 1, note: "" }];
  assert.deepEqual(orphanAdvice(rows, "/w/round-1/state", ["f-ab.jsonl"]), []);
  assert.deepEqual(orphanAdvice(rows, "/w/round-1/state", []), [],
    "a round nobody has filed in yet — the state dir may not even exist");
});

test("the dead advice is one runnable salvage call naming every dead reviewer and no live one", () => {
  assert.deepEqual(deadAdvice([{ name: "f-ab", status: "finished" }]), []);
  const lines = deadAdvice([
    { name: "f-ab", status: "finished" },
    { name: "f-cd", status: "dead" },
    { name: "f-ef", status: "dead" },
  ], "sess-1");
  // The invocation salvage.mjs actually parses is positional — `<session-id>
  // [name…]`, no flags — so this pins the shape, not merely the names. A
  // printed command that does not run is worse than no command.
  const call = lines.find((l) => l.includes("salvage.mjs"));
  assert.equal(call, '#   → "${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" sess-1 f-cd f-ef');
  assert.ok(!lines.some((l) => l.includes("f-ab")), lines.join("\n"));
});
