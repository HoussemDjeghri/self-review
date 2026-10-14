#!/usr/bin/env node
// self-review salvage — recover a subagent's work from its transcript.
//
// A reviewer that dies (usage-limit reset, closed session) or goes idle
// without delivering its report leaves its full transcript on disk at
// <project>/<session-id>/subagents/agent-*.jsonl. The tokens it burned are
// already paid for, and a finished agent's report is sitting in its last
// message — so the lead salvages before re-spawning anything. Read-only.
//
// The three-way verdict is `hooks/lib/agents.mjs`'s, shared with wait.mjs so
// the two cannot disagree about what "finished" means. This script used to
// decide it alone and require `stop_reason: "end_turn"`, which only 16 of 119
// transcripts sampled on 2026-09-03 carried: it called roughly three finished
// agents in four "partial", and a lead that believed it re-spawned work that
// was already done.
//
// Usage: salvage.mjs <session-id | session-dir | session-jsonl | subagents-dir> [name…] [--all-text]
//   no name     list every agent: finished/active/dead, model calls, context size, last activity
//   name…       print each named agent's last message (its report, when finished) —
//               the newest launch of each name; a transcript stem picks an older one
//   --all-text  print every text block instead (an unfinished agent's interim notes)
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { agentStatus, readAgent, resolveSubagentsDir } from "../hooks/lib/agents.mjs";
import { isMain, loadConfig } from "../hooks/lib/config.mjs";
import { gitRoot } from "./lib/repo.mjs";

function fail(msg) {
  process.stderr.write(`salvage: ${msg}\n`);
  process.exit(2);
}

const USAGE = "usage: salvage.mjs <session-id | session-dir | session-jsonl | subagents-dir> [name…] [--all-text]";

function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(`${USAGE}\n  no name     list every agent\n  name…       print each named agent's last message\n  --all-text  print every text block instead\n`);
    return;
  }
  // A mistyped flag would otherwise be read as a session or an agent name.
  const unknown = args.find((a) => a.startsWith("-") && a !== "--all-text");
  if (unknown) fail(`unknown flag ${unknown} — salvage.mjs takes --all-text and --help`);
  const allText = args.includes("--all-text");
  const positional = args.filter((a) => a !== "--all-text");
  if (positional.length === 0) fail(USAGE);
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
    // The stem carries the name only when the harness put it in the file name;
    // `a.name` also reads it from the sidecar a bare-hex transcript has.
    const loose = agents.filter((a) => a.stem.includes(name) || a.name?.includes(name));
    if (loose.length === 0) {
      process.stderr.write(`salvage: no transcript matches "${name}"\n`);
      missing++;
      continue;
    }
    // An exact name outranks every name it is a substring of: `X-2` is the
    // agent the harness renamed off a colliding `X`, a different agent. A
    // transcript's own stem outranks both, and is how an older launch the
    // warning below lists is reached.
    const exact = [(a) => a.stem === name, (a) => a.name === name].map((is) => loose.filter(is)).find((found) => found.length);
    const hits = exact ?? loose;
    // One report per agent name, the newest launch of it. A name used again —
    // a later review, before names carried the review number, or a re-spawn
    // under the same name — leaves older transcripts that match just as well,
    // and printing those beside the newest returned another review's report
    // as this one's, noticed only by reading timestamps (at least 5 times).
    const byName = new Map();
    for (const a of hits) {
      const key = a.name ?? a.stem;
      byName.set(key, [...(byName.get(key) ?? []), a]);
    }
    for (const [key, launches] of byName) {
      const [a, ...older] = launches.sort((x, y) => (y.startedMs || y.mtimeMs) - (x.startedMs || x.mtimeMs));
      if (older.length) {
        process.stderr.write(`salvage: "${key}" was launched ${launches.length} times — printing the newest; older (pass a stem to print one): ${older.map((o) => `${o.stem} (last ${o.lastAt})`).join(", ")}\n`);
      }
      process.stdout.write(`=== ${a.stem} — ${a.status} · ${a.calls} calls · last ${a.lastAt}\n`);
      process.stdout.write(((allText ? a.texts.join("\n\n") : a.texts.at(-1)) || "(no text yet)") + "\n");
    }
  }
  process.exit(missing ? 1 : 0);
}

if (isMain(import.meta.url)) main();
