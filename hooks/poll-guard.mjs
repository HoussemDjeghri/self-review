#!/usr/bin/env node
/**
 * Poll guard (PreToolUse hook, matcher: ListAgents|TaskOutput).
 *
 * A background agent reports back through a notification that wakes the
 * model even after it has ended its turn — a <task-notification> for an
 * unnamed agent, a <teammate-message> for a named one — so checking on one is
 * never informative, only expensive: every check is a new turn that re-reads
 * the whole context. Measured 2026-08-21: one session made ~85 ListAgents
 * calls at ~430k context waiting for a single finder (≈36M tokens, the whole
 * 5-hour budget) while saying "I'll stop polling" between calls. The model
 * under pressure to "keep working" will poll; the harness should refuse.
 *
 * RULE: since the last moment anything new arrived — a human prompt, a task
 * completion (Monitor events are not completions: a chatty monitor must not
 * refill the allowance), or a message from another agent — allow
 * POLL_GUARD_MAX status checks (default 2), enough to look up an agent's name
 * for SendMessage, and deny the rest with a reason that says what to do
 * instead: end the turn. A TaskOutput with block=true (the schema's default)
 * is a real single-call wait and is never counted; block=false is a poll.
 *
 * Fails open (silent exit 0) on anything unexpected; POLL_GUARD=off disables.
 */
import { runHook } from "./lib/hook.mjs";
import { hasToolResult, intEnv, isAgentMessage, isHumanPrompt, isTaskCompletion, readMainChain, toolUses } from "./lib/transcript.mjs";
import { loadConfig } from "./lib/config.mjs";

const MAX_CHECKS = intEnv("POLL_GUARD_MAX", loadConfig().pollGuard.maxChecks);
const GUARD_TAG = "[poll-guard]";

const isStatusCheck = (use) =>
  use.name === "ListAgents" || (use.name === "TaskOutput" && use.input?.block === false);

const isNews = (entry) => isHumanPrompt(entry) || isTaskCompletion(entry) || isAgentMessage(entry);

/** Completed status checks since the last new information. */
function countChecks(entries) {
  const since = entries.map(isNews).lastIndexOf(true);
  const turn = entries.slice(since + 1);
  const answered = new Set();
  for (const entry of turn) {
    if (entry.type !== "user" || !hasToolResult(entry)) continue;
    for (const block of entry.message.content) if (block?.type === "tool_result") answered.add(block.tool_use_id);
  }
  let checks = 0;
  for (const entry of turn) for (const use of toolUses(entry)) if (isStatusCheck(use) && answered.has(use.id)) checks++;
  return checks;
}

function evaluate(entries, toolName, toolInput) {
  if (!isStatusCheck({ name: toolName, input: toolInput })) return null;
  const checks = countChecks(entries);
  if (checks < MAX_CHECKS) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: [
        `${GUARD_TAG} Denied: this would be status check #${checks + 1} since anything new arrived, and it cannot tell you anything a check did not already say.`,
        `Background agents and tasks wake you when they finish — a task notification, or an idle notification for a named agent (its report is read with the self-review skill's salvage.mjs) — even after your turn has ended. Polling costs a full-context turn per call and was how one session spent its entire 5-hour budget.`,
        `Do now: end your turn with a one-line status (e.g. "3 reviewers running — continuing when they report"). Do not call ListAgents, TaskOutput(block=false), Monitor, or sleep to wait. If you need an agent's id for SendMessage, it is in the Agent tool's launch result. If a task must finish inside this turn, TaskOutput(block=true, timeout≤600000) is the one legitimate single-call wait.`,
      ].join("\n"),
    },
    systemMessage: `poll-guard: denied a repeated status check (#${checks + 1}) — waiting by ending the turn instead`,
  };
}

runHook("POLL_GUARD", "poll-guard", (payload) => {
  if (typeof payload.transcript_path !== "string" || typeof payload.tool_name !== "string") return null;
  return evaluate(readMainChain(payload.transcript_path), payload.tool_name, payload.tool_input ?? {});
});
