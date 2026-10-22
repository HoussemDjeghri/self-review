#!/usr/bin/env node
/**
 * findings.mjs — what past reviews of this repository already found.
 *
 * Usage:
 *   findings.mjs record   --work <dir> [--round N] [--in <file|->] [--log-dir <dir>]
 *   findings.mjs prior    --scope <scope.diff> --work <dir> [--out prior.md] [--max N] [--log-dir <dir>]
 *   findings.mjs converge --work <dir> [--round N] [--budget N] [--log-dir <dir>]
 *
 * `--work` is the round's work dir; the review's identity and its repository
 * (the round-1 scope's) are derived from it.
 *
 * A review that cannot remember starts every round cold: the same near-miss in
 * the same file gets re-discovered by a fresh agent every time, at the price of
 * a fresh agent. `record` appends this round's verdicts to a per-repository
 * JSONL under $SELF_REVIEW_LOG_DIR (default ~/.claude/self-review/findings/),
 * outside the repository — the memory of a review must not become a file the
 * next review has to review. `prior` picks the few past findings that touch
 * what changed this time and renders them for `brief.mjs --prior`.
 *
 * Two bounds make this cheap enough to put in every brief: at most
 * `brief.priorMaxLines` lines (10), and one line each. Ranking is string work —
 * same file, then same directory, then a class that belongs to a kind of file
 * that changed — because an agent that decides what to remember costs more than
 * the agent it saves.
 *
 * `prior` drops the running review's own records — same work dir, same id.
 * Round 2 must not be handed round 1's fixes: the loop's rule is that a fix is
 * re-discovered as correct by a cold reader, never taken on faith (SKILL.md §3).
 *
 * Exit 0; 2 usage; 3 an input file is missing, unreadable, or not the schema.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_DIR, isMain, loadConfig, realpathOr } from "../hooks/lib/config.mjs";
import { normaliseRemote, repoId } from "../hooks/lib/repo-id.mjs";
import { auditEngagement, engagementFile, engagementLine, openEngagement } from "../hooks/lib/engagement.mjs";
import { parseDiff } from "./lib/diff.mjs";
import { editDistance } from "./lib/edit-distance.mjs";
import { classifyPath } from "./lib/paths.mjs";
import { workRepo } from "./lib/repo.mjs";

const fail = (message, exitCode = 3) => Object.assign(new Error(message), { exitCode });
const usage = (message) => fail(message, 2);

// --- the record schema -----------------------------------------------------
// `unfixed` is CONFIRMED and not fixed: the applier's `blocked` survived the
// lead's retry, or a design-risk fix the user did not rule on. `open` stays a
// question for the user. Only `unfixed` keeps a review from converging.
export const VERDICTS = new Set(["fixed", "dismissed", "open", "unfixed"]);
const SEVERITIES = new Set(["blocker", "major", "minor"]);
// The finder's `category` vocabulary (agents/self-review-finder.md), mapped to
// the kind of file it is about. Fixed on purpose: matching a past finding
// against a changed file stays string work only while both sides use the same
// words, and "any" is for the classes that read the same on code, docs and
// config. A class this map does not have is a typo, not a new idea — the
// finders pick from the list.
const CLASS_KIND = new Map([
  ["correctness", "code"], ["removed-behavior", "code"], ["cross-file", "code"], ["pitfall", "code"],
  ["security", "code"], ["reuse", "code"], ["simplification", "code"], ["efficiency", "code"],
  ["altitude", "code"], ["accuracy", "docs"], ["completeness", "docs"], ["reader-fit", "docs"],
  ["consistency", "docs"], ["config", "config"], ["intent", "any"], ["verification", "any"],
  ["conventions", "any"], ["shape", "any"], ["out-of-angle", "any"], ["pre-existing", "any"],
  // The cold grader's own class, and the only one no finder emits. It is "code"
  // because angle X exists where the change ships something a user runs. Its
  // absence here refused every X finding at `record`, silently as far as the
  // round could tell: the finding was found, verified, fixed, and then not
  // written down.
  ["cold-run", "code"],
]);
const FIELDS = new Set(["verdict", "file", "line", "severity", "class", "angle", "summary", "mechanism", "proof", "prior_id"]);
// Accepted and not stored. SKILL.md §2c gives every candidate an `id` (`r1-1`…)
// as the lead's handle while merging and verifying one round; it names nothing
// a later review could look up, and `priorId` is what identifies a finding
// across reviews. Refusing it refused candidates written exactly as the skill
// says to write them.
const ROUND_ONLY = new Set(["id"]);
// Optional on purpose: most findings have no prior line to cite, and a required
// field is an invitation to fill it in with something. Eight hex, as `priorId`
// makes them — a value in any other shape is a typo, and a typo that scored as
// a citation would be the one failure mode this field adds.
//
// Any bracketing is accepted on the way in — both, one, or neither — and none of
// it is stored. `prior.md` shows the id as `[83de6191]`, and a finder copying
// what it sees is reading its instructions correctly; a lone stray bracket
// around eight good hex characters is still exactly the id it meant. Being
// strict there would cost the round, not the typo: `recordFindings` validates
// the whole batch before it writes any of it, so one over-punctuated id would
// throw away every finding of the round, the ones that cite nothing included.
// `reviewId` learned the same lesson the hard way — `record` wrote the cleaned
// id while `prior` compared the raw one.
const PRIOR_ID = /^\[?([0-9a-f]{8})\]?$/;
export const priorCiteOf = (value) => (value == null ? null : PRIOR_ID.exec(String(value))?.[1] ?? false);
// Field caps. A record is read back into a brief, where every character is paid
// for on every reviewer call of every later round.
const LIMITS = { review: 120, angle: 40, file: 400, summary: 200, mechanism: 300, proof: 300 };
const PRIOR_SUMMARY = 110, PRIOR_LINE = 200;
// One generation of memory travels forward; older records stay in the file for
// the evals to read. Without this the file grows forever and every review pays
// to parse all of it.
const MAX_READ_BYTES = 1024 * 1024;

/**
 * One line of any field, clamped. Records reach a brief as text, so a summary
 * holding a newline would render as an extra prior finding the reviewer cannot
 * trace to anything, and a zero-width or bidi character could hide what the
 * line really says — the fields are data, not markup.
 */
const clean = (value, limit) => {
  const text = String(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  // By code point, not by code unit: `.slice()` cuts UTF-16 halves, and a cut
  // that lands inside a surrogate pair leaves a lone surrogate that becomes
  // U+FFFD the moment prior.md is written as UTF-8 — a record that says
  // something the finding did not.
  const points = [...text];
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text;
};

/**
 * The stored form of a review id. Both commands derive it here: `record` wrote
 * the cleaned id and `prior` compared the raw flag, so any id that needed
 * cleaning (a full scratchpad path, > 120 characters) silently stopped
 * excluding the review it names — which is the one thing that id exists for.
 */
export const reviewId = (value) => clean(value ?? "", LIMITS.review);

/**
 * The review's identity, derived from the directory the round already lives in
 * rather than retyped: `self-review/review-<k>` for the loop's work dir (one
 * per review, allocated by `round.sh --new-review`), the last two path
 * components for anything else. The id was always "the marker id or the
 * scratch dir name" — this makes the second one
 * structural, so passing the wrong `--work` is visible (the briefs and the
 * scope would be somewhere else too) instead of silently excluding nothing.
 */
export function reviewFromWork(dir) {
  const full = realpathOr(path.resolve(dir));
  const parts = full.split(path.sep).filter(Boolean);
  // The tail alone is not an identity: every session's work dir ends in the
  // same two components (`scratchpad/self-review`), so a tail-only id would
  // exclude every past session's records instead of this review's. The tail is
  // there to be read; the digest of the full path is what makes it unique.
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
  return reviewId(`${parts.slice(-2).join("/")}@${digest}`);
}

// --- one pass, every problem ------------------------------------------
// A wrong payload used to cost one turn per field: toRecord threw on the first
// problem, and the caller is a loop at ~200k of context that fixes its JSON and
// calls again. Measured 2026-08-30: three rejections, ~600k tokens, for one
// payload with three mistakes.

/**
 * The nearest field name or vocabulary word, when there is an unambiguous one.
 * A fixed table first (the spellings actually seen), then an edit distance of
 * at most 2 — which is a typo, not a synonym.
 *
 * The hint shapes the MESSAGE and never the accepted input. `medium` has no
 * unambiguous target on a blocker/major/minor scale, `maintainability` maps to
 * `reuse` only by the reporter's guess, and the vocabulary is what the per-repo
 * memory file is keyed on: an alias accepted once is a second spelling in that
 * memory forever.
 */
const HINTS = new Map([
  ["title", "summary"], ["high", "major"], ["maintainability", "reuse"], ["category", "class"],
  // The two most frequent refusals of 2026-09-28 → 10-14.
  ["nit", "minor"], ["test-coverage", "verification"],
  // The applier's status and the verifier's verdict, recorded as if they were
  // the ledger's: what they mean in the ledger is `unfixed`.
  ["blocked", "unfixed"], ["confirmed", "unfixed"], ["wontfix", "unfixed"],
]);

export function hintFor(value, vocabulary) {
  if (typeof value !== "string" || !value) return "";
  const fixed = HINTS.get(value.toLowerCase());
  if (fixed && vocabulary.includes(fixed)) return ` — did you mean ${fixed}?`;
  const near = vocabulary.filter((word) => editDistance(value.toLowerCase(), word) <= 2);
  return near.length === 1 ? ` — did you mean ${near[0]}?` : "";
}

/** The whole schema in one line, printed with every rejection. */
export const SCHEMA_LINE = [
  `verdict ${[...VERDICTS].join("|")}`,
  `severity ${[...SEVERITIES].join("|")}`,
  `class ${[...CLASS_KIND.keys()].join("|")}`,
  "file", "line", "summary", "mechanism", "proof", "angle", "prior_id",
].join(" · ");

/**
 * The record, plus every problem with it — never a throw. The caller collects
 * across all records and reports once; a record with problems is discarded, and
 * atomicity is what makes that safe (nothing is written unless everything is
 * valid).
 */
export function toRecord(entry, position, { review, round, ts }) {
  const where = `record ${position}`;
  const problems = [];
  const report = (message) => problems.push(`  ${where}: ${message}`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { record: null, problems: [`  ${where}: expected an object, got ${JSON.stringify(entry)}`] };
  }
  const fields = [...FIELDS];
  for (const key of Object.keys(entry)) {
    if (!FIELDS.has(key) && !ROUND_ONLY.has(key)) report(`unknown field ${JSON.stringify(key)}${hintFor(key, fields) || ` — the schema is ${fields.join(", ")}`}`);
  }
  const need = (key, vocabulary, value = entry[key]) => {
    if (vocabulary.includes(value)) return value;
    // The class vocabulary is twenty words. Spelled out in the problem line as
    // well as the schema line it would be most of the message, and the message
    // is what the caller reads at full context.
    const choices = vocabulary.length > 6 ? `one of the ${key} vocabulary in the schema line below` : `one of ${vocabulary.join(", ")}`;
    report(`${key} — ${choices}, got ${JSON.stringify(value)}${hintFor(value, vocabulary)}`);
    return null;
  };
  const text = (key, limit) => {
    const value = clean(entry[key] ?? "", limit);
    if (!value) report(`${key} — a non-empty string is required`);
    return value;
  };
  const line = entry.line ?? null;
  if (line !== null && (!Number.isInteger(line) || line < 1)) {
    report(`line — a positive integer or null, got ${JSON.stringify(entry.line)}`);
  }
  const priorCite = priorCiteOf(entry.prior_id);
  if (priorCite === false) {
    report(`prior_id — the id of a line in prior.md (the eight characters, brackets optional), or leave the field out; got ${JSON.stringify(entry.prior_id)}`);
  }
  const record = {
    ts,
    review,
    round,
    angle: clean(entry.angle ?? "", LIMITS.angle),
    prior_id: priorCite,
    class: need("class", [...CLASS_KIND.keys()]),
    severity: need("severity", [...SEVERITIES]),
    verdict: need("verdict", [...VERDICTS]),
    file: text("file", LIMITS.file),
    line,
    summary: text("summary", LIMITS.summary),
    mechanism: clean(entry.mechanism ?? "", LIMITS.mechanism),
    proof: clean(entry.proof ?? "", LIMITS.proof),
  };
  // "A dismissal without a quoted counter-proof is not a dismissal" is SKILL.md
  // §2d's rule, and until 2026-09-07 it was only prose: the ledger accepted a
  // `dismissed` row with an empty `proof`, and that row then entered every later
  // finder's do-not-refile brief. A wrong FIX is visible in the diff; a wrong
  // dismissal is invisible and it suppresses rediscovery in this loop and in
  // every future loop over the same files. So the one field that makes it
  // checkable is required at the point of writing.
  //
  // Write-time only — deliberately NOT in `recordProblem`, which vets rows
  // already on disk. Rows written before this rule are honest history; failing
  // them there would make the loop forget what it once found, which is the
  // opposite of what this protects.
  if (record.verdict === "dismissed" && !record.proof) {
    report("proof — a dismissal needs the counter-proof quoted (SKILL.md §2d: a dismissal without one is an unverified candidate, not a dismissal)");
  }
  return { record: problems.length ? null : record, problems };
}

/**
 * Why a stored record cannot be trusted, or `null`. One gate for every reader:
 * `convergence` scores a record, `rankPrior` ranks it and `priorLines` prints
 * it, and a row good enough for one is good enough for all three.
 *
 * Rounds 5, 6 and 7 each added a field check inside `convergence`'s own loop —
 * whichever field a finder had just tested — and round 8's angle S called that
 * the wrong layer: `verdict` had the identical hole, unnoticed, and a corrupted
 * one made a fixed blocker vanish from `W` while reporting nothing wrong. The
 * checks below are the constants `toRecord` already validates against on write,
 * so the only rows this rejects are corrupted or hand-edited ones.
 */
export function recordProblem(row) {
  if (!Number.isInteger(row.round) || row.round < 1) return "round is not a positive integer";
  if (!VERDICTS.has(row.verdict)) return `verdict is not one of ${[...VERDICTS].join(", ")}`;
  if (!SEVERITIES.has(row.severity)) return `severity is not one of ${[...SEVERITIES].join(", ")}`;
  if (!CLASS_KIND.has(row.class)) return "class is not one the finders use";
  // Written as `clean(entry.angle ?? "")`, so empty is a record from a run that
  // did not name one — present but unattributable, not corrupt.
  if (typeof row.angle !== "string") return "angle is not a string";
  if (typeof row.review !== "string" || !row.review) return "review is missing";
  if (typeof row.file !== "string" || !row.file) return "file is missing";
  if (typeof row.summary !== "string" || !row.summary) return "summary is missing";
  if (row.prior_id != null && priorCiteOf(row.prior_id) === false) return "prior_id is not an id from prior.md";
  const line = row.line ?? null;
  if (line !== null && (!Number.isInteger(line) || line < 1)) return "line is not a positive integer or null";
  return null;
}

/** A JSON array or one JSON object per line — the finders' state files are JSONL. */
export function toRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

// --- where a repository's memory lives --------------------------------------
// The identity itself is `hooks/lib/repo-id.mjs`'s, because the Stop gate keys
// the branch-debt opt-in on the same id and a hook may not import from here.
export { normaliseRemote, repoId };

export const findingsFile = (repoRoot, { logDir = LOG_DIR } = {}) =>
  path.join(logDir, "findings", `${repoId(repoRoot)}.jsonl`);

// --- record -----------------------------------------------------------------
/**
 * Append this round's verdicts. Every record is validated before the file is
 * opened: a half-written round is a memory that says something no review ever
 * found, and the caller is a loop that can fix its JSON and call again.
 */
export function recordFindings(entries, { review, round, rawRound, repoRoot = process.cwd(), logDir = LOG_DIR, now = () => new Date().toISOString() }) {
  if (!Array.isArray(entries)) throw fail("expected a JSON array, or one JSON object per line");
  const id = reviewId(review);
  if (!id) throw usage("pass --work <this review's work dir>");
  if (!Number.isInteger(round) || round < 1) throw usage(`--round needs a positive integer, not ${JSON.stringify(rawRound ?? round)}`);
  const ts = now();
  const vetted = entries.map((entry, index) => toRecord(entry, index + 1, { review: id, round, ts }));
  const problems = vetted.flatMap((result) => result.problems);
  if (problems.length) {
    // One rejection carrying everything, then the schema: the caller is a loop
    // at full context, and each round trip costs a turn.
    const affected = vetted.filter((result) => result.problems.length).length;
    throw fail([
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${affected} record${affected === 1 ? "" : "s"} — nothing recorded`,
      ...problems,
      `schema: ${SCHEMA_LINE}`,
    ].join("\n"));
  }
  const records = vetted.map((result) => result.record);
  const file = findingsFile(repoRoot, { logDir });
  if (records.length) {
    mkdirSync(path.dirname(file), { recursive: true });
    // One write per call: a single append of a few hundred bytes is what keeps
    // two reviews running at once from interleaving halves of a line.
    appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  return { file, count: records.length, records };
}

// --- prior ------------------------------------------------------------------
/**
 * The tail of the memory file, parsed and vetted. A line that does not parse is
 * `skipped`; one that parses but fails `recordProblem` is `malformed`. Neither
 * is fatal: a review that cannot start because something once wrote half a line
 * is a worse failure than a review that remembers one thing less. Both counts
 * are returned so a caller can say so rather than quietly losing rows.
 */
export function readRecords(file, { maxBytes = MAX_READ_BYTES } = {}) {
  let text;
  try {
    text = readTail(file, maxBytes);
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], skipped: 0, malformed: 0 };
    throw fail(`cannot read ${file} (${error.message})`);
  }
  const records = [];
  let skipped = 0, malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) skipped += 1;
    else if (recordProblem(row)) malformed += 1;
    else records.push(row);
  }
  return { records, skipped, malformed };
}

function readTail(file, maxBytes) {
  const { size } = statSync(file);
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.subarray(0, read).toString("utf8");
    // The cut lands mid-line, and mid-character: dropping through the first
    // newline drops both.
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

const kindOfClass = (className, changedKinds) => {
  const kind = CLASS_KIND.get(className);
  return kind === "any" || changedKinds.has(kind);
};

/**
 * The ≤ max past findings worth putting in a brief: same file (3), same
 * directory (2), a class that belongs to a kind of file that changed (1), ties
 * by recency. `exempt` is the gate's list, threaded through so that a file the
 * rest of the pipeline calls config is not classified as code here.
 *
 * Score 0 is dropped: a finding related to nothing in this change is not
 * context, it is ten lines of noise in every reviewer's budget.
 */
export function rankPrior(records, changedFiles, { max, exclude, exempt } = {}) {
  const changed = new Set(changedFiles);
  const dirs = new Set(changedFiles.map((file) => path.posix.dirname(file)));
  const kinds = new Set(changedFiles.map((file) => classifyPath(file, exempt)));
  // The same finding recorded across rounds (open, then fixed) is one line
  // carrying the newest verdict, not two lines arguing with each other.
  const latest = new Map();
  records.forEach((row, index) => {
    if (exclude && row.review === exclude) return; // both sides in stored form: see reviewId()
    if (typeof row.file !== "string" || typeof row.summary !== "string") return;
    latest.set(`${row.file} ${row.line ?? ""} ${row.class ?? ""} ${row.summary}`, { row, index });
  });
  const scored = [];
  for (const { row, index } of latest.values()) {
    const score = changed.has(row.file) ? 3
      : dirs.has(path.posix.dirname(row.file)) ? 2
        : kindOfClass(row.class, kinds) ? 1 : 0;
    if (score) scored.push({ row, index, score });
  }
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  return scored.slice(0, max ?? Infinity).map((entry) => entry.row);
}

// The identity of a past finding, so a finder can say which line it is
// re-raising instead of leaving the eval to work it out from strings and line
// numbers afterwards. Derived from the record, never from its position:
// `rankPrior` orders by score then recency, so an index names a different
// finding from one round to the next. It hashes the key `rankPrior` already
// dedups on, so a finding recorded twice (open, then fixed) keeps one id.
export const priorId = (row) =>
  createHash("sha256").update(`${row.file} ${row.line ?? ""} ${row.class ?? ""} ${row.summary}`).digest("hex").slice(0, 8);

/**
 * One line each: `[id] file:line · class · summary · verdict`.
 *
 * The summary is what gives way when the line is over budget, never the tail:
 * `clean` truncates from the end, the verdict is last, and the verdict is the
 * one field the memory is scored on — a line ending `· dismiss…` still reads
 * plausibly, which is how that loss would go unnoticed. The `[id] ` prefix ate
 * 11 of the 12 characters of headroom the longest real line had.
 */
export function priorLines(records, { max } = {}) {
  return records.slice(0, max ?? Infinity).map((row) => {
    const where = row.line ? `${row.file}:${row.line}` : row.file;
    const fixed = `[${priorId(row)}] ${where} · ${row.class ?? "?"} ·  · ${row.verdict ?? "?"}`;
    const summary = clean(row.summary, Math.max(0, Math.min(PRIOR_SUMMARY, PRIOR_LINE - [...fixed].length)));
    return `[${priorId(row)}] ${where} · ${row.class ?? "?"} · ${summary} · ${row.verdict ?? "?"}`;
  });
}

const SEVERITY_WEIGHT = { blocker: 3, major: 2, minor: 1 };
// A finder's `angle` is one angle (`S`) or the several a taper merged into it
// (`A+B+D`, `P1+P3` — the notation §2a and tier.mjs's `merged[]` use).
const angleTokens = (angle) => angle.split("+").map((token) => token.trim()).filter(Boolean);

/**
 * SKILL.md §3's convergence arithmetic, computed from the records `record`
 * already writes rather than by the agent running the loop. `W` scores what a
 * round *fixed* (`3·blockers + 2·majors + minors`) and must strictly drop; the
 * comparison is restricted to the angles both rounds ran, because an angle
 * arriving mid-loop brings findings the previous round had no chance to file —
 * angle S enters at round 3 and files every non-`sound` verdict as a blocker by
 * construction, which read as an increase and stopped this tool's own review
 * while it was converging. An angle counts as having run if it
 * filed anything, fixed or not.
 *
 * Angles are compared as the *sets* a finder covered, not as the string it was
 * labelled with. The loop tapers by merging angle groups and never dropping one
 * (§2a), so round 1's `B` and `C` become round 2's `B+C`: compared as strings
 * those two rounds share nothing, every taper returns "nothing comparable", and
 * `W` — the only rule that can stop the loop on evidence — never gets to run.
 * The round cap was carrying termination alone.
 *
 * `budget` is the round cap, taken here rather than left in prose because a
 * ceiling that cannot see the convergence signal cuts off loops that are
 * provably closing — round 8's design gate called that the wrong shape. It can
 * only ever *stop* the loop: `STOP` reports a spent budget and names what ships
 * unreviewed, and never means clean. A round that closed a blocker or a major
 * earns exactly one more round, at any tier, because that fix is the kind a cap
 * must not leave unread; a round that closed only minors, or only dismissed
 * things, earns nothing. A stall (`ESCALATE`) outranks a spent budget.
 *
 * A round that fixed nothing is `CLEAN` before any of that is asked: W compares
 * fixes, and with none there is nothing unreviewed to compare or cap. An empty
 * round is clean only if its record step ran — `recorded` is the caller saying
 * so (the CLI reads the receipt `record` leaves); without it the round is
 * `UNRECORDED`, because a failed `record` leaves exactly the records a clean
 * round does.
 *
 * The oscillation check and the ledger's open items stay with the reader.
 */
export function convergence(records, round, { budget = null, recorded = true } = {}) {
  const rounds = new Map();
  for (const record of records) {
    // Records arrive vetted (`readRecords`). A caller that skipped it would
    // otherwise weigh `undefined` and poison `W` with a NaN, so say which field
    // instead — and say it through the one gate, rather than growing a fourth
    // hand-rolled field check here.
    const problem = recordProblem(record);
    if (problem) throw fail(`convergence needs vetted records: ${problem} in ${JSON.stringify(record.summary ?? record)}`);
    const bucket = rounds.get(record.round) ?? { w: 0, angles: new Set(), fixed: [] };
    const tokens = angleTokens(record.angle);
    for (const token of tokens) bucket.angles.add(token);
    if (record.verdict === "fixed") {
      const weight = SEVERITY_WEIGHT[record.severity];
      bucket.w += weight;
      bucket.fixed.push({ tokens, weight, severity: record.severity });
    }
    rounds.set(record.round, bucket);
  }
  const empty = { w: 0, angles: new Set(), fixed: [] };
  const current = rounds.get(round) ?? empty;
  const previousRound = [...rounds.keys()].filter((n) => n < round).sort((a, b) => b - a)[0];
  const previous = previousRound === undefined ? null : rounds.get(previousRound);
  const shared = previous ? [...current.angles].filter((angle) => previous.angles.has(angle)).sort() : [];
  const sharedSet = new Set(shared);
  // A merged finder did the work of all the angles it covered, so its weight
  // joins the comparison only when *every* one of them is shared — anything
  // else credits a round for coverage the other round did not have. With one
  // angle per record this is the membership test it has always been. The
  // length test is not redundant: a record may name no angle at all (`record`
  // writes `angle` as `clean(entry.angle ?? "")`), and "every angle it covered
  // is shared" is vacuously true of nothing — which would let an untagged
  // record count toward a comparison it is not part of, at full weight.
  const over = (bucket) => bucket.fixed.reduce((total, entry) => total
    + (entry.tokens.length > 0 && entry.tokens.every((token) => sharedSet.has(token)) ? entry.weight : 0), 0);
  const currentShared = previous ? over(current) : 0;
  const previousShared = previous ? over(previous) : 0;
  // What this round fixed at its worst, which is what decides whether the
  // budget may be extended: a round that closed a blocker leaves a blocker's
  // worth of unread change behind it. Dismissals buy nothing — nothing changed.
  const tail = ["blocker", "major", "minor"].find(
    (severity) => current.fixed.some((entry) => entry.severity === severity)) ?? null;
  const earned = budget !== null && round === budget && (tail === "blocker" || tail === "major");
  const spent = budget !== null && round >= budget && !earned;
  // A CONFIRMED defect left standing, anywhere in this review, until a later row
  // cites it by `prior_id` — whatever that row's verdict. The citation is exact
  // where file and summary are not: a fix moves the line `priorId` hashes.
  // Review-wide, because the next round's finders read the ledger and are
  // unlikely to refile it, and their silence would read as CLEAN.
  const unfixed = records
    .filter((record, index) => record.verdict === "unfixed"
      && !records.slice(index + 1).some((later) => later.prior_id === priorId(record)))
    .map(priorId);
  const base = { round, w: current.w, angles: [...current.angles].sort(), shared, currentShared, previousShared, budget, tail, earned, unfixed };
  // A budget is a bound on cost, not a finding of health: when it runs out the
  // loop says so and names what it is leaving unread. `STOP` never means clean.
  const stop = (previousRound) => ({ ...base, previousRound, verdict: "STOP",
    reason: `round budget of ${budget} is spent${tail ? ` — round ${round}'s ${tail} fix ships unreviewed` : ""}` });
  // W silent is not W satisfied: the round fixed something, so §3's "another
  // round is mandatory" holds, and the reason has to say so — leads read the
  // bare "nothing comparable" as a pass, or asked the user what to do.
  const vacuous = (why) => (spent ? stop(previousRound ?? null) : { ...base, previousRound: previousRound ?? null, verdict: "CONTINUE",
    reason: `${why} — neither a stall nor a pass: round ${round}'s fixes are unreviewed, so run round ${round + 1}` });

  // No record and no receipt is a record step that failed or never ran, which
  // reads exactly like a clean round from the records alone. Calling it clean
  // ends a loop on findings that were never written down.
  if (!rounds.has(round) && !recorded) {
    return { ...base, previousRound: previousRound ?? null, verdict: "UNRECORDED", reason: `round ${round} has no records and its record step never succeeded` };
  }
  // A known defect is not a convergence: it outranks CLEAN, an earned extension
  // and W, and only ever ends the review — the retry belongs before `record`.
  if (unfixed.length) {
    return { ...base, earned: false, previousRound: previousRound ?? null, verdict: spent ? "STOP" : "ESCALATE",
      reason: `${unfixed.length} CONFIRMED finding(s) left unfixed: [${unfixed.join(", ")}]` };
  }
  // SKILL §3's clean round: zero findings to fix, open and dismissed items not
  // counted. It needs no comparison — and asking W anyway made an empty round
  // "nothing comparable" (it ran no angle) and a dismissals-only round a stall
  // ("0 did not drop below 0"). It outranks a spent budget: nothing it did
  // ships unreviewed.
  if (!current.fixed.length) {
    const open = records.filter((record) => record.round === round && record.verdict === "open").length;
    return { ...base, previousRound: previousRound ?? null, verdict: "CLEAN",
      reason: `round ${round} fixed nothing — a clean round: converged (SKILL §4)${open ? `; report its ${open} open item${open === 1 ? "" : "s"}` : ""}` };
  }
  if (!previous) return vacuous(`round ${round} is the first change-round, so there is nothing to compare`);
  if (!shared.length) return vacuous(`no angle ran in both round ${previousRound} and round ${round}, so W has nothing to compare`);
  if (!currentShared && !previousShared) return vacuous(`neither round fixed anything on ${shared.join(", ")}, the angles both ran, so W has nothing to compare`);
  const dropped = currentShared < previousShared;
  // A stall outranks a spent budget: "the fixes stopped shrinking the problem"
  // is the thing the reader has to decide about, and it does not become less
  // true for arriving on the last affordable round.
  if (dropped && spent) return stop(previousRound);
  return {
    ...base, previousRound,
    verdict: dropped ? "CONTINUE" : "ESCALATE",
    reason: dropped
      ? `W over ${shared.join(", ")}: ${currentShared} < ${previousShared}`
      : `W over ${shared.join(", ")}: ${currentShared} did not drop below ${previousShared}`,
  };
}

// The commands below are printed with this file's own path, so they run as
// printed wherever the plugin is installed.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Quoted only when the shell would split or expand the word. A leading
// `<placeholder>` is left bare: it is there to be replaced, not run.
const shellWord = (word) => (/^(?:<[\w|]+>)?[\w@%+=:,./-]*$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/**
 * The exact call that acts on a verdict, as `next: …` plus any line the lead
 * needs to read before running it. The verdict used to reach the lead at the
 * top of the NEXT round, so the final round's was never computed — 104
 * converged reviews ended on CONTINUE — and a STOP was answered by spawning a
 * finder, because nothing said what the honest end of a capped review is.
 *
 * First match wins: a clean round converges whatever else is true (its finders
 * read the final state); an earned extension outranks STOP and ESCALATE; STOP
 * and ESCALATE both end `--not-converged`, ESCALATE with the user asked.
 * `counts` are this review's records across all its rounds. `--intent` is left
 * for the lead: whether the ticket was validated is stored nowhere this reads.
 */
export function nextAction(result, counts, { work = null, tier = null, scripts = HERE } = {}) {
  const { round, verdict } = result;
  const dir = work ?? "<work>";
  const identity = `--work ${shellWord(dir)}`;
  const script = (name) => shellWord(path.join(scripts, name));
  const nextRound = [script("round.sh"), "--work", shellWord(dir), "--round", round + 1, "--intent", shellWord(path.join(dir, "intent.md"))].join(" ");
  const marker = (outcome) => [script("converged.sh"), outcome, "--rounds", counts.rounds, "--fixed", counts.fixed,
    "--dismissed", counts.dismissed, "--open", counts.open, "--tier", tier === null || tier === undefined ? "<S|M|L>" : shellWord(tier), "--intent", "<validated|author|skipped>"].join(" ");
  if (verdict === "UNRECORDED") {
    return `next: ${script("findings.mjs")} record ${identity} --round ${round} --in <findings.json>\n`
      + "  `[]` if it had nothing to record (refused while this round's state/ files hold candidates: record each as a row); record then prints the round's verdict and the call after it";
  }
  if (verdict === "CLEAN") return `next: ${marker("--converged")}`;
  const unfixed = result.unfixed ?? [];
  const leaves = `round ${round} leaves ${unfixed.length} CONFIRMED finding(s) unfixed [${unfixed.join(", ")}]`;
  if (verdict === "ESCALATE" && unfixed.length) {
    return `next: ${marker("--not-converged")}\n  ${leaves}: put each to the user with your recommendation.\n`
      + `  If they rule on a fix, apply it, then: ${script("findings.mjs")} record ${identity} --round ${round} with prior_id <id> on the fixed row, and run ${nextRound}.\n`
      + "  A defect they accept as-is is not a convergence: the marker above is the end.";
  }
  if (result.earned) return `next: ${nextRound} --force S --reason "extension round: round ${round} fixed a ${result.tail}"`;
  if (verdict === "STOP") {
    return `next: ${marker("--not-converged")}\n  round ${round}'s fixes ship unreviewed: list them in the report. `
      + "This is the correct end of a capped review; a new review to turn it into converged is not."
      + (unfixed.length ? `\n  ${leaves}: list them in the report.` : "");
  }
  if (verdict === "ESCALATE") {
    return `next: ${marker("--not-converged")}\n  put the stall to the user; if they say continue, run ${nextRound} as usual.`;
  }
  return `next: ${nextRound}`;
}

/**
 * The convergence decision, appended where the audit can read it back.
 *
 * `earned` — the one rule that grants a round beyond the budget — existed only
 * as a printed line, so a review that ran round `budget + 1` was afterwards
 * indistinguishable from one that simply overran, and the round the decision
 * was made on left no trace at all. The decision on round `budget + 1` is
 * logged too: that is what separates granted-and-ran from granted-and-abandoned.
 *
 * `kind` keeps these rows apart from the two marker forms, which carry a
 * `summary` and no kind — the audit's marker fallback scans the same file and
 * would otherwise adopt a converge row as a review's marker.
 *
 * Best effort, like the gate's own logging: a decision that could not be
 * written must not fail the round it belongs to.
 */
export function logConvergence(result, { review, cwd = process.cwd(), logDir = LOG_DIR, now = () => new Date().toISOString() }) {
  const row = {
    ts: now(), kind: "converge", cwd, review,
    round: result.round, budget: result.budget, verdict: result.verdict,
    earned: result.earned, tail: result.tail, w: result.w,
    // What tells a known-defect ESCALATE from a stalled-W one in the audit.
    unfixed: result.unfixed ?? [],
  };
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, "log.jsonl"), `${JSON.stringify(row)}\n`);
    return row;
  } catch (err) {
    process.stderr.write(`findings.mjs: could not log the convergence decision: ${err.message}\n`);
    return null;
  }
}

// --- CLI --------------------------------------------------------------------
const FLAGS = {
  record: ["work", "round", "in", "log-dir"],
  prior: ["scope", "out", "max", "work", "log-dir"],
  converge: ["work", "round", "budget", "log-dir"],
  // tree-guard proves it engaged, and this opens the log it
  // proves it into. `round.sh` runs it before any reviewer starts; `converge`
  // reads it back.
  engagement: ["work", "round", "log-dir"],
};

// The interface used to be learned by failing: `--help` was refused as "pass a
// command", 45 times in 18 sessions, and every refusal sent the caller grepping
// this file for the schema it could have printed.
const USAGE = {
  record: "findings.mjs record --work <dir> [--round N] [--in <file|->] [--log-dir <dir>]\n"
    + "  this round's verdicts, a JSON array or one object per line, on stdin or --in; `[]` records a round with nothing to record, and is refused (exit 3) while the round's state/*.jsonl files hold candidates;\n"
    + "  then prints the round's verdict and `next:`, the call that acts on it",
  prior: "findings.mjs prior --scope <scope.diff> --work <dir> [--out prior.md] [--max N] [--log-dir <dir>]\n"
    + "  the past findings that touch this change, one line each, for brief.mjs --prior",
  converge: "findings.mjs converge --work <dir> [--round N] [--budget N] [--log-dir <dir>]\n"
    + "  each round's W, one verdict — CLEAN, CONTINUE, ESCALATE, STOP or UNRECORDED (SKILL §3) — and `next:`, the call that acts on it",
  engagement: "findings.mjs engagement --work <dir> [--round N] [--log-dir <dir>]\n"
    + "  opens the round's tree-guard engagement log (round.sh runs it)",
};
const RECORD_HELP = [
  `schema: ${SCHEMA_LINE}`,
  "  required: verdict, severity, class, file, summary; a dismissal also needs proof",
  "  angle     free text: the finder's angle as the round's plan names it — one (A, S, X, compact) or a merged group joined by + (A+B+D)",
  "  line      a positive integer, or null",
  "  file, summary, mechanism, proof — one line each",
  "  prior_id  the eight hex characters of the prior.md line it re-raises, brackets optional",
  "  id        the candidate's id in this round (r1-1); accepted, not stored",
].join("\n");
const helpFor = (command) => (command
  ? [`usage: ${USAGE[command]}`, ...(command === "record" ? [RECORD_HELP] : [])]
  : ["usage:", ...Object.values(USAGE).map((line) => `  ${line.replace(/\n/g, "\n  ")}`), RECORD_HELP]).join("\n");
const asksForHelp = (arg) => arg === "--help" || arg === "-h";

// Where `record` says it ran for a round. An empty round leaves no row in the
// memory file, and neither does a `record` that failed or never ran; only this
// lets `converge` tell a clean round from a forgotten one.
const receiptFile = (work, round) => path.join(work, `round-${round}`, "recorded.json");
function receiptRounds(work) {
  let names;
  try {
    names = readdirSync(work);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw fail(`cannot list the work dir ${work} (${error.message})`);
  }
  return names.map((name) => /^round-(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number)
    .filter((round) => existsSync(receiptFile(work, round)));
}

// Candidates the round's reviewers filed under `round-N/state/` (SKILL §2c),
// per file. A verifier's lines are verdicts, possibly on earlier rounds'
// dismissals, so they say nothing about this round and are excluded by name;
// every other `.jsonl` counts, misnamed ones included, because a lead waiting on
// the wrong name reads "no file" and records `[]` over them. A line that does
// not parse counts as nothing: the check refuses, so it leans towards not.
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function objectLines(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    count += Array.isArray(value) ? value.filter(isObject).length : isObject(value) ? 1 : 0;
  }
  return count;
}
function filedCandidates(work, round) {
  const dir = path.join(work, `round-${round}`, "state");
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw fail(`cannot list the round's state dir ${dir} (${error.message})`);
  }
  return names.filter((name) => name.endsWith(".jsonl") && !name.startsWith("self-review-verifier-"))
    .map((name) => ({ name, count: objectLines(read(path.join(dir, name), "a reviewer's state file")) }))
    .filter(({ count }) => count > 0);
}

/**
 * One round's verdict, as `converge` and `record` both state it.
 *
 * The round cap already exists: `tier.mjs` computed it and wrote it into this
 * round's `tier.json` as `roundsCap`. Requiring it to be retyped as a flag
 * meant that forgetting the flag silently turned the cap off — the verdict then
 * answered on `W` alone and reported nothing about a spent budget, which is the
 * one bound on cost the loop has. Read it instead; an explicit `--budget` still
 * wins, so forcing a cap stays possible. The same plan names the tier the
 * marker in `next:` carries.
 */
function judge(mine, round, { work, budget }) {
  let plan = {};
  try { plan = JSON.parse(readFileSync(path.join(work, `round-${round}`, "tier.json"), "utf8")) ?? {}; } catch { /* no plan for this round: the cap is genuinely unknown, and converge says so */ }
  let budgetFrom = budget === null ? "" : " (given)";
  if (budget === null && Number.isInteger(plan.roundsCap) && plan.roundsCap >= 1) {
    budget = plan.roundsCap;
    budgetFrom = ` (round ${round}'s tier.json)`;
  }
  const recorded = existsSync(receiptFile(work, round));
  const result = convergence(mine, round, { budget, recorded });
  // `--open` in the marker stays the count of questions; `unfixed` is counted
  // so it cannot turn its own slot into a NaN.
  const counts = { rounds: round, fixed: 0, dismissed: 0, open: 0, unfixed: 0 };
  for (const record of mine) counts[record.verdict] += 1;
  // The marker's tier is the review's, which round 1 planned; a later round
  // forced to S for an extension does not relabel the review.
  let first = plan;
  if (round !== 1) {
    try { first = JSON.parse(readFileSync(path.join(work, "round-1", "tier.json"), "utf8")) ?? {}; } catch { first = {}; }
  }
  const tier = typeof first.tier === "string" && first.tier ? first.tier : null;
  return { result, budget, budgetFrom, next: nextAction(result, counts, { work, tier }) };
}

// Rows the memory file holds but no reader can use. Said on stderr, never
// fatal, and always with the count: "remembered 4 findings" reads the same
// whether the file held 4 or 40, and only this line tells them apart.
function warnUnusable(skipped, malformed, where = "") {
  const plural = (n) => (n === 1 ? "" : "s");
  if (skipped) process.stderr.write(`findings.mjs: skipped ${skipped} unreadable line${plural(skipped)}${where}\n`);
  if (malformed) process.stderr.write(`findings.mjs: ${malformed} record${plural(malformed)} did not match the record schema${where} and ${malformed === 1 ? "was" : "were"} skipped\n`);
}

const camel = (flag) => flag.replace(/-(.)/g, (_, char) => char.toUpperCase());

function parseArgs(argv, command) {
  const allowed = FLAGS[command];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s) : [null, null];
    if (!name || !allowed.includes(name)) throw usage(`unknown argument ${arg} — ${command} takes ${allowed.map((flag) => `--${flag}`).join(", ")}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw usage(`--${name} needs a value`);
    options[camel(name)] = value;
  }
  return options;
}

const read = (file, what) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw fail(`cannot read ${what} (${file}): ${error.message}`);
  }
};

const tally = (records) =>
  [...VERDICTS].map((verdict) => [verdict, records.filter((record) => record.verdict === verdict).length])
    .filter(([, count]) => count).map(([verdict, count]) => `${count} ${verdict}`).join(", ");

export function main(argv, { log = console.log, stdin } = {}) {
  const [command, ...rest] = argv;
  if (command === "help" || asksForHelp(command)) {
    log(helpFor(null));
    return { help: true };
  }
  if (!command || !Object.hasOwn(FLAGS, command)) {
    throw usage(`pass a command: record, prior, converge or engagement${command ? ` (not ${command})` : ""}; --help for the usage`);
  }
  if (rest.some(asksForHelp)) {
    log(helpFor(command));
    return { help: true };
  }
  const options = parseArgs(rest, command);
  // The work dir is the only identity: the review is named by it and the
  // repository is its round-1 scope's, so there is no second spelling to
  // disagree with it. Checked before any input is read.
  if (!options.work) throw usage("pass --work <this review's work dir>");
  const review = reviewFromWork(options.work);
  const repoRoot = workRepo(options.work);
  const logDir = options.logDir ? path.resolve(options.logDir) : LOG_DIR;

  if (command === "record") {
    const source = options.in ?? "-";
    const text = source === "-" ? (stdin ?? readFileSync(0, "utf8")) : read(path.resolve(source), "the findings");
    let entries;
    try {
      entries = toRecords(text);
    } catch (error) {
      throw fail(`cannot parse the findings (${error.message})`);
    }
    const round = Number(options.round ?? 1);
    // A round round.sh never planned is a typo, not a round: recording it
    // would invent a round dir and a receipt converge then believes.
    if (Number.isInteger(round) && round >= 1) {
      const plan = path.join(options.work, `round-${round}`, "tier.json");
      if (!existsSync(plan)) throw usage(`no plan at ${plan} — round ${round} was never planned; round.sh writes it`);
    }
    // An empty batch over filed candidates is a forgotten round, not a clean
    // one: refused before anything is written, so no receipt and converge says
    // UNRECORDED.
    if (entries.length === 0) {
      const filed = filedCandidates(options.work, round);
      if (filed.length) {
        throw fail(`refusing to record round ${round} as empty: its reviewers filed candidates in ${path.join(options.work, `round-${round}`, "state")} — `
          + `${filed.map(({ name, count }) => `${name} (${count})`).join(", ")}. Every candidate ends as a row (fixed, dismissed with proof, open or unfixed); a merge still leaves one.`);
      }
    }
    const result = recordFindings(entries, { review, round, rawRound: options.round, repoRoot, logDir });
    // After the records, never before: a receipt for a write that failed is
    // the forgotten round dressed as a clean one.
    writeFileSync(receiptFile(options.work, round), `${JSON.stringify({ review, round, count: result.count, ts: new Date().toISOString() })}\n`);
    const counts = tally(result.records);
    log(`# ${result.count} finding${result.count === 1 ? "" : "s"} recorded${counts ? ` (${counts})` : ""} → ${result.file}`);
    // Recording is the last act of a round, so the verdict on it is due now —
    // not at the top of a round the verdict may say not to run.
    const { records, skipped, malformed } = readRecords(result.file);
    warnUnusable(skipped, malformed);
    const verdict = judge(records.filter((record) => record.review === review), round, { work: options.work, budget: null });
    log(`${verdict.result.verdict} — ${verdict.result.reason}`);
    log(verdict.next);
    return result;
  }

  if (command === "engagement") {
    const round = Number(options.round ?? 1);
    if (!Number.isInteger(round) || round < 1) throw usage(`--round needs a positive integer, not ${JSON.stringify(options.round)}`);
    const file = openEngagement(repoRoot, round, { logDir });
    log(`# tree-guard engagement log open for round ${round} → ${file}`);
    return { file, round };
  }

  if (command === "converge") {
    const { records, skipped, malformed } = readRecords(findingsFile(repoRoot, { logDir }));
    warnUnusable(skipped, malformed);
    const mine = records.filter((record) => record.review === review);
    // A clean round has a receipt and no rows, and it is the newest round.
    const rounds = [...mine.map((record) => record.round), ...receiptRounds(options.work)];
    const round = Number(options.round ?? (rounds.length ? Math.max(...rounds) : 1));
    if (!Number.isInteger(round) || round < 1) throw usage(`--round needs a positive integer, not ${JSON.stringify(options.round)}`);
    const given = options.budget === undefined ? null : Number(options.budget);
    if (given !== null && (!Number.isInteger(given) || given < 1)) throw usage(`--budget needs a positive integer, not ${JSON.stringify(options.budget)}`);
    const { result, budget, budgetFrom, next } = judge(mine, round, { work: options.work, budget: given });
    logConvergence(result, { review, logDir });
    for (const n of [result.previousRound, round].filter((n) => n !== null)) {
      const at = convergence(mine, n);
      log(`round ${n}  W=${at.w}  angles: ${at.angles.join(", ") || "none"}`);
    }
    if (result.earned) log(`# round ${round} closed a ${result.tail}: one more round, then the budget is spent whatever it finds`);
    log(`${result.verdict} — ${result.reason}`);
    log(`# the W rule and the round budget${budget === null ? " (none found: W only)" : budgetFrom}; the oscillation check and the ledger's open items stay with you (SKILL §3)`);
    log(next);
    // Did the guard that protects the author's tree actually watch this round?
    // Silence here used to be indistinguishable from "watching nothing".
    let engagement = "";
    try { engagement = readFileSync(engagementFile(repoRoot, logDir), "utf8"); } catch { /* no log here: auditEngagement reports the absence */ }
    // Unconditionally, including for the empty string: a missing log is
    // `opened: false`, which has a line of its own, and gating on truthiness
    // made that line — the one for the case SKILL.md §3 names — unreachable
    // from the only caller. An audit that goes silent when it has nothing to
    // read is the shape this instrument exists to abolish.
    log(engagementLine(auditEngagement(engagement, { round })));
    return result;
  }

  if (!options.scope) throw usage("--scope is required");
  const scope = read(path.resolve(options.scope), "the scope bundle");
  const config = loadConfig(repoRoot);
  const max = Number(options.max ?? config.brief.priorMaxLines);
  if (!Number.isInteger(max) || max < 0) throw usage(`--max needs a non-negative integer, not ${JSON.stringify(options.max)}`);
  const file = findingsFile(repoRoot, { logDir });
  const { records, skipped, malformed } = readRecords(file);
  warnUnusable(skipped, malformed, ` in ${file}`);
  const changed = parseDiff(scope.split("\n")).map((entry) => entry.file);
  const lines = priorLines(rankPrior(records, changed, { max, exclude: review, exempt: config.exempt }), { max });
  if (!options.out) {
    for (const line of lines) log(line);
    return { lines, file };
  }
  // Written even when empty: `brief.mjs --prior` exits 3 on a missing file, and
  // "this repo has no matching memory" is an answer, not a failure.
  const out = path.resolve(options.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
  log(`# ${lines.length} prior finding${lines.length === 1 ? "" : "s"} → ${out}`);
  return { lines, file, out };
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`findings.mjs: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
