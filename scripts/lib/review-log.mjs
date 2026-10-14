/**
 * Per-review facts, logged where they are produced. The work dir holds
 * `tier.json`, `wait.json` and the verifier briefs, but it lives in the
 * session's /tmp scratchpad and is gone days later, so a review measured after
 * the fact had lost them — 146 reviews in the field data had. Each script that
 * writes one of those files therefore
 * also appends one row to `log.jsonl`, keyed by the same `review` the converge
 * rows carry, so the metrics join needs no new key.
 *
 * Copying the work dir at marker time was the alternative, and lost: 45 of
 * the 306 reviews had no marker, and those are the ones most worth measuring.
 *
 * **What a row may hold:** the project root (as `cwd`, which every row in this
 * file already carries), numbers, enum codes and the review key. Never a path
 * inside the project, code, finding text or message text — `tier.json`'s
 * reasons and marker evidence quote all three. `counts` enforces that by
 * construction rather than by a list of keys to leave out, because a list of
 * exclusions misses the next field someone adds to the source.
 *
 * Best effort, like `logPriorShown` and `logConvergence`: the work-dir file is
 * the round's real output, and bookkeeping that could not be written must not
 * fail it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LOG_DIR } from "../../hooks/lib/config.mjs";
import { reviewFromWork } from "../findings.mjs";

export function logReviewRow(kind, fields, { work, script, cwd = process.cwd(), logDir = LOG_DIR, now = () => new Date().toISOString() }) {
  try {
    const row = { ts: now(), kind, cwd, review: reviewFromWork(work), ...fields };
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, "log.jsonl"), `${JSON.stringify(row)}\n`);
    return row;
  } catch (error) {
    process.stderr.write(`${script}: could not log the ${kind} row: ${error.message}\n`);
    return null;
  }
}

/**
 * The numbers in a value and nothing else: a string is dropped, an array
 * becomes its length (marker evidence and untested files are lists of quoted
 * paths, and how many is the signal), an object is walked.
 */
export function counts(value) {
  if (Array.isArray(value)) return value.length;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const kept = counts(inner);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

// `forced` and `cappedTo` are tier letters and `capLifted` a list of marker
// names, so the override is said as one code instead of carrying any of them.
const override = (result) => result.forced ? "forced" : result.cappedTo ? "held" : result.capLifted ? "lifted" : null;

export const tierRow = (result) => ({
  round: result.round, tier: result.tier, computed: result.computed, override: override(result), split: result.split,
  verifier: result.verifier, roundsCap: result.roundsCap, finders: result.finders.length,
  metrics: counts(result.metrics), markers: counts(result.markers),
});

/** The tier.json write's row. `outDir` is `<work>/round-N/`, as round.sh passes it. */
export const logTier = (result, outDir, options = {}) =>
  logReviewRow("tier", tierRow(result), { work: path.dirname(path.resolve(outDir)), script: "tier.mjs", ...options });

export const ROLE = /^self-review-(finder|cold-grader|verifier|applier)(?:-|$)/;

/** How many of each: `{finder: 3, verifier: 1}`. A name no role matches is `other`. */
export const tally = (keys) => keys.reduce((out, key) => ({ ...out, [key]: (out[key] ?? 0) + 1 }), {});
export const roleOf = (name) => ROLE.exec(name)?.[1] ?? "other";
