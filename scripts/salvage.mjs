#!/usr/bin/env node
// self-review salvage — recover a subagent's work from its transcript.
//
// A reviewer that dies (usage-limit reset, closed session) or goes idle
// without delivering its report leaves its full transcript on disk at
// <project>/<session-id>/subagents/agent-*.jsonl. The tokens it burned are
// already paid for, and a finished agent's report is sitting in its last
// message — so the lead salvages before re-spawning anything. Read-only.
//
// The three-way verdict is `scripts/lib/agents.mjs`'s, shared with wait.mjs so
// the two cannot disagree about what "finished" means. This script used to
// decide it alone and require `stop_reason: "end_turn"`, which only 16 of 119
// transcripts sampled on 2026-09-03 carried: it called roughly three finished
// agents in four "partial", and a lead that believed it re-spawned work that
// was already done.
//
// Usage: salvage.mjs <session-id | session-dir | session-jsonl | subagents-dir> [name…] [--all-text]
//   no name     list every agent: finished/active/dead, model calls, context size, last activity
//   name…       print each named agent's last message (its report, when finished)
//   --all-text  print every text block instead (an unfinished agent's interim notes)
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { agentStatus, readAgent, resolveSubagentsDir } from "./lib/agents.mjs";
import { isMain, loadConfig } from "../hooks/lib/config.mjs";
import { gitRoot } from "./lib/repo.mjs";

function fail(msg) {
  process.stderr.write(`salvage: ${msg}\n`);
  process.exit(2);
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
  const config = loadConfig(gitRoot()).wait;
  const now = Date.now();
  const agents = files.map((f) => {
    const agent = readAgent(path.join(dir, f));
    return { ...agent, status: agentStatus(agent, now, config) };
  });

  if (names.length === 0) {
    for (const a of agents)
      process.stdout.write(`${a.stem.padEnd(30)} ${a.status.padEnd(9)} ${a.calls} calls  ctx ${Math.round(a.ctx / 1000)}k  last ${a.lastAt}\n`);
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
      process.stdout.write(`=== ${a.stem} — ${a.status} · ${a.calls} calls · last ${a.lastAt}\n`);
      process.stdout.write(((allText ? a.texts.join("\n\n") : a.texts.at(-1)) || "(no text yet)") + "\n");
    }
  }
  process.exit(missing ? 1 : 0);
}

if (isMain(import.meta.url)) main();
