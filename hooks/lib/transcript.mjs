/**
 * Transcript helpers shared by the hooks that read the session JSONL
 * (self-review-gate, poll-guard). One place knows the entry shapes: what a
 * human prompt looks like versus hook feedback, compaction summaries, tool
 * results, interrupts, local slash commands, and the harness's wake-ups —
 * <task-notification> for background tasks (delivered as a user message, or
 * as an attachment when it lands mid-turn) and <teammate-message> for named
 * subagents, which report and go idle through the mailbox instead.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 64 * 1024 * 1024; // a single turn larger than this is implausible

/** Main-chain entries (subagent sidechains dropped) from the tail of a transcript. */
export function readMainChain(transcriptPath) {
  const fd = openSync(transcriptPath, "r");
  let text;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
  } finally {
    closeSync(fd);
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !entry.isSidechain) entries.push(entry);
    } catch {
      // foreign or truncated line — not ours to judge
    }
  }
  return entries;
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : "")).join("\n");
}

/** Text the harness delivered in the user role, whichever carrier it used: a
 *  user message, or a command queued mid-turn and attached to the next one —
 *  the usual carrier for a notification that lands while the model is working
 *  (271 attachment-carried vs 160 user-carried on this machine, 2026-08-22). */
export function deliveredText(entry) {
  if (entry.type === "attachment") return entry.attachment?.prompt ?? "";
  return entry.type === "user" ? textOf(entry.message?.content) : "";
}

export const hasToolResult = (entry) =>
  Array.isArray(entry.message?.content) && entry.message.content.some((b) => b?.type === "tool_result");

export const isInterrupt = (entry) =>
  entry.type === "user" && textOf(entry.message?.content).startsWith("[Request interrupted by user");

/** The harness's wake-up for a background task (agent, Monitor, shell). */
export const isTaskNotification = (entry) => deliveredText(entry).trimStart().startsWith("<task-notification>");

/** A task notification that reports a task ending — it carries a <status>.
 *  Monitor events are task notifications too, but carry only an <event>. */
export const isTaskCompletion = (entry) => isTaskNotification(entry) && deliveredText(entry).includes("<status>");

/** A message relayed from another agent or session. Named subagents have no
 *  task notification: their report and their "idle" signal both arrive this way. */
const AGENT_MESSAGE_RE = /^(?:Another Claude session sent a message:|<teammate-message\b)/;
export const isAgentMessage = (entry) => AGENT_MESSAGE_RE.test(deliveredText(entry).trimStart());

/** Names of the subagents an agent message reports idle — several can share
 *  one entry when they finish close together. The idle JSON must open a
 *  message body: a report that merely quotes the phrase is not an idle signal. */
const IDLE_RE = /<teammate-message\b[^>]*\bteammate_id="([^"]+)"[^>]*>\s*\{\s*"type"\s*:\s*"idle_notification"/g;
export const idleAgentNames = (entry) =>
  isAgentMessage(entry) ? [...deliveredText(entry).matchAll(IDLE_RE)].map((m) => m[1]) : [];

/** User-role entries the harness writes on its own: local slash commands and
 *  their output, stop notices. Not the human typing, so never a turn boundary. */
const HARNESS_WRITTEN_RE = /^(?:<command-name>|<command-message>|<local-command-stdout>|<local-command-caveat>|\d+ background agents? (?:was|were) stopped by the user)/;

/** A real prompt typed by the human: not hook feedback (isMeta), not a compaction
 *  summary, not a tool result, not an interrupt notice, not a notification or a
 *  message from another agent, not a local command the harness recorded. */
export const isHumanPrompt = (entry) =>
  entry.type === "user" && !entry.isMeta && !entry.isCompactSummary && !("toolUseResult" in entry) &&
  !hasToolResult(entry) && !isInterrupt(entry) && !isTaskNotification(entry) && !isAgentMessage(entry) &&
  !HARNESS_WRITTEN_RE.test(textOf(entry.message?.content).trimStart());

export function toolUses(entry) {
  if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return [];
  return entry.message.content.filter((b) => b?.type === "tool_use");
}

export function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `NAME=off` (or 0/false/no) switches a hook off for the session. */
export const isDisabled = (envName) => /^(0|off|false|no)$/i.test(process.env[envName] ?? "");
