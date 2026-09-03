// Reading a subagent's transcript, and deciding whether it is still working.
//
// Two scripts need this and they used to disagree. `salvage.mjs` recovers a
// dead reviewer's work; `wait.mjs` blocks until a round's reviewers are done.
// Both answer the same question — is this agent finished, dead, or still
// going — from the same file, so the answer lives here once.
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

// finished | dead | active. `now` and the thresholds are injected so this is
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
