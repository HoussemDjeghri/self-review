#!/usr/bin/env node
/**
 * marker.mjs — write a convergence marker.
 *
 * Reached through `converged.sh`, which is the path the Stop gate matches and
 * the path users have permission rules for; this file is where the work
 * happens. See lib/marker.mjs for why the model names fields instead of
 * typing a summary string.
 *
 * Usage:
 *   converged.sh --converged      --rounds N --fixed N --dismissed N --open N [--tier S|M|L] [--forced S|M|L --computed S|M|L] [--adapter X] [--note "…"]
 *   converged.sh --not-converged  --rounds N --fixed N --dismissed N --open N [--tier …] [--adapter …] [--note "…"]
 *   converged.sh --not-applicable <no-code-changed|user-declined|scratch-only|other> [--note "…"]
 *
 * The printed token line is `SELF-REVIEW CONVERGED — <summary>` for every
 * outcome. That token is the gate's protocol signal — "the loop is finished
 * with this turn" — not a claim that the review converged; the claim is the
 * `outcome=` field right behind it. One token keeps the gate, the skill and
 * every existing permission rule on one string.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { NA_REASONS, fieldsFromFlags, formatSummary, validateMarker } from "../hooks/lib/marker.mjs";

const USAGE = [
  "usage: converged.sh --converged      --rounds N --fixed N --dismissed N --open N [--tier S|M|L] [--forced S|M|L --computed S|M|L] [--adapter X] [--note \"…\"]",
  "       converged.sh --not-converged  --rounds N --fixed N --dismissed N --open N [--tier S|M|L] [--forced S|M|L --computed S|M|L] [--adapter X] [--note \"…\"]",
  `       converged.sh --not-applicable <${NA_REASONS.join("|")}> [--note "…"]`,
].join("\n");

const die = (lines) => { console.error([...lines, "", USAGE].join("\n")); process.exit(2); };

/** Best-effort audit log. A logging failure must never hold the turn hostage —
 *  the marker is the only thing that lets it end — so every step is guarded. */
function log(record, summary) {
  const dir = process.env.SELF_REVIEW_LOG_DIR || path.join(homedir(), ".claude", "self-review");
  try {
    mkdirSync(dir, { recursive: true });
    const entry = { ts: new Date().toISOString(), cwd: process.cwd(), summary, ...record };
    appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // Unwritable log dir: the marker still prints. Nothing else depends on it.
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0) die(["a marker needs an outcome."]);

const { fields, problems: argProblems } = fieldsFromFlags(argv);
const { record, problems } = validateMarker(fields);
const all = [...argProblems, ...problems];
if (all.length || !record) die(all.length ? all : ["invalid marker."]);

const summary = formatSummary(record);
log(record, summary);
// Assembled at runtime so that merely printing this file can never emit the token.
console.log(`${"SELF-REVIEW"} ${"CONVERGED"} — ${summary}`);
if (record.note) console.log(`note: ${record.note}`);
