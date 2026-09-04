// Reading a subagent's transcript, and deciding whether it is still working.
//
// Two scripts need this and they used to disagree. `salvage.mjs` recovers a
// dead reviewer's work; `wait.mjs` blocks until a round's reviewers are done.
// Both answer the same question — is this agent finished, stalled, dead or
// still going — from the same file, so the answer lives here once.
//
// The harness appends a subagent's transcript live to
// <project>/<session-id>/subagents/agent-a<name>-<hash>.jsonl, one entry per
// model message. That file is the only signal this plugin owns. The wake-ups
// the harness sends are not: on 2026-09-03 three reviewers reported with
// SendMessage `success:true` and nothing was delivered to the lead for 2h49m,
// while their transcripts said finished within ten minutes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Where a session's subagent transcripts live, from whatever the caller has:
// a bare session id, the session's .jsonl, its directory, or the subagents
// directory itself.
export function resolveSubagentsDir(place) {
  if (existsSync(place) && statSync(place).isDirectory()) {
    if (path.basename(place) === "subagents") return place;
    const nested = path.join(place, "subagents");
    return existsSync(nested) ? nested : place; // else: a dir holding agent-*.jsonl directly
  }
  if (place.endsWith(".jsonl")) return path.join(place.slice(0, -".jsonl".length), "subagents");
  // A bare session id: find it under the projects root, newest first when a
  // session somehow exists in several projects. `~` in CLAUDE_CONFIG_DIR is
  // expanded, as the sibling hooks do (context-mode-cache-heal.mjs, #577).
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const root = cfg
    ? cfg.startsWith("~") ? path.join(homedir(), cfg.replace(/^~[/\\]?/, "")) : cfg
    : path.join(homedir(), ".claude");
  const projects = path.join(root, "projects");
  const hits = (existsSync(projects) ? readdirSync(projects) : [])
    .map((p) => path.join(projects, p, place, "subagents"))
    .filter(existsSync)
    .map((p) => [p, statSync(p).mtimeMs]) // stat once per candidate, not per comparison
    .sort((a, b) => b[1] - a[1]);
  return hits[0]?.[0] ?? place;
}

// The harness writes a terminal notice as an assistant entry flagged
// `isApiErrorMessage`, with a `<synthetic>` model and zeroed usage. It is
// terminal: measured over 894 subagent transcripts on 2026-09-04, 93 carried
// one and in every single case it was the LAST entry — no transcript ever
// continued past it. So an agent that has one is neither active (it will never
// write again) nor dead in the sense §2f means (its work is intact and it can
// be resumed); it is stalled, and the caller has to be told which of the two
// kinds it is, because the remedy is opposite:
//
//   - `quota` (89 of the 93) carries `quotaLimits.status: "rejected"` and a
//     reset time in its text. Nudging it now just spends another refusal. Both
//     tests are needed and OR'd: two of the 89 said "session limit" in the text
//     with no `quotaLimits` block at all.
//   - `transient` (4 of the 93: "Connection lost mid-response", a 522) resumes
//     on a nudge, which is how this was found — the owner had to send one by
//     hand to a reviewer that had sat stalled.
//   - `unknown` is anything else, and it exists because the two above are a
//     closed list taken from one machine on one day. A shape this has not seen —
//     a reworded refusal, another `quotaLimits.status` — must not be guessed at
//     in the expensive direction: defaulting it to resumable would nudge a live
//     quota refusal and spend it. The caller is told to read the error instead.
const apiErrorOf = (last) => {
  if (last?.isApiErrorMessage !== true) return null;
  const text = (Array.isArray(last.message?.content) ? last.message.content : [])
    .filter((b) => b?.type === "text" && b.text).map((b) => b.text).join(" ").trim();
  const body = text || String(last.error ?? "an API error with no text");
  if (last.quotaLimits?.status === "rejected" || /hit your (session|usage|weekly) limit/i.test(body)) {
    return { text: body, kind: "quota" };
  }
  return { text: body, kind: /^API Error\b/i.test(body) ? "transient" : "unknown" };
};

export function readAgent(file) {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; } // a torn final line is expected in a killed transcript
  });
  // The harness records its own notices (e.g. the session-limit banner) as
  // assistant entries with zeroed usage; only entries that billed tokens are
  // the model's calls, and only their text is the agent's work.
  const spent = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.output_tokens ?? 0);
  const model = entries.filter((e) => e?.type === "assistant" && Array.isArray(e.message?.content) && spent(e.message.usage) > 0);
  const last = entries.at(-1);
  const usage = model.at(-1)?.message?.usage ?? {};
  const content = Array.isArray(last?.message?.content) ? last.message.content : [];
  return {
    stem: path.basename(file, ".jsonl").replace(/^agent-/, ""),
    file,
    // The report shape: the last entry is an ASSISTANT entry the model was
    // billed for, carrying text and no tool call. Every clause is load-bearing.
    // Drop the role check and a `user` entry of tool_result blocks reads as a
    // report, because it has no tool_use block either — which is how an agent
    // mid-tool was twice mistaken for a finished one. Drop the text check and a
    // bare thinking entry qualifies. Drop the billing check and the harness's
    // own session-limit banner — an assistant text entry with zeroed usage,
    // appended to an agent that was cut off mid-tool — reads as its report.
    endsWithReport: last?.type === "assistant" && spent(last.message?.usage) > 0 &&
      content.some((b) => b?.type === "text" && b.text?.trim()) &&
      !content.some((b) => b?.type === "tool_use"),
    stopReason: last?.message?.stop_reason ?? null,
    apiError: apiErrorOf(last),
    mtimeMs: statSync(file).mtimeMs,
    calls: model.length,
    ctx: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    texts: model.flatMap((e) => e.message.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text)),
    lastAt: (last?.timestamp ?? "").slice(0, 19).replace("T", " "),
    // When this agent's first message was written, so a caller can tell a
    // re-spawn from the attempt it replaced: both carry the same name.
    startedMs: Date.parse(entries[0]?.timestamp ?? "") || 0,
  };
}

// finished | stalled | dead | active. `now` and the thresholds are injected so
// testable without sleeping.
//
// `stop_reason` alone cannot decide it: across 119 transcripts sampled on
// 2026-09-03, 118 ended with an assistant text entry but only 16 carried
// `end_turn` and 91 carried null. A predicate that required `end_turn` — which
// salvage.mjs's did — called roughly three finished agents in four "partial".
// So the report shape decides, and quiet time is what makes it final: a text
// entry is sometimes followed by the tool_use entry of the same message, with
// a measured maximum gap of 31.9s.
export function agentStatus(agent, now, config = {}) {
  const settle = (config.settleSeconds ?? 60) * 1000;
  const stale = (config.staleSeconds ?? 660) * 1000;
  const quiet = now - agent.mtimeMs;
  if (agent.endsWithReport && (agent.stopReason === "end_turn" || quiet > settle)) return "finished";
  // Before the staleness clock, because a stalled agent would otherwise spend
  // the whole round budget reading as `active` and then be called dead — which
  // is the 2h49m idle shape this file exists to end, arriving by another door.
  // No settle window: the error is terminal in all 93 measured cases, so
  // waiting to confirm it would only add latency to a verdict that cannot change.
  if (agent.apiError) return "stalled";
  if (quiet > stale) return "dead";
  return "active";
}

// Every transcript for `name`, newest first, skipping any last written before
// `sinceMs`. A re-spawned reviewer reuses its name, so without that floor a
// wait would settle instantly on the previous attempt's finished transcript.
// The mtime is only a prefilter — an agent's own `startedMs` is the timestamp
// that decides, and the caller has it once it reads the file. An exact
// `<name>-<hash>` match outranks a longer stem that merely starts with the name,
// which is another agent the harness renamed off a collision.
export function findAgentFiles(dir, name, sinceMs = 0) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const prefix = `agent-a${name}-`;
  // `<name>-<hash>` is this agent's own transcript. `<name>-2-<hash>` belongs to
  // a DIFFERENT agent the harness renamed off a colliding name — but when the
  // harness renamed the agent we asked for, that is the only file there is. So
  // rank rather than exclude: an exact match wins if one exists, and the
  // renamed transcript still answers when it does not. No regex escaping: the
  // remainder is tested, not the name.
  const isExact = (file) => /^[0-9a-f]+$/.test(path.basename(file, ".jsonl").slice(prefix.length));
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .map((f) => [f, statSync(f).mtimeMs, isExact(f) ? 0 : 1])
    .filter(([, mtime]) => mtime >= sinceMs)
    .sort((a, b) => a[2] - b[2] || b[1] - a[1])
    .map(([f]) => f);
}
