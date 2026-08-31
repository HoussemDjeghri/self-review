#!/usr/bin/env node
// self-review salvage — recover a subagent's work from its transcript.
//
// A reviewer that dies (usage-limit reset, closed session) or goes idle
// without delivering its report leaves its full transcript on disk at
// <project>/<session-id>/subagents/agent-*.jsonl. The tokens it burned are
// already paid for, and a finished agent's report is sitting in its last
// message — so the lead salvages before re-spawning anything. Read-only.
//
// Usage: salvage.mjs <session-id | session-dir | session-jsonl | subagents-dir> [name…] [--all-text]
//   no name     list every agent: finished/partial, model calls, context size, last activity
//   name…       print each named agent's last message (its report, when finished)
//   --all-text  print every text block instead (a partial agent's interim notes)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function fail(msg) {
  process.stderr.write(`salvage: ${msg}\n`);
  process.exit(2);
}

function resolveSubagentsDir(place) {
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

function readAgent(file) {
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
  return {
    stem: path.basename(file, ".jsonl").replace(/^agent-/, ""),
    finished: last?.type === "assistant" && last.message?.stop_reason === "end_turn" &&
      Array.isArray(last.message?.content) && last.message.content.some((b) => b?.type === "text"),
    calls: model.length,
    ctx: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    texts: model.flatMap((e) => e.message.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text)),
    lastAt: (last?.timestamp ?? "").slice(0, 19).replace("T", " "),
  };
}

function main() {
  const args = process.argv.slice(2);
  const allText = args.includes("--all-text");
  const positional = args.filter((a) => a !== "--all-text");
  if (positional.length === 0) fail("usage: salvage.mjs <session-id | session-dir | session-jsonl | subagents-dir> [name…] [--all-text]");
  const [place, ...names] = positional;
  const dir = resolveSubagentsDir(place);
  const files = existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl")).sort()
    : [];
  if (files.length === 0) fail(`no subagent transcripts under ${dir}`);
  const agents = files.map((f) => readAgent(path.join(dir, f)));

  if (names.length === 0) {
    for (const a of agents)
      process.stdout.write(`${a.stem.padEnd(30)} ${(a.finished ? "finished" : "partial").padEnd(9)} ${a.calls} calls  ctx ${Math.round(a.ctx / 1000)}k  last ${a.lastAt}\n`);
    process.stdout.write(`\nsalvage.mjs ${place} <name> prints that agent's last message (its report, when finished); --all-text prints every text block.\n`);
    return;
  }
  let missing = 0;
  for (const name of names) {
    const hits = agents.filter((a) => a.stem.includes(name));
    if (hits.length === 0) {
      process.stderr.write(`salvage: no transcript matches "${name}"\n`);
      missing++;
      continue;
    }
    for (const a of hits) {
      process.stdout.write(`=== ${a.stem} — ${a.finished ? "finished" : "partial"} · ${a.calls} calls · last ${a.lastAt}\n`);
      process.stdout.write(((allText ? a.texts.join("\n\n") : a.texts.at(-1)) || "(no text yet)") + "\n");
    }
  }
  process.exit(missing ? 1 : 0);
}

main();
