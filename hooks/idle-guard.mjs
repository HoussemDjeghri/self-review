#!/usr/bin/env node
/**
 * Idle guard (SubagentStop hook).
 *
 * A subagent that ends its turn while a command it backgrounded is still
 * running is never woken when that command finishes. Measured on Claude Code
 * 2.1.310, 2026-10-24: a teammate backgrounded a headless `claude -p` review
 * and ended its turn to wait; the review finished 21 minutes later, its
 * completion notice was written into the teammate's transcript as a queued
 * attachment and never drained, and the teammate sat idle for eleven hours
 * until the lead messaged it. It had "wait inside a call, never across turns"
 * in its context the whole time, which is why this is a hook and not a
 * sentence. A probe the same day reproduced it with `sleep 45`: SubagentStop
 * fired at each of the teammate's turn ends with the running shell listed in
 * `background_tasks`, and nothing at all fired when the shell finished. Two
 * more probes that day: a teammate that started a Monitor and ended its turn
 * was never woken by the Monitor's event (a Monitor is listed as a `shell`),
 * and in an agent team a named teammate fires SubagentStop at its turn end —
 * TeammateIdle only after it — and honours this hook's block.
 *
 * RULE: block the stop once when `background_tasks` lists a shell or monitor,
 * running or pending, that THIS agent launched — its id appears in a tool
 * result in the agent's own transcript. The registry carries no owner field
 * and may list the lead's tasks or another teammate's, so liveness comes from
 * the payload and ownership from the transcript. Ownership is a mention, not
 * a launch: a tool result that merely quotes another agent's live task id (a
 * cat of a handoff note) counts too, and costs one extra turn — the same bound
 * as below. Matching the launch texts instead was rejected: they differ for
 * run_in_background, a user's manual backgrounding, the timeout's
 * auto-backgrounding and Monitor.
 *
 * The block reason is the in-call wait, and what it waits on is the line the
 * harness appends to a shell task's output file once the job has ended:
 * `[exited with code N]`, or `[killed]`. Measured on 2.1.310 (macOS) over every
 * task output on the machine, for jobs launched by the lead, a subagent, a
 * teammate and a Monitor; it starts its own line even when the job's output
 * has no trailing newline. It is undocumented, so if it ever changes the loop
 * fails slow (still-running every call) and the reason says how to notice.
 * The path comes from the launch result the ownership check already reads. A
 * pgrep pattern guessed from the job's command was tried first and took a
 * finding every review round: Linux pgrep matches the loop's own shell and
 * the harness wrapper, and a command has no guaranteed distinctive run.
 * A Monitor's launch result names no file, so a Monitor is named and left to
 * its own expiry rather than its output directory being inferred.
 *
 * Each job is blocked on once. The harness records a block in the agent's own
 * transcript as an `attachment` of type `hook_blocking_error` with `hookEvent`
 * SubagentStop and the reason as `blockingError.blockingError` (measured on
 * 2.1.310, probe 4), so a job an earlier block named is let through, and a job
 * launched after that block is blocked on its own. A job meant to outlive the
 * agent (a server, a watcher) therefore costs one extra turn; guessing such jobs
 * from the command was rejected — the one block is the exemption. Keying on
 * `stop_hook_active` alone was the first version, and it left every job launched
 * later in the same continuation unguarded, since the flag stays true for all of
 * it. It still bounds the hook: a stop that follows a block, in a transcript
 * holding no readable record of any block, is let through, so a harness that
 * stopped writing the record, or changed it, would cost the per-job guard and
 * never loop.
 *
 * The main session needs none of this: it is woken by the same notification.
 *
 * Fails open (silent exit 0) on anything unexpected; IDLE_GUARD=off disables.
 */
import { runHook } from "./lib/hook.mjs";
import { readTail, textOf } from "./lib/transcript.mjs";

const GUARD_TAG = "[idle-guard]";
const WAITABLE = new Set(["shell", "monitor"]);
const LIVE = new Set(["running", "pending"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether this transcript records any block by this hook, and which of `ids`
 *  those blocks named. Only the harness's record counts: a tool result quoting
 *  a reason is text the agent read, not a block it received. */
function namedBefore(transcriptText, ids) {
  const named = new Set();
  let any = false;
  for (const line of transcriptText.split("\n")) {
    if (!line.includes(GUARD_TAG)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry?.type === "attachment" ? entry.attachment : null;
    const reason = record?.type === "hook_blocking_error" && record.hookEvent === "SubagentStop" ? record.blockingError?.blockingError : null;
    const list = typeof reason === "string" ? reason.match(/^\[idle-guard\] Not yet \(([^)\n]*)\):/)?.[1] : undefined;
    if (list === undefined) continue;
    any = true;
    for (const id of list.split(", ")) if (ids.includes(id)) named.add(id);
  }
  return { any, named };
}

/** The output file `text` names for `id`: an absolute path ending in
 *  /tasks/<id>.output, at the start of the text or after whitespace or a colon,
 *  holding no whitespace or quote. Found outward from the literal ending, not
 *  by one regex: that backtracked quadratically over a long run of `:/`. */
function outputPath(text, id) {
  const tail = `/tasks/${id}.output`;
  for (let at = text.indexOf(tail); at !== -1; at = text.indexOf(tail, at + 1)) {
    const end = at + tail.length;
    if (/^(?:[\w-]|\.\w)/.test(text.slice(end, end + 2))) continue;
    let start = at;
    while (start > 0 && !/[\s'"`]/.test(text[start - 1])) start--;
    for (let i = start; i <= at; i++) {
      const after = i === start ? start === 0 || /\s/.test(text[start - 1]) : text[i - 1] === ":";
      if (text[i] === "/" && after) return text.slice(i, end);
    }
  }
  return null;
}

/** Ids, among `ids`, that appear in a tool result of this transcript, each
 *  mapped to the output file the first tool result naming one gives (null when none
 *  does). A path holding a quote is not used: it is single-quoted in the loop. */
function launchedHere(transcriptText, ids) {
  const found = new Map();
  const mention = new Map(ids.map((id) => [id, new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`)]));
  for (const line of transcriptText.split("\n")) {
    const candidates = ids.filter((id) => !found.get(id) && line.includes(id));
    if (candidates.length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      const text = textOf(block.content);
      for (const id of candidates) {
        if (!mention.get(id).test(text)) continue;
        found.set(id, found.get(id) ?? outputPath(text, id));
      }
    }
  }
  return found;
}

function describe(task) {
  const raw = task.type === "shell" && typeof task.command === "string" ? task.command : task.description;
  // One line, so the reason's first line stays one sentence.
  const what = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : raw;
  const short = typeof what === "string" && what.length > 160 ? `${what.slice(0, 157)}…` : what;
  return `${task.id} (${task.type}${short ? `: ${short}` : ""})`;
}

const ended = (path) => `tail -n 1 '${path}' 2>/dev/null | grep -qxE '\\[(exited with code -?[0-9]+|killed)\\]'`;

/** The bounded in-call wait: done when every watched output file ends with
 *  the harness's exit line. A missing or unreadable file reads as not done. */
function waitLoop(paths) {
  const all = paths.map(ended).join(" && ");
  return `  _idle_done() { ${all}; }; end=$((SECONDS+570)); while [ $SECONDS -lt $end ] && ! _idle_done; do sleep 15; done; _idle_done && echo finished || echo still-running`;
}

function evaluate(payload, readTranscript) {
  const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
  const live = tasks.filter((t) => t && typeof t.id === "string" && t.id && WAITABLE.has(t.type) && LIVE.has(t.status));
  if (live.length === 0) return null;
  const transcriptPath = payload.agent_transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  const transcriptText = readTranscript(transcriptPath);
  const owned = launchedHere(transcriptText, live.map((t) => t.id));
  const launched = live.filter((t) => owned.has(t.id));
  if (launched.length === 0) return null;
  const { any, named } = namedBefore(transcriptText, launched.map((t) => t.id));
  if (payload.stop_hook_active === true && !any) return null;
  const mine = launched.filter((t) => !named.has(t.id));
  if (mine.length === 0) return null;
  const paths = [...new Set(mine.map((t) => owned.get(t.id)).filter(Boolean))];
  const pathless = mine.filter((t) => !owned.get(t.id)).map((t) => t.id);
  const unwatched = pathless.length
    ? ` Not in the loop: ${pathless.join(", ")} — no output file is named where it was launched (a Monitor's never is). A Monitor ends at its own expiry: wait for that inside a foreground call of at most 570 seconds, or stop it if you no longer need it. A Bash job's output file is …/tasks/<id>.output, and its last line is [exited with code N] or [killed] once the job has ended.`
    : "";
  const wait = paths.length
    ? [
      `Do now: wait inside a call. Run this as a foreground Bash with timeout 600000 — it returns within ten minutes either way — and repeat it until it prints finished. It watches each job's output file for the line the harness appends when the job ends.${unwatched} If it prints still-running a second time and you expect the job to be done, run \`tail -n 3\` on the output file: output that is complete but has no [exited …] or [killed] line means that marker has changed, so read the output and go on:`,
      waitLoop(paths),
    ]
    : [`Do now: wait inside a call.${unwatched}`];
  return {
    decision: "block",
    reason: [
      `${GUARD_TAG} Not yet (${mine.map((t) => t.id).join(", ")}): background work you started is still running — ${mine.map(describe).join("; ")}.`,
      `A subagent that ends its turn is not woken when that work finishes: the completion notice is queued and never delivered, so you would sit idle until someone messages you. A Monitor reports through the same channel, so it does not help.`,
      ...wait,
      `Then read the job's output and finish your task. If the work is meant to outlive you (a server, a watcher), say so in one line and end your turn — you will not be stopped again for this job.`,
    ].join("\n"),
    systemMessage: `idle-guard: kept a subagent from going idle with ${mine.length} background job(s) still running`,
  };
}

runHook("IDLE_GUARD", "idle-guard", (payload) => evaluate(payload, readTail));
