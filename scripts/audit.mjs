#!/usr/bin/env node
/**
 * audit.mjs — the referee: what a review actually cost, from the transcripts.
 *
 * A review is the stretch of a session between the first reviewer spawn and the
 * convergence marker. For each one this reports the marker's own numbers
 * (rounds, fixed, dismissed, open, tier, adapter, outcome), the agents it spent,
 * the main-session turns it burned, and the token split between the main session
 * and the reviewers. The README's cost numbers cite this script.
 *
 *   audit.mjs                      every session under ~/.claude/projects
 *   audit.mjs <session.jsonl>…     only those sessions
 *   audit.mjs --json               the objects instead of the report
 *   audit.mjs --log-dir <dir>      where log.jsonl lives (default ~/.claude/self-review)
 *
 * `auditSession()` is the API the eval runner imports; the CLI below is a wrapper
 * around it, so a number in the report is a number in the object.
 *
 * `overlap` reports, per round, how many finders ran, how many candidates each
 * filed, and the share of those candidates another finder of the same round also
 * filed (same file, same or adjacent line, same class). It is a measurement, not
 * a verdict: one review of one kind of change is not evidence that two angles
 * duplicate each other.
 *
 * One honest limit: an API call's usage covers the whole context, not the tool
 * result that provoked it, so reviewer spend cannot be split by tool at the token
 * level. `tooling` therefore counts the reviewer CALLS that read the loop's own
 * artifacts (scope diff, briefs, state files, salvage) — a share of calls, not of
 * tokens, and labelled as such.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isMain } from "../hooks/lib/config.mjs";
import { COUNTS, LABELS, OUTCOMES as MARKER_OUTCOMES, fieldsFromFlags, formatSummary, isCounted, validateMarker } from "../hooks/lib/marker.mjs";
import { words } from "../hooks/lib/shell.mjs";
import { readRecords, reviewFromWork } from "./findings.mjs";

const DEFAULT_PROJECTS = path.join(homedir(), ".claude", "projects");
const DEFAULT_LOG_DIR = process.env.SELF_REVIEW_LOG_DIR || path.join(homedir(), ".claude", "self-review");
// How long after a session's last visible entry a log record may still be its marker.
const MARKER_GRACE_MS = 10 * 60 * 1000;
// The loop's own files: reading these is the cost of running the review, not of reviewing.
const TOOLING_PATHS = /scope\.diff|impact\.(md|json)|tier\.json|\/briefs\/|\/state\/|salvage\.mjs|converged\.sh|prior\.md|ledger\.md/;
const MARKER_FILE = /(^|\/)self-review\/CONVERGED\.json$/;
// The vocabulary is the grammar's, imported rather than copied: a third
// spelling of the same list is how the script, the gate and this referee drift.
const COUNT_KEYS = COUNTS;
// `reason` is a label to the audit because it renders beside the others; the
// grammar keeps it apart because only one outcome may carry it.
const LABEL_KEYS = [...LABELS, "reason"];
const OUTCOMES = new Set(MARKER_OUTCOMES);

const readJsonl = (file) =>
  readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (Array.isArray(message?.content) ? message.content : []).map((block) => block.text ?? "").join("\n");

const toolUses = (entry) =>
  (Array.isArray(entry.message?.content) ? entry.message.content : []).filter((block) => block.type === "tool_use");

/**
 * A marker summary is `key=value` tokens (lib/marker.mjs writes them; SKILL.md
 * §4). Unknown tokens are kept in `notes` rather than dropped — the log holds
 * markers written by hand, before the record was typed, and the report should
 * show what they said.
 *
 * Two rules exist only for those older rows. A count whose value is not an
 * integer stays null and becomes a note: `dismissed=1(rebutted,` used to parse
 * to the STRING "1(rebutted," and the per-tier table's `row.dismissed += …`
 * turned a whole tier's total into "01(rebutted,". And a row with no explicit
 * `outcome=` that says `rounds=0` is reclassified `not-applicable` — zero
 * rounds is not a review that converged, it is the escape hatch before the
 * hatch had a name, and 29 of the first 112 markers are that shape.
 */
export function parseSummary(summary = "") {
  const parsed = { rounds: null, fixed: null, dismissed: null, open: null, tier: null, adapter: null, forced: null, computed: null, reason: null, outcome: "converged", notes: [] };
  let declared = false;
  for (const token of summary.split(/\s+/).filter(Boolean)) {
    if (token === "not-converged") { parsed.outcome = "not-converged"; declared = true; continue; }
    const at = token.indexOf("=");
    const key = at === -1 ? "" : token.slice(0, at);
    const value = token.slice(at + 1);
    if (key === "outcome") {
      if (OUTCOMES.has(value)) { parsed.outcome = value; declared = true; } else parsed.notes.push(token);
    } else if (COUNT_KEYS.includes(key)) {
      if (/^\d+$/.test(value)) parsed[key] = Number(value); else parsed.notes.push(token);
    } else if (LABEL_KEYS.includes(key)) {
      parsed[key] = value;
    } else {
      parsed.notes.push(token);
    }
  }
  if (!declared && parsed.rounds === 0) parsed.outcome = "not-applicable";
  return parsed;
}

// Usage per API call, deduped by message id: a streamed reply spans several lines.
function usageOf(entries) {
  const calls = new Map();
  for (const entry of entries) {
    if (entry.type !== "assistant" || !entry.message?.usage) continue;
    calls.set(entry.message.id ?? entry.uuid, entry.message);
  }
  const total = { calls: calls.size, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, model: null };
  for (const message of calls.values()) {
    const usage = message.usage;
    total.model ??= message.model ?? null;
    total.input += usage.input_tokens ?? 0;
    total.cacheRead += usage.cache_read_input_tokens ?? 0;
    total.cacheWrite += (usage.cache_creation_input_tokens ?? 0) ||
      ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0));
    total.output += usage.output_tokens ?? 0;
  }
  total.billedInput = total.input + total.cacheRead + total.cacheWrite;
  return total;
}

// Every subagent transcript has a sidecar <file>.meta.json — the dispatcher's own
// record of the agent's name and the subagent type it was spawned as. That is the
// authority; the brief-text heuristics below are for transcripts written before
// the sidecar existed, and for reviewers dispatched as `general-purpose`.
const ROLE_OF_TYPE = { "self-review-finder": "finder", "self-review-verifier": "verifier", "self-review-applier": "applier" };

function metaOf(file) {
  const sidecar = file.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(sidecar)) return null;
  try { return JSON.parse(readFileSync(sidecar, "utf8")); } catch { return null; }
}

function roleOf(entries, meta) {
  const declared = ROLE_OF_TYPE[meta?.customAgentType] ?? ROLE_OF_TYPE[meta?.agentType];
  if (declared) return declared;
  const first = entries.find((entry) => entry.type === "user");
  const head = textOf(first?.message).slice(0, 1500);
  // A brief handed over as a file pointer ("Read …/round-1/briefs/r1-ab.md")
  // contains no angle text at all, so the path is the transcript's only evidence.
  const pointer = /self-review\/round-\d+\/briefs\//.test(head);
  // A named agent's type is its name, so the declared map misses every applier
  // the loop actually launched (`self-review-applier-r2`). The name is the
  // evidence; its brief is a directives file, not a brief.
  if (/(^|:)self-review-applier(-|$)/.test(String(meta?.name ?? meta?.agentType ?? ""))) return "applier";
  if (!pointer && !/self-review/i.test(head)) return null;
  if (/\bverif(y|ier)\b/i.test(head) || /\bREFUTED\b/.test(head)) return "verifier";
  if (pointer || /reviewer \d|YOUR ANGLE|round \d/i.test(head)) return "finder";
  return null;
}

/**
 * Which round a reviewer belongs to. The brief is handed over as a path, so the
 * path is the reliable evidence; the angle text and the agent's own name are the
 * fallbacks for a brief passed inline. The name arm matches the round
 * segment wherever it sits, because a generated name leads with the agent
 * type (`self-review-finder-r1-ab`) and only the older, unprefixed shape
 * (`r1-ab`) put it first.
 */
function roundOf(entries, name) {
  const head = textOf(entries.find((entry) => entry.type === "user")?.message).slice(0, 1500);
  const fromPath = /round-(\d+)\//.exec(head) ?? /\bround (\d+)\b/i.exec(head);
  // The shape here is chosen elsewhere: `tier.mjs`'s buildFinders and
  // `brief.mjs`'s buildPlan both emit `<agent-type>-r<round>-<angles>`. There is
  // deliberately no drift test binding this to them, unlike tree-guard's: this
  // arm is reached only by a transcript whose first message carries neither a
  // `round-N/` path nor the words "round N", which a generated brief always
  // does, and the cost of being wrong here is a `round ?` in a retrospective
  // report rather than a lost working tree. Ruled 2026-09-03.
  const fromName = /(?:^|-)r(\d+)(?:-|$)/.exec(name);
  const digits = fromPath?.[1] ?? fromName?.[1];
  return digits === undefined ? null : Number(digits);
}

// A candidate's location, from whichever field carries it. The finder schema has
// moved (`class` was `category`, a range was allowed where a line is asked for),
// and a transcript is read long after the round that wrote it, so read either.
function locate(row) {
  const digits = (value) => { const found = /\d+/.exec(String(value ?? "")); return found ? Number(found[0]) : null; };
  const [head] = String(row?.file ?? "").split(",");
  const [file, suffix] = head.trim().split(":");
  const cls = String(row?.class ?? row?.category ?? "").trim().toLowerCase();
  return file ? { file, line: digits(row?.line) ?? digits(row?.lines) ?? digits(suffix), cls } : null;
}

/**
 * The candidates a finder filed: the last JSON array it wrote, searched from the
 * end backwards over its messages AND over the string arguments of its tool
 * calls. Both halves are needed. A finder commonly signs off after its array
 * ("Findings sent to team-lead: 2 candidates"), so the last message is prose;
 * and a finder running under a lead that reads messages rather than return
 * values puts the array in a `SendMessage` argument, where it is the only copy.
 *
 * An array counts when at least one row locates — an array of strings is some
 * other list the reviewer happened to write. An empty array is a real answer
 * ("nothing found"), but so is the `[]` a sign-off quotes, so a located row
 * anywhere in the transcript outranks one. `null` means no array at all could be
 * read, which is not the same as having filed nothing: a share computed over
 * rows nobody could parse would read as agreement.
 */
// Every `[ … ]` an unfenced message could be offering, longest-reaching first.
// One `indexOf("[")` took the FIRST bracket in the text, so a markdown link in
// the same message ("See [details](url)") made the slice unparseable — and the
// search then walked back to an older message, reporting a previous round's
// candidates as this finder's. Bounded: a message with a lot of brackets is
// prose, and the candidates are fenced in the shape the agents are asked for.
const UNFENCED_TRIES = 8;
function unfenced(text) {
  const close = text.lastIndexOf("]");
  if (close === -1) return [];
  const tries = [];
  for (let at = text.indexOf("["); at !== -1 && at < close && tries.length < UNFENCED_TRIES; at = text.indexOf("[", at + 1)) {
    tries.push(text.slice(at, close + 1));
  }
  return tries;
}

export function candidatesOf(entries) {
  const sourcesOf = (entry) => [
    textOf(entry.message),
    ...toolUses(entry).flatMap((use) => Object.values(use.input ?? {}).filter((value) => typeof value === "string")),
  ];
  let empty = null;
  for (const entry of entries.filter((row) => row.type === "assistant").reverse()) {
    for (const text of sourcesOf(entry)) {
      const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
      for (const source of [...fenced.reverse(), ...unfenced(text)]) {
        let parsed;
        try { parsed = JSON.parse(source); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        const rows = parsed.map(locate).filter(Boolean);
        if (rows.length) return rows;
        if (!parsed.length) empty ??= rows;
      }
    }
  }
  return empty;
}

/**
 * Per round: finders, candidates each, and the share of candidates another
 * finder of the same round also filed. Two candidates are the same defect when
 * they name the same file and class and their lines are the same or adjacent;
 * when either line is unknown, file and class alone decide, because the
 * alternative is to score an unparsed line as disagreement.
 */
export function overlapOf(finders) {
  const rounds = [...new Set(finders.map((finder) => finder.round))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const same = (a, b) => a.file === b.file && a.cls === b.cls &&
    (a.line === null || b.line === null || Math.abs(a.line - b.line) <= 1);
  return rounds.map((round) => {
    const mine = finders.filter((finder) => finder.round === round);
    const known = mine.filter((finder) => finder.candidates !== null);
    const rows = known.flatMap((finder) => finder.candidates.map((row) => ({ ...row, by: finder.name })));
    const shared = rows.filter((row) => rows.some((other) => other.by !== row.by && same(row, other)));
    return {
      round,
      finders: mine.length,
      unread: mine.length - known.length,
      candidates: known.map((finder) => ({ name: finder.name, count: finder.candidates.length })),
      total: rows.length,
      shared: shared.length,
    };
  });
}

/**
 * Every recorded finding, indexed by the review that filed it. One read of the
 * whole memory directory rather than a `repoId` per session: the review id is
 * already unique across repositories, so the repo key buys nothing here and
 * would cost a `git remote` subprocess per session to compute.
 */
export function recordsByReview(logDir) {
  const dir = path.join(logDir, "findings");
  const index = new Map();
  if (!existsSync(dir)) return index;
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl"))) {
    for (const record of readRecords(path.join(dir, name)).records) {
      if (!record?.review) continue;
      if (!index.has(record.review)) index.set(record.review, []);
      index.get(record.review).push(record);
    }
  }
  return index;
}

/**
 * Which audited review window each RECORDED review belongs to: the tightest
 * window that contains all of its records.
 *
 * The join has to be by time — the lead passes `--work "$W"`, so the transcript
 * holds the variable and not the path — and time alone is ambiguous, because
 * review sessions overlap routinely here. Tightest-containing resolves it: a
 * neighbour that merely overlaps is a longer window, and the review's own is
 * the shortest one that still holds every record. Each recorded review is then
 * claimed exactly once, which is what makes the counts add up; claiming by
 * "any window that contains it" inflated the fixed total 3.5x, and then a
 * further 6x when overlapping sessions each claimed the same round.
 */
export function ownerWindows(byReview, reviews) {
  const spans = reviews.map((review) => {
    const from = Date.parse(review.startedAt ?? "");
    const to = review.endedAt ? Date.parse(review.endedAt) + MARKER_GRACE_MS : Infinity;
    return { review, from, to, span: to - from };
  }).filter((one) => Number.isFinite(one.from));
  const owner = new Map();
  for (const [id, records] of byReview) {
    const stamps = records.map((record) => Date.parse(record.ts ?? "")).filter(Number.isFinite);
    if (!stamps.length) continue;
    const first = Math.min(...stamps), last = Math.max(...stamps);
    let best = null;
    for (const one of spans) {
      if (first < one.from || last > one.to) continue;
      if (best === null || one.span < best.span) best = one;
    }
    if (best) owner.set(id, best.review);
  }
  return owner;
}

/**
 * Every re-flag row across every recorded review, labelled by who applied that
 * round's fixes. Computed once, globally, for the reason `ownerWindows` gives.
 * A review no audited window contains keeps its rows and is attributed to the
 * lead: the session that ran it may simply not be on this disk, and dropping it
 * would shrink the denominator of the rate this instrument exists to report.
 */
export function reflagRows(byReview, reviews) {
  const owner = ownerWindows(byReview, reviews);
  return [...byReview].flatMap(([id, records]) => {
    const label = appliedBy(owner.get(id)?.appliers ?? []);
    return reflagOf(records).map((row) => ({ ...row, review: id, by: label(row.round) }));
  });
}

/**
 * The re-flag rate: of the findings a round FIXED, how many did the next round
 * file again? A fix that has to be re-found is a fix that did not hold, and
 * that is the one number that says whether handing application to an agent
 * costs quality. F10c named it; nothing computed it, which is why F10g's hold
 * on the orchestrator waited on a measurement nobody was set up to take.
 *
 * The source is the findings file, not the transcripts: a `fixed` record is the
 * lead's own verdict, and it is the only place a fix is written down. Two
 * records are the same defect on the same rule `overlapOf` uses — same file,
 * same class, lines the same or adjacent, and file-and-class alone when either
 * line is unknown, because scoring an unparsed line as disagreement would read
 * as a fix that held.
 *
 * A round with no round after it is not counted: nothing had the chance to
 * re-file it, and counting it would read as a perfect record for whatever
 * applied the last round.
 */
export function reflagOf(records) {
  const same = (a, b) => a.file === b.file && a.cls === b.cls &&
    (a.line === null || b.line === null || Math.abs(a.line - b.line) <= 1);
  const at = (record) => ({
    file: record.file,
    cls: String(record.class ?? "").trim().toLowerCase(),
    line: Number.isInteger(record.line) ? record.line : null,
  });
  const rounds = [...new Set(records.map((record) => record.round))].sort((a, b) => a - b);
  return rounds.flatMap((round) => {
    const next = records.filter((record) => record.round === round + 1).map(at);
    if (!next.length) return [];
    const fixed = records.filter((record) => record.round === round && record.verdict === "fixed").map(at);
    if (!fixed.length) return [];
    return [{
      review: records[0]?.review ?? null,
      round,
      fixed: fixed.length,
      recited: fixed.filter((one) => next.some((other) => same(one, other))).length,
    }];
  });
}

/**
 * Who applied each round's fixes, from the appliers this review launched. A
 * round with no applier was applied by the lead's own hand — which is the
 * baseline the applier is measured against, so the absence has to be recorded
 * rather than skipped.
 */
export function appliedBy(appliers) {
  const label = new Map();
  for (const applier of appliers) {
    if (applier.round === null) continue;
    label.set(applier.round, `applier@${applier.depth}`);
  }
  return (round) => label.get(round) ?? "lead";
}

// agent-a<name>-<hash>.jsonl is the real file name; the sidecar knows the name
// exactly, and this strips the wrapper when there is no sidecar to ask.
const nameFromFile = (file) =>
  path.basename(file, ".jsonl").replace(/^agent-a?/, "").replace(/-[0-9a-f]{8,}$/, "");

function agentsOf(sessionJsonl) {
  const dir = path.join(path.dirname(sessionJsonl), path.basename(sessionJsonl, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = path.join(dir, name);
      const entries = readJsonl(file);
      const meta = metaOf(file);
      const role = roleOf(entries, meta);
      if (!role || !entries.length) return null;
      const toolCalls = entries.flatMap(toolUses);
      const label = meta?.name ?? nameFromFile(file);
      return {
        name: label,
        role,
        round: role === "verifier" ? null : roundOf(entries, label),
        // Depth 1 is the lead's own hand; a deeper applier was dispatched by
        // something the lead spawned. `spawnDepth` is 0-based in the sidecar.
        depth: (meta?.spawnDepth ?? 0) + 1,
        candidates: role === "finder" ? candidatesOf(entries) : null,
        startedAt: entries[0].timestamp ?? null,
        tokens: usageOf(entries),
        toolCalls: toolCalls.length,
        toolingCalls: toolCalls.filter((use) => TOOLING_PATHS.test(JSON.stringify(use.input ?? {}))).length,
      };
    })
    .filter(Boolean);
}

// A field bag as the summary the rest of this script parses, or null when the
// grammar refuses it: a record the gate would have rejected never ended a
// review, so it is not a marker and the window stays open.
const summaryOfFields = (fields) => {
  const { record } = validateMarker(fields);
  return record ? formatSummary(record) : null;
};

// The marker ends a review: converged.sh at command position, or a Write of the
// scratch CONVERGED.json. Since 0.5.0 both carry the typed record, so both are
// read through the shared grammar — the script's flags and the file's fields
// are the same record in two spellings. The legacy shapes stay readable
// because old transcripts are the whole reason this script has legacy rules:
// one hand-typed summary string, quoted after the script name or under
// `summary` in the JSON.
function markerOf(entry) {
  for (const use of toolUses(entry)) {
    if (use.name === "Bash" && /converged\.sh/.test(use.input?.command ?? "")) {
      const command = use.input.command;
      const tail = command.slice(command.indexOf("converged.sh") + "converged.sh".length);
      // `words` is the tokenizer the gate already reads commands with: a quoted
      // span stays one word, so the legacy summary survives either spelling.
      const argv = words(tail);
      if (!argv.length) return "";
      // The legacy form is one hand-typed summary, and the old script took it
      // unquoted just as happily (`summary="$*"`). A leading flag is the only
      // thing that makes this the typed record.
      if (!argv[0].startsWith("--")) return argv.join(" ");
      return summaryOfFields(fieldsFromFlags(argv).fields);
    }
    if (use.name === "Write" && MARKER_FILE.test(use.input?.file_path ?? "")) {
      let body;
      try { body = JSON.parse(use.input.content ?? ""); } catch { return ""; }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return "";
      if (typeof body.summary === "string") return body.summary;
      return summaryOfFields(body);
    }
  }
  return null;
}

const spawnsReviewer = (entry) =>
  toolUses(entry).some((use) => use.name === "Agent" && /self-review-(finder|verifier)|round \d/i.test(JSON.stringify(use.input ?? {})));

// Both marker forms are logged (the script logs itself, the gate logs the file
// write), so log.jsonl carries summaries for reviews whose marker call is no
// longer in the transcript — a long session drops old tool calls.
function logRecords(logDir, cwd) {
  const file = path.join(logDir, "log.jsonl");
  if (!existsSync(file)) return [];
  return readJsonl(file).filter((record) => record.ts && (!cwd || !record.cwd || record.cwd === cwd));
}

// The two marker forms carry a summary and no kind; `findings.mjs converge`
// appends `kind: "converge"` rows to the same file. Only markers end a review.
const isMarkerRow = (record) => !record.kind;

/**
 * The convergence decisions logged inside a review's window, deduped on
 * (review, round) keeping the last — a round re-run after more fixes decides
 * again, and the last decision is the one that held.
 *
 * A review with fewer decisions than rounds is not a review that earned
 * nothing: it is one whose decisions were not all logged, and hypothesis (b)
 * is UNMEASURED for it. Reviews from before this logging existed have none at
 * all, which is exactly that case.
 */
function convergeIn(log, review) {
  const within = (ts) => ts >= review.startedAt && (!review.endedAt || ts <= review.endedAt);
  const last = new Map();
  for (const row of log) {
    if (row.kind !== "converge" || !review.startedAt || !within(row.ts)) continue;
    last.set(`${row.review ?? ""}#${row.round}`, row);
  }
  const rows = [...last.values()].sort((a, b) => a.round - b.round);
  return { rows: rows.length, earned: rows.filter((row) => row.earned).map((row) => row.round), decisions: rows };
}

/**
 * One session's reviews. `logDir` is consulted for markers the transcript cannot
 * show (the gate writes the file-marker log entry itself), so a review whose
 * marker was logged but not visible here still gets its summary.
 */
export function auditSession(sessionJsonl, { logDir = DEFAULT_LOG_DIR } = {}) {
  const entries = readJsonl(sessionJsonl);
  const agents = agentsOf(sessionJsonl);
  const windows = [];
  let open = null;

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    if (!open && spawnsReviewer(entry)) open = { startedAt: entry.timestamp ?? null, turns: [], summary: null, endedAt: null, markerSource: null };
    if (!open) continue;
    open.turns.push(entry);
    const summary = markerOf(entry);
    if (summary === null) continue;
    open.summary = summary;
    open.endedAt = entry.timestamp ?? null;
    open.markerSource = "transcript";
    windows.push(open);
    open = null;
  }
  if (open) windows.push(open);

  const log = logRecords(logDir, entries.find((entry) => entry.cwd)?.cwd);
  // The session's own last timestamp bounds the final window: log.jsonl is
  // shared by every session in the repo, so without a ceiling an abandoned
  // review would adopt the marker of an unrelated one that ran days later. The
  // grace covers the case this fallback exists for — the marker was the last
  // thing the session did and its tool call is the entry that went missing.
  const sessionEnd = entries.filter((entry) => entry.timestamp).at(-1)?.timestamp ?? null;
  const ceiling = sessionEnd === null ? null : Date.parse(sessionEnd) + MARKER_GRACE_MS;
  windows.forEach((window, index) => {
    if (window.summary !== null || !window.startedAt) return;
    const next = windows[index + 1]?.startedAt;
    const within = next
      ? (ts) => ts < next
      : (ts) => ceiling !== null && Date.parse(ts) <= ceiling;
    const logged = log.find((record) => isMarkerRow(record) && record.ts >= window.startedAt && within(record.ts));
    if (!logged) return;
    window.summary = logged.summary ?? "";
    window.endedAt = logged.ts;
    window.markerSource = "log";
  });
  const reviews = windows.map((window) => finish(window, agents, log));

  return {
    session: path.basename(sessionJsonl, ".jsonl"),
    project: path.basename(path.dirname(sessionJsonl)),
    logDir,
    reviews,
    session_tokens: usageOf(entries),
  };
}

function finish(review, agents, log = []) {
  const { summary, endedAt } = review;
  const inWindow = (agent) =>
    agent.startedAt && agent.startedAt >= review.startedAt && (!endedAt || agent.startedAt <= endedAt);
  const mine = agents.filter(inWindow);
  const byRole = (role) => mine.filter((agent) => agent.role === role);
  const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
  const tokensOf = (rows) => ({
    calls: sum(rows, (r) => r.tokens.calls),
    input: sum(rows, (r) => r.tokens.input),
    cacheRead: sum(rows, (r) => r.tokens.cacheRead),
    cacheWrite: sum(rows, (r) => r.tokens.cacheWrite),
    output: sum(rows, (r) => r.tokens.output),
    billedInput: sum(rows, (r) => r.tokens.billedInput),
  });
  const finders = byRole("finder"), verifiers = byRole("verifier"), appliers = byRole("applier");
  // Which model each role actually ran on, counted. The plan pins finders to
  // sonnet (the agent file's frontmatter, and the per-row `model` tier.mjs
  // writes), but a subagent inherits the session's model wherever that pin is
  // missing or overridden — and a finder that quietly ran on opus costs several
  // times what the plan priced. Reconstructing that from transcripts afterwards
  // is guesswork; the review may as well report it about itself.
  const models = (rows) => rows.reduce((tally, row) => {
    const name = row.tokens.model ?? "unknown";
    return { ...tally, [name]: (tally[name] ?? 0) + 1 };
  }, {});
  const parsed = parseSummary(summary ?? "");
  const converge = convergeIn(log, review);
  return {
    startedAt: review.startedAt,
    endedAt,
    marker: summary,
    markerSource: review.markerSource,
    ...parsed,
    outcome: summary === null ? "unmarked" : parsed.outcome,
    turns: review.turns.length,
    agents: {
      finders: finders.length, verifiers: verifiers.length, appliers: appliers.length,
      names: mine.map((agent) => agent.name),
      models: { finders: models(finders), verifiers: models(verifiers) },
    },
    overlap: overlapOf(finders),
    // Who applied each round, for the re-flag join `main` makes across every
    // session at once. Computing the join HERE was wrong twice over: a window
    // cannot see the other windows, so it labelled a concurrent review's round
    // with its own appliers, and it counted rounds a neighbouring window had
    // already counted. Both are the same mistake — a review belongs to one
    // window and only a global view knows which.
    appliers: appliers.map((agent) => ({ round: agent.round, depth: agent.depth })),
    tokens: { main: usageOf(review.turns), finders: tokensOf(finders), verifier: tokensOf(verifiers) },
    tooling: { calls: sum(mine, (r) => r.toolingCalls), ofToolCalls: sum(mine, (r) => r.toolCalls) },
    // Rounds come from the marker, decisions from the log: fewer decisions than
    // rounds means the record is incomplete, not that no round earned its extra.
    converge: {
      rows: converge.rows,
      earned: converge.earned,
      measured: parsed.rounds !== null && parsed.rounds !== undefined ? converge.rows >= parsed.rounds : converge.rows > 0,
    },
  };
}

function* sessionFiles(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

export function aggregate(reviews) {
  const byTier = new Map();
  for (const review of reviews) {
    const tier = review.tier ?? "unknown";
    const row = byTier.get(tier) ?? { tier, reviews: 0, counted: 0, converged: 0, rounds: 0, fixed: 0, dismissed: 0, agents: 0, turns: 0, billedInput: 0, output: 0 };
    row.reviews += 1;
    // A not-applicable window is a turn the loop did not fit, not a review that
    // cost nothing: counting it in the denominator drags every per-tier average
    // toward zero, which is the same distortion `rounds=0` used to cause.
    row.counted += isCounted(review.outcome) ? 1 : 0;
    row.converged += review.outcome === "converged" ? 1 : 0;
    row.rounds += review.rounds ?? 0;
    row.fixed += review.fixed ?? 0;
    row.dismissed += review.dismissed ?? 0;
    // Gated with the denominator, not beside it: a not-applicable window that
    // spent turns and agents before the hatch was declared would otherwise
    // inflate every per-review average it was just excluded from.
    if (isCounted(review.outcome)) {
      row.agents += review.agents.finders + review.agents.verifiers;
      row.turns += review.turns;
      row.billedInput += review.tokens.main.billedInput + review.tokens.finders.billedInput + review.tokens.verifier.billedInput;
      row.output += review.tokens.main.output + review.tokens.finders.output + review.tokens.verifier.output;
    }
    byTier.set(tier, row);
  }
  return [...byTier.values()].sort((a, b) => String(a.tier).localeCompare(String(b.tier)));
}

function report(audits, reflagRowsIn = []) {
  const millions = (n) => (n / 1e6).toFixed(2) + "M";
  const reviews = audits.flatMap((audit) => audit.reviews.map((review) => ({ ...review, session: audit.session })));
  if (!reviews.length) return "no reviews found (a review is a reviewer spawn followed by a convergence marker)";
  const lines = ["== REVIEWS =="];
  for (const review of reviews) {
    const spent = review.tokens.main.billedInput + review.tokens.finders.billedInput + review.tokens.verifier.billedInput;
    lines.push(
      `  ${(review.startedAt ?? "").slice(0, 16)} ${review.session.slice(0, 8)} tier=${review.tier ?? "?"} ${review.outcome}` +
      ` rounds=${review.rounds ?? "?"} fixed=${review.fixed ?? "?"} dismissed=${review.dismissed ?? "?"}` +
      ` agents=${review.agents.finders}f+${review.agents.verifiers}v turns=${review.turns}` +
      ` billed-in=${millions(spent)} (main ${Math.round(100 * review.tokens.main.billedInput / Math.max(1, spent))}%)` +
      ` tooling=${review.tooling.calls}/${review.tooling.ofToolCalls} reviewer calls`);
    for (const row of review.overlap) {
      const share = row.total ? ` (${Math.round(100 * row.shared / row.total)}%)` : "";
      lines.push(
        `    round ${row.round ?? "?"}: ${row.finders} finder${row.finders === 1 ? "" : "s"}` +
        ` · candidates ${row.candidates.map((finder) => `${finder.name}=${finder.count}`).join(" ") || "none"}` +
        ` · also filed by another finder ${row.shared}/${row.total}${share}` +
        (row.unread ? ` · ${row.unread} finder${row.unread === 1 ? "" : "s"} unread` : ""));
    }
  }
  // The applier's own instrument, aggregated across every review the memory
  // file remembers — the baseline this repo never had. Split by who applied,
  // because that is the whole question: an agent applying fixes is only cheaper
  // if the fixes hold as well as the lead's did.
  // One tally per applier label. The rows arrive already de-duplicated: the
  // global join claims each recorded review once, so there is nothing here to
  // guard against double counting any more.
  const reflag = new Map();
  for (const row of reflagRowsIn) {
    const tally = reflag.get(row.by) ?? { by: row.by, reviews: new Set(), rounds: 0, fixed: 0, recited: 0 };
    tally.reviews.add(row.review);
    tally.rounds += 1;
    tally.fixed += row.fixed;
    tally.recited += row.recited;
    reflag.set(row.by, tally);
  }
  if (reflag.size) {
    lines.push("", "== RE-FLAG (fixes a later round filed again) ==");
    for (const row of [...reflag.values()].sort((a, b) => a.by.localeCompare(b.by))) {
      lines.push(
        `  ${row.by.padEnd(11)} reviews=${row.reviews.size} rounds=${row.rounds}` +
        ` fixed=${row.fixed} re-flagged=${row.recited}` +
        ` (${row.fixed ? Math.round(100 * row.recited / row.fixed) : 0}%)`);
    }
    lines.push("  a round whose fixes no later round could re-file is not counted — nothing had the chance");
  }
  lines.push("", "== BY TIER ==");
  for (const row of aggregate(reviews)) {
    // Averages are per REVIEW, so the denominator is the reviews — the
    // not-applicable windows are reported beside n, not divided into it.
    const per = Math.max(1, row.counted);
    const na = row.reviews - row.counted;
    lines.push(
      `  tier ${String(row.tier).padEnd(7)} n=${row.reviews}${na ? ` (${na} n/a)` : ""} converged=${row.converged}/${row.counted}` +
      ` rounds/review=${(row.rounds / per).toFixed(1)} agents/review=${(row.agents / per).toFixed(1)}` +
      ` turns/review=${(row.turns / per).toFixed(1)} billed-in/review=${millions(row.billedInput / per)}` +
      ` fixed=${row.fixed} dismissed=${row.dismissed}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const fail = (message, exitCode) => { throw Object.assign(new Error(message), { exitCode }); };
  const asJson = argv.includes("--json");
  const logAt = argv.indexOf("--log-dir");
  if (logAt !== -1 && argv[logAt + 1] === undefined) fail("--log-dir needs a directory", 2);
  const logDir = logAt === -1 ? DEFAULT_LOG_DIR : argv[logAt + 1];
  const logValueAt = logAt === -1 ? -1 : logAt + 1;
  const files = argv.filter((arg, index) => !arg.startsWith("--") && index !== logValueAt);
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) fail(`not a session transcript: ${file}`, 3);
  }
  const targets = files.length ? files : [...sessionFiles(DEFAULT_PROJECTS)];
  const audits = targets
    .map((file) => auditSession(file, { logDir }))
    .filter((audit) => audit.reviews.length);
  // Read once, here: this walks the whole findings directory, and doing it
  // inside auditSession re-parsed it for every one of the ~1,200 transcripts
  // under the projects root — 6.9s of identical work whose result was then
  // thrown away for every session that held no review.
  const rows = reflagRows(recordsByReview(logDir), audits.flatMap((audit) => audit.reviews));
  process.stdout.write((asJson ? JSON.stringify({ audits, reflag: rows }, null, 2) : report(audits, rows)) + "\n");
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`audit.mjs: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
