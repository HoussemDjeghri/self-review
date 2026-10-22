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
 *   converged.sh --converged      --rounds N --fixed N --dismissed N --open N --intent validated|author|skipped [--tier S|M|L] [--forced S|M|L --computed S|M|L] [--adapter X] [--review ID] [--work DIR] [--note "…"]
 *   converged.sh --not-converged  --rounds N --fixed N --dismissed N --open N --intent … [--tier …] [--adapter …] [--work DIR] [--note "…"]
 *   converged.sh --not-applicable <no-code-changed|user-declined|scratch-only|other> [--work DIR] [--note "…"]
 *
 * The printed token line is `SELF-REVIEW CONVERGED — <summary>` for every
 * outcome. That token is the gate's protocol signal — "the loop is finished
 * with this turn" — not a claim that the review converged; the claim is the
 * `outcome=` field right behind it. One token keeps the gate, the skill and
 * every existing permission rule on one string.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { INTENT_STATES, NA_REASONS, fieldsFromFlags, formatSummary, validateMarker } from "../hooks/lib/marker.mjs";

const COUNTED = `--rounds N --fixed N --dismissed N --open N --intent <${INTENT_STATES.join("|")}> [--tier S|M|L] [--forced S|M|L --computed S|M|L] [--adapter X] [--review ID] [--work DIR] [--note "…"]`;
const USAGE = [
  `usage: converged.sh --converged      ${COUNTED}`,
  `       converged.sh --not-converged  ${COUNTED}`,
  `       converged.sh --not-applicable <${NA_REASONS.join("|")}> [--work DIR] [--note "…"]`,
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
if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { console.log(USAGE); process.exit(0); }

// --work is where the record is written, not a field of it, so it is taken out
// before the record is parsed.
const workAt = argv.indexOf("--work");
let work = null;
const workProblems = [];
if (workAt !== -1) {
  const value = argv[workAt + 1];
  argv.splice(workAt, 2);
  if (value === undefined || value.startsWith("--")) workProblems.push("--work needs the work: path round.sh printed.");
  else {
    try { work = realpathSync(value); } catch { workProblems.push(`--work ${value} does not exist — pass the work: path round.sh printed.`); }
  }
}

const { fields, problems: argProblems } = fieldsFromFlags(argv);
// The id round.sh printed is `git hash-object` of the resolved work path; derived
// here so the flag and the directory cannot name two different reviews.
if (work) {
  const id = createHash("sha1").update(`blob ${Buffer.byteLength(work)}\0${work}`).digest("hex").slice(0, 8);
  if (fields.review !== undefined && fields.review !== id) workProblems.push(`--review ${fields.review} is not the review in --work ${work} (${id}).`);
  if (fields.outcome !== "not-applicable") fields.review = id;
}
const { record, problems } = validateMarker(fields);
const all = [...workProblems, ...argProblems, ...problems];
if (all.length || !record) die(all.length ? all : ["invalid marker."]);

const summary = formatSummary(record);
// The file is an output other tools read, so a failed write is a failed marker:
// no token. Written whole then renamed, so a reader never sees half a record.
if (work) {
  const file = path.join(work, "CONVERGED.json");
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(record) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    try { unlinkSync(`${file}.tmp`); } catch { /* never written */ }
    console.error(`could not write ${file}: ${e.message} — no marker was made.`);
    process.exit(1);
  }
}
log(record, summary);
// Assembled at runtime so that merely printing this file can never emit the token.
console.log(`${"SELF-REVIEW"} ${"CONVERGED"} — ${summary}`);
if (record.note) console.log(`note: ${record.note}`);
