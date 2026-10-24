#!/usr/bin/env node
/**
 * retro.mjs — the script half of /self-review:retro: what the plugin did across
 * the user's own sessions, reduced to what a field report may carry.
 *
 *   retro.mjs signals  [days]           the allowlisted table: enums and counts only
 *   retro.mjs episodes [days]           the transcript windows worth reading, one file each
 *   retro.mjs check <YYYY-MM-DD>.md     the lint: exits 1 and names every line that leaks
 *
 *   dirs come from SELF_REVIEW_PROJECTS_DIR, SELF_REVIEW_LOG_DIR, SELF_REVIEW_SETTINGS, SELF_REVIEW_RETRO_DIR: the skill pre-approves this command, so nothing on its command line may choose a path
 *   episodes: --cap 8  --tokens 15000
 *
 * Three properties carry it:
 *
 * - `signals` is built from an allowlist, not filtered by a denylist. Every key
 *   it prints is a fixed label or a value that matched a closed vocabulary or an
 *   enum-shaped pattern; anything else is counted as `other`. So a cwd, a
 *   session id or a note that turned up in an enum field cannot leave by that
 *   route — and the report pastes this table verbatim, so this is the one part
 *   of it nobody re-reads.
 * - `episodes` picks at most `--cap` windows of about `--tokens` tokens. Reading
 *   every session costs ~40x as much (4.68M tokens against 120k, measured over
 *   50 sessions), and the measured windows carried 8 of 11 known weaknesses.
 * - `check` is the backstop under the user's own read, never a substitute for
 *   it: it knows every directory the user worked in, because the logs record
 *   them, so it can refuse those mechanically. A third-party name that is in no
 *   cwd is beyond it, and the skill says so.
 *
 * Nothing here opens a network path; the skill prints how to submit, and the
 * user does it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, isMain } from "../hooks/lib/config.mjs";
import { OUTCOMES, reasonsFor } from "../hooks/lib/marker.mjs";
import { commandOf, separateHeredocs, splitSegments, words } from "../hooks/lib/shell.mjs";
import { isHumanPrompt, textOf } from "../hooks/lib/transcript.mjs";
import { agentNameOf } from "../hooks/lib/agents.mjs";
import { walkFiles } from "../hooks/lib/tree.mjs";
import { auditSession, parseSummary, recordsByReview, reflagOf } from "./audit.mjs";

const DAY = 86_400_000;
const HOME = homedir();
const DEFAULTS = {
  projects: process.env.SELF_REVIEW_PROJECTS_DIR || path.join(HOME, ".claude", "projects"),
  logDir: process.env.SELF_REVIEW_LOG_DIR || path.join(HOME, ".claude", "self-review"),
  settings: process.env.SELF_REVIEW_SETTINGS || path.join(HOME, ".claude", "settings.json"),
};
// Claude Code's own default for cleanupPeriodDays.
const DEFAULT_RETENTION_DAYS = 30;
// Temp-dir cwds are dropped from the signals rows and from `check`'s watch list:
// the plugin's test suite and the eval corpus write thousands of them, with
// basenames like `repo` and `target`. The trade: a path under a temp dir is
// still refused by the absolute-path clause, but the bare name of a project
// that only ever lived under a temp dir is not watched.
const TEMP_CWD = new RegExp(`^(${[tmpdir().endsWith("/") ? tmpdir() : `${tmpdir()}/`, "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
export const isTempCwd = (cwd) => typeof cwd === "string" && TEMP_CWD.test(cwd.endsWith("/") ? cwd : `${cwd}/`);
// The plugin's own scripts, read from the tree rather than listed, so a new one
// is recognised the day it ships.
const PLUGIN_SCRIPTS = readdirSync(path.join(PLUGIN_ROOT, "scripts")).filter((f) => /\.(sh|mjs)$/.test(f) && !f.endsWith(".test.mjs"));
const PLUGIN_SCRIPT = new RegExp(`\\b(${PLUGIN_SCRIPTS.map((f) => f.replace(/\./g, "\\.")).join("|")})\\b`);
const GATE_TAG = "[self-review-gate]";
const isGateBlock = (text) => text.trimStart().startsWith("Stop hook feedback:") && text.includes(GATE_TAG);
const REVIEWER = /self-review-(finder|verifier|cold-grader)/;
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// ---------- reading ----------

const readJsonl = (file) => {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};
const inPeriod = (period, ts) => typeof ts === "string" && ts >= period.since && ts < period.until;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const mtimeOf = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

/**
 * The period a retro covers. With no `days`, it is the shorter of "since the
 * last retro" and the user's transcript retention: older than that, Claude Code
 * has deleted the transcripts, and a period reaching past them would promise
 * windows that no longer exist (amendment 3). A draft dated today does not
 * count as the last retro — running it again the same day is redoing it.
 */
export function periodOf({ days = null, now = Date.now(), settings = DEFAULTS.settings, retroDir, projects = DEFAULTS.projects } = {}) {
  let retention = DEFAULT_RETENTION_DAYS;
  try {
    const value = JSON.parse(readFileSync(settings, "utf8")).cleanupPeriodDays;
    if (Number.isInteger(value) && value > 0) retention = value;
  } catch { /* no settings file, or not JSON: Claude Code's default applies */ }
  const today = isoDay(now);
  const last = existsSync(retroDir ?? "")
    ? readdirSync(retroDir).map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1]).filter((d) => d && d < today).sort().at(-1) ?? null
    : null;
  let since, basis;
  if (days !== null) { since = now - days * DAY; basis = "requested"; }
  else {
    since = now - retention * DAY; basis = "retention";
    if (last && Date.parse(last) > since) { since = Date.parse(last); basis = "last-retro"; }
  }
  const oldest = oldestTranscript(projects);
  return {
    since: new Date(since).toISOString(), until: new Date(now).toISOString(), days: Math.max(1, Math.round((now - since) / DAY)),
    basis, retentionDays: retention, lastRetro: last,
    // The header's "windows before this date no longer exist" line.
    missingBefore: oldest !== null && oldest > since ? isoDay(oldest) : null,
  };
}

/** When the oldest surviving main transcript was started, or null when there are none. */
export function oldestTranscript(projects) {
  let oldest = null;
  for (const file of sessionFiles(projects)) {
    let stat;
    try { stat = statSync(file); } catch { continue; }
    // Some filesystems report no birth time, and Linux keeps the birth time of
    // a copy or restore rather than the original's; the earlier of birth and
    // mtime is then a later bound, which can only make the "no longer exist"
    // line fire early, never miss.
    const born = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
    if (oldest === null || born < oldest) oldest = born;
  }
  return oldest;
}

function sessionFiles(projects) {
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((dir) => {
    try { return readdirSync(path.join(projects, dir)).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(projects, dir, f)); }
    catch { return []; }
  });
}

/**
 * Every session in the period that touched the plugin, main chain only, with
 * what the selector needs: gate blocks, plugin-script results, reviewer spawns,
 * and the lead's deletions outside the project once a review has started.
 */
export function readSessions(projects, period) {
  const sessions = [];
  for (const file of sessionFiles(projects)) {
    if (mtimeOf(file) < Date.parse(period.since)) continue; // nothing in it can be in the period
    const entries = readJsonl(file).filter((e) => !e.isSidechain && (!e.timestamp || inPeriod(period, e.timestamp)));
    if (!entries.some((e) => e.timestamp)) continue;
    const session = parseSession(file, entries);
    if (session.plugin && !isTempCwd(session.cwd)) sessions.push(session);
  }
  return sessions;
}

export function parseSession(file, entries) {
  const calls = new Map();
  const events = [];
  const turnOf = [];
  const cwd = entries.find((e) => e.cwd)?.cwd ?? null;
  let turn = 0, plugin = false, reviewerAt = null;
  entries.forEach((entry, idx) => {
    if (isHumanPrompt(entry)) turn++;
    turnOf[idx] = turn;
    if (entry.type === "assistant") {
      for (const block of entry.message?.content ?? []) {
        if (block?.type !== "tool_use") continue;
        calls.set(block.id, block);
        const command = block.input?.command ?? "";
        if (block.name === "Bash" && PLUGIN_SCRIPT.test(command)) plugin = true;
        if (AGENT_TOOLS.has(block.name) && REVIEWER.test(`${block.input?.subagent_type ?? ""} ${block.input?.name ?? ""}`)) {
          plugin = true;
          reviewerAt ??= idx;
        }
        if (block.name === "Bash" && reviewerAt !== null && cwd) {
          const target = outsideDeletion(command, { cwd, home: HOME });
          if (target) events.push({ type: "outside-write", idx });
        }
      }
    }
    if (entry.type !== "user") return;
    const text = textOf(entry.message?.content);
    if (isGateBlock(text)) { plugin = true; events.push({ type: "block", idx, line: text.trimStart().split("\n")[1] ?? "" }); }
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block?.type !== "tool_result") continue;
      const command = calls.get(block.tool_use_id)?.input?.command ?? "";
      if (!PLUGIN_SCRIPT.test(command)) continue;
      // Before 0.8.6 wait.mjs logged no row for an agent it could not find; the
      // transcript's "(no transcript)" is the only record of those.
      if (/\bwait\.mjs\b/.test(command) && /no transcript/.test(textOf([block]))) events.push({ type: "unknown-name", idx });
    }
  });
  const stamps = entries.map((e) => e.timestamp).filter(Boolean);
  return { file, entries, events, turnOf, plugin, cwd, reviewerAt, first: stamps[0], last: stamps.at(-1) };
}

// ---------- the two outside-write rules (amendment 2) ----------

const under = (child, parent) => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const SCRATCH = (home) => [path.join(home, ".claude"), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/** `~`, `$HOME` and `${HOME}` expanded, relative paths resolved; null for anything a variable still decides. */
function expand(word, dir, home) {
  const plain = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (plain.includes("$") || plain.includes("`")) return null;
  return path.resolve(dir, plain);
}

/** The words of each simple command, with the directory it runs in after any `cd` before it. */
function commandsIn(command, cwd, home) {
  let dir = cwd;
  const out = [];
  // Heredoc bodies are a script's text, not this shell's commands.
  for (const segment of splitSegments(separateHeredocs(command).shell)) {
    const ws = words(segment);
    const name = commandOf(ws);
    if (name === "cd") {
      const target = ws[ws.indexOf("cd") + 1];
      const next = target === undefined ? home : expand(target, dir, home);
      if (next) dir = next;
      continue;
    }
    out.push({ ws, name, dir });
  }
  return out;
}

/**
 * Rule (a): the lead removes or moves something under the user's home that is
 * neither the session's project nor scratch — the shape of the hand-cleanup
 * after a reviewer wrote into ~/.config/<app>/ while the tree-guard showed every
 * call matched. Returns the first such path, or null.
 */
export function outsideDeletion(command, { cwd, home }) {
  for (const { ws, name, dir } of commandsIn(command, cwd, home)) {
    if (!["rm", "rmdir", "unlink", "mv"].includes(name)) continue;
    const operands = ws.slice(ws.indexOf(name) + 1).filter((w) => !w.startsWith("-"));
    // mv's last operand is where things go, not what is removed: moving a
    // project file to ~/.Trash is not a write outside the project.
    for (const word of name === "mv" ? operands.slice(0, -1) : operands) {
      const target = expand(word, dir, home);
      if (!target || !under(target, home) || under(target, cwd)) continue;
      if (SCRATCH(home).some((scratch) => under(target, scratch))) continue;
      return target;
    }
  }
  return null;
}

/**
 * Rule (b): a reviewer runs git that discards work, in the user's real checkout.
 * Read-only forms (`stash list`, `clean -n`, `restore --staged`) are not discards. A reviewer's own
 * worktree or scratch copy is outside the checkout and is its to wreck; `start`
 * is the directory the command ran in.
 */
export function destructiveGit(command, { cwd, start = cwd, home = HOME }) {
  for (const { ws, name, dir } of commandsIn(command, start, home)) {
    if (name !== "git") continue;
    let i = ws.indexOf("git") + 1, at = dir;
    while (i < ws.length && ws[i].startsWith("-")) {
      if (ws[i] === "-C" && ws[i + 1] !== undefined) { at = expand(ws[i + 1], at, home) ?? at; i += 2; }
      else i += ws[i] === "-c" ? 2 : 1;
    }
    const [sub, ...args] = ws.slice(i);
    const discards =
      (sub === "checkout" && (args.includes("--") || args.includes("."))) ||
      (sub === "restore" && (!args.some((a) => a === "--staged" || a === "-S") || args.some((a) => a === "--worktree" || a === "-W"))) ||
      (sub === "stash" && !["list", "show"].includes(args[0])) ||
      (sub === "clean" && args.some((a) => a.startsWith("-")) && !args.some((a) => a === "-n" || a === "--dry-run" || /^-[^-]*n/.test(a))) ||
      (sub === "reset" && args.includes("--hard"));
    if (discards && cwd && under(at, cwd)) return true;
  }
  return false;
}

/** Rule (b)'s episodes: each reviewer transcript of a session, scanned for discarding git. */
function reviewerEpisodes(session, period) {
  const dir = path.join(session.file.slice(0, -".jsonl".length), "subagents");
  if (!existsSync(dir) || !session.cwd) return [];
  const eps = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const file = path.join(dir, name);
    if (mtimeOf(file) < Date.parse(period.since) || !REVIEWER.test(reviewerTypeOf(file))) continue;
    const entries = readJsonl(file).filter((e) => !e.timestamp || inPeriod(period, e.timestamp));
    const idx = entries.findIndex((e) => e.type === "assistant" && (e.message?.content ?? []).some((b) =>
      b?.type === "tool_use" && b.name === "Bash" && destructiveGit(b.input?.command ?? "", { cwd: session.cwd, start: e.cwd ?? session.cwd })));
    if (idx === -1) continue;
    eps.push({ type: "outside-write", source: { file, entries, turnOf: entries.map(() => 0), reviewer: true }, session, idx, n: 1 });
  }
  return eps;
}

function reviewerTypeOf(file) {
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return `${meta.spawnedAgentType ?? ""} ${meta.customAgentType ?? ""} ${meta.agentType ?? ""} ${meta.name ?? ""}`;
  } catch {
    return agentNameOf(file) ?? ""; // older transcripts carry the type only in their name
  }
}

// ---------- episodes ----------

/** The plugin's own records for the period, with the test suite's temp-dir rows dropped. */
export function readLogs(logDir, period) {
  const keep = (row) => inPeriod(period, row.ts) && !isTempCwd(row.cwd);
  const gateDir = path.join(logDir, "gate");
  const gate = existsSync(gateDir) ? readdirSync(gateDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readJsonl(path.join(gateDir, f))) : [];
  const records = [...recordsByReview(logDir)].filter(([, rows]) => rows.some((r) => inPeriod(period, r.ts)));
  return { log: readJsonl(path.join(logDir, "log.jsonl")).filter(keep), gate: gate.filter(keep), records };
}

const idxAt = (session, ts) => { let best = 0; session.entries.forEach((e, i) => { if (e.timestamp && e.timestamp <= ts) best = i; }); return best; };
// A log row belongs to the session whose project holds its cwd and whose span holds its time.
const owns = (session, row, graceMs = 10 * 60e3) => row.cwd && session.cwd &&
  (under(row.cwd, session.cwd) || under(session.cwd, row.cwd)) &&
  row.ts >= session.first && Date.parse(row.ts) <= Date.parse(session.last) + graceMs;
const isMarkerRow = (row) => !row.kind && row.summary !== undefined;
const outcomeOf = (row) => row.outcome ?? parseSummary(row.summary ?? "").outcome;

export function findEpisodes(sessions, { log, gate, records }, period, { logDir = DEFAULTS.logDir } = {}) {
  const eps = [];
  const at = (session, idx, type, n = 1) => eps.push({ type, source: session, session, idx, n });
  for (const session of sessions) {
    const blocksByTurn = new Map();
    for (const ev of session.events) {
      if (ev.type === "block") blocksByTurn.set(session.turnOf[ev.idx], [...(blocksByTurn.get(session.turnOf[ev.idx]) ?? []), ev]);
      if (ev.type === "outside-write") at(session, ev.idx, "outside-write");
    }
    for (const [, blocks] of blocksByTurn) if (blocks.length >= 2) at(session, blocks[0].idx, "re-block", blocks.length);
    const unknown = session.events.filter((e) => e.type === "unknown-name");
    if (unknown.length) at(session, unknown[0].idx, "unknown-name", unknown.length);
    if (session.reviewerAt !== null) eps.push(...reviewerEpisodes(session, period));
  }
  const sessionFor = (row) => sessions.find((s) => owns(s, row));
  const fromRow = (row, type) => { const s = sessionFor(row); if (s) at(s, idxAt(s, row.ts), type); };
  for (const row of log) {
    if (row.kind === "wait" && row.ended === "unknown-name") fromRow(row, "unknown-name");
    if (isMarkerRow(row) && outcomeOf(row) === "not-converged") fromRow(row, "not-converged");
  }
  for (const row of gate) if (/exhausted/.test(row.rule ?? "")) fromRow(row, "exhausted");

  // Cost outliers: main-session tokens per review above 2x the period's p90.
  const reviews = auditedReviews(sessions, period, logDir);
  const p90 = percentile(reviews.map(mainTokens), 0.9);
  for (const one of reviews) {
    if (p90 > 0 && mainTokens(one) > 2 * p90) at(one.session, idxAt(one.session, one.review.endedAt ?? one.review.startedAt), "cost", Math.round(mainTokens(one) / p90));
  }
  // Re-filed findings: a fixed finding the next round filed again.
  for (const [, rows] of records) {
    for (const row of reflagOf(rows)) {
      if (!row.recited) continue;
      const ts = rows.filter((r) => r.round === row.round + 1).map((r) => r.ts).sort()[0];
      if (!inPeriod(period, ts)) continue;
      const session = sessions.find((s) => s.entries.some((e) => e.timestamp && Math.abs(Date.parse(e.timestamp) - Date.parse(ts)) < 5 * 60e3 &&
        /findings\.mjs record/.test(JSON.stringify(e.message?.content ?? ""))));
      if (session) at(session, idxAt(session, ts), "re-filed", row.recited);
    }
  }
  return { eps, reviews };
}

function auditedReviews(sessions, period, logDir) {
  return sessions.flatMap((session) => {
    try {
      return auditSession(session.file, { logDir }).reviews.filter((review) => inPeriod(period, review.startedAt)).map((review) => ({ review, session }));
    } catch { return []; } // a transcript audit.mjs cannot read is not a cost outlier
  });
}
const mainTokens = ({ review }) => (review.tokens?.main?.billedInput ?? 0) + (review.tokens?.main?.output ?? 0);
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

const WEIGHT = { "outside-write": 5, "re-block": 3, exhausted: 3, "not-converged": 3, "unknown-name": 2, cost: 2, "re-filed": 2 };
const OUTSIDE_WRITE_MAX = 2;

/**
 * Episodes merged per turn, then picked: outside-write first (at most 2, inside
 * the cap — a safety class a log never records, found the first time by luck),
 * then the best of each other type, then by score; never more than 2 per session.
 */
export function rank(eps, cap = 8) {
  const merged = new Map();
  for (const ep of eps) {
    const key = `${ep.source.file}#${ep.source.turnOf[ep.idx]}`;
    const score = WEIGHT[ep.type] * (1 + Math.log2(Math.max(1, ep.n)));
    const prev = merged.get(key);
    if (!prev) merged.set(key, { ...ep, score, types: new Set([ep.type]) });
    else { prev.score += score; prev.types.add(ep.type); }
  }
  const pool = [...merged.values()].sort((a, b) => b.score - a.score);
  const picked = [], perSession = new Map();
  const take = (ep) => {
    const file = ep.session.file;
    if (picked.length >= cap || picked.includes(ep) || (perSession.get(file) ?? 0) >= 2) return;
    picked.push(ep);
    perSession.set(file, (perSession.get(file) ?? 0) + 1);
  };
  for (const ep of pool.filter((e) => e.types.has("outside-write")).slice(0, OUTSIDE_WRITE_MAX)) take(ep);
  for (const type of Object.keys(WEIGHT).filter((t) => t !== "outside-write")) {
    const best = pool.find((ep) => ep.types.has(type) && !ep.types.has("outside-write"));
    if (best) take(best);
  }
  for (const ep of pool) if (!ep.types.has("outside-write")) take(ep);
  return { picked, pool };
}

// ---------- windows ----------

function renderEntry(entry, calls) {
  if (isHumanPrompt(entry)) return `USER: ${textOf(entry.message?.content).slice(0, 500)}`;
  if (entry.type === "user") {
    const text = textOf(entry.message?.content);
    if (isGateBlock(text)) return `GATE: ${text.trimStart().slice(0, 1500)}`;
    return (Array.isArray(entry.message?.content) ? entry.message.content : []).filter((b) => b?.type === "tool_result").map((b) => {
      const out = textOf([b]);
      // The plugin's own output is the evidence; a project command's is context.
      const keep = PLUGIN_SCRIPT.test(calls.get(b.tool_use_id)?.input?.command ?? "") ? 800 : 300;
      return `RESULT${b.is_error ? " (error)" : ""}: ${out.length > 2 * keep ? `${out.slice(0, keep)} … ${out.slice(-keep)}` : out}`;
    }).join("\n");
  }
  if (entry.type !== "assistant") return "";
  return (entry.message?.content ?? []).map((b) => {
    if (b.type === "text") return `A: ${b.text.slice(0, 600)}`;
    if (b.type !== "tool_use") return "";
    calls.set(b.id, b);
    return b.name === "Bash" ? `$ ${(b.input?.command ?? "").slice(0, 400)}` : `[${b.name}] ${JSON.stringify(b.input).slice(0, 200)}`;
  }).filter(Boolean).join("\n");
}

/** The anchor's whole turn, rendered, and centred on the anchor when it is longer than `chars`. */
export function windowOf(ep, chars) {
  const { entries, turnOf } = ep.source;
  const turn = turnOf[ep.idx];
  let from = ep.idx, to = ep.idx;
  while (from > 0 && turnOf[from - 1] === turn) from--;
  while (to < entries.length - 1 && turnOf[to + 1] === turn) to++;
  const calls = new Map();
  const parts = [];
  entries.forEach((entry, i) => { const text = renderEntry(entry, calls); if (i >= from && i <= to && text) parts.push({ i, text }); });
  let text = parts.map((p) => p.text).join("\n");
  if (text.length > chars) {
    const before = parts.filter((p) => p.i < ep.idx).map((p) => p.text).join("\n").length;
    const start = Math.max(0, Math.min(before - chars / 2, text.length - chars));
    text = text.slice(start, start + chars);
  }
  return text;
}

// ---------- signals ----------

const tally = (values) => values.reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});
// The allowlist. A value is printed only if it is in a closed vocabulary, or —
// for versions and model ids, which no list can hold — has their exact shape;
// everything else is `other`. Shape alone is not enough for a word: a project
// called `clean-movie` has the shape of a wait state. That is what makes the
// table safe to paste unread. The lists copy the writers' literals, and a test
// holds them to the gate's and findings.mjs's source; a list that falls behind
// fails closed, into `other`.
export const GATE_RULES = [
  "block:branch-held", "block:main-held", "block:no-reviewer", "block:no-verifier", "block:rejected", "block:remark", "block:unmarked", "block:unvalidated",
  "pass:empty", "pass:interrupted", "pass:marker", "pass:no-change", "pass:no-transcript",
  "release:branch-deferred", "release:editor-running", "release:held-exhausted", "release:pending", "release:reminders-exhausted", "release:reviewer-running",
  "release:unreviewed-exhausted", "release:unvalidated-exhausted", "release:unverified-exhausted", "release:verifier-running",
];
export const CONVERGE_VERDICTS = ["CLEAN", "CONTINUE", "ESCALATE", "STOP", "UNRECORDED"];
export const WAIT_ENDED = ["settled", "unknown-name", "budget-spent"];
const VERSION = /^\d+\.\d+\.\d+$/;
const ANGLE_WORD = /^(?:compact|mixed|merged)$/i;
// The angles references/angles.md defines; a wider class would let any
// all-letter word through as a run of single-letter angles.
const ANGLE_CODE = /P[1-4]|K[1-2]|[A-HQSVX]/g;
/**
 * The angle names one finding's label stands for. Labels are hand-written and
 * the logs hold every spelling of a group: `A+B`, `AB`, `qv`, `p2v`, `K2K1`.
 * A part counts only when the angle codes cover all of it; anything else is a
 * single `other`, so free text never reaches the table.
 */
export function angleTokens(label) {
  if (typeof label !== "string") return ["other"];
  return label.split("+").flatMap((part) => {
    if (ANGLE_WORD.test(part)) return [part.toLowerCase()];
    const upper = part.toUpperCase();
    const codes = upper.match(ANGLE_CODE);
    return codes && codes.join("") === upper ? codes : ["other"];
  });
}
const MODEL = /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:[-.]\d+)*$/;
const only = (value, allowed) => (typeof value === "string" && (allowed instanceof RegExp ? allowed.test(value) : allowed.includes(value)) ? value : "other");

export function signals({ sessions, log, gate, records, reviews, period }) {
  const markers = log.filter(isMarkerRow).map((row) => {
    const parsed = parseSummary(row.summary ?? "");
    const outcome = outcomeOf(row);
    const vocab = reasonsFor(outcome);
    // Rows from before a reason existed are their own bucket, never folded into a real reason.
    const recorded = row.reason ?? parsed.reason;
    const reason = vocab ? (recorded === undefined || recorded === null ? "unrecorded" : only(recorded, vocab)) : null;
    return { outcome: only(outcome, OUTCOMES), reason, rounds: row.rounds ?? parsed.rounds, forced: row.forced ?? parsed.forced ?? null };
  });
  const counted = markers.filter((m) => m.outcome !== "not-applicable" && Number.isInteger(m.rounds));
  const waits = log.filter((r) => r.kind === "wait");
  const tiers = log.filter((r) => r.kind === "tier");
  const findings = records.flatMap(([, rows]) => rows.filter((r) => inPeriod(period, r.ts)));
  const refiled = records.flatMap(([, rows]) => reflagOf(rows));
  const byAngle = {};
  for (const f of findings) {
    for (const angle of angleTokens(f.angle)) {
      byAngle[angle] ??= { dismissed: 0, total: 0 };
      byAngle[angle].total++;
      if (f.verdict === "dismissed") byAngle[angle].dismissed++;
    }
  }
  const versionsOf = (entries) => entries.map((e) => e.version).filter(Boolean);
  const modelsOf = (entries) => entries.map((e) => e.message?.model).filter((m) => typeof m === "string" && m.startsWith("claude-"));
  const reBlockTurns = sessions.reduce((n, s) => n + Object.values(tally(s.events.filter((e) => e.type === "block").map((e) => s.turnOf[e.idx]))).filter((c) => c >= 2).length, 0);
  const waited = waits.map((r) => r.waitedMs).filter(Number.isFinite);
  const turns = reviews.map(({ review }) => review.turns);
  return {
    period: { days: period.days, since: period.since.slice(0, 10), basis: period.basis, retentionDays: period.retentionDays, missingBefore: period.missingBefore ?? "none" },
    environment: {
      os: only(process.platform, ["darwin", "linux", "win32"]),
      pluginVersions: tally(gate.map((r) => only(r.version, VERSION))),
      // A range, not a tally: Claude Code ships daily, and one line per build
      // buries the table. Sessions are counted under the model they used most.
      claudeCode: versionRange(sessions.map((s) => versionsOf(s.entries).at(-1)).filter((v) => VERSION.test(v ?? ""))),
      mainModels: tally(sessions.map((s) => mostOf(modelsOf(s.entries))).filter(Boolean).map((m) => only(m, MODEL))),
    },
    sessions: sessions.length,
    activeDays: new Set(sessions.flatMap((s) => s.entries.map((e) => e.timestamp?.slice(0, 10)).filter(Boolean))).size,
    gate: {
      rules: tally(gate.map((r) => only(r.rule, GATE_RULES))),
      reBlockTurns,
      gaveUp: gate.filter((r) => /exhausted/.test(r.rule ?? "")).length,
    },
    outcomes: tally(markers.map((m) => m.outcome)),
    notConvergedReasons: tally(markers.filter((m) => m.outcome === "not-converged").map((m) => m.reason)),
    notApplicableReasons: tally(markers.filter((m) => m.outcome === "not-applicable").map((m) => m.reason)),
    rounds: tally(counted.map((m) => (m.rounds >= 6 ? "6+" : String(m.rounds)))),
    converge: tally(log.filter((r) => r.kind === "converge").map((r) => only(r.verdict, CONVERGE_VERDICTS))),
    tier: { rows: tiers.length, overridden: tiers.filter((r) => r.override).length, forcedMarkers: markers.filter((m) => m.forced).length },
    wait: { ended: tally(waits.map((r) => only(r.ended, WAIT_ENDED))), p50s: Math.round(percentile(waited, 0.5) / 1000), p95s: Math.round(percentile(waited, 0.95) / 1000) },
    refiled: { roundsChecked: refiled.length, fixed: refiled.reduce((n, r) => n + r.fixed, 0), refiled: refiled.reduce((n, r) => n + r.recited, 0) },
    dismissedByAngle: Object.fromEntries(Object.entries(byAngle).sort().map(([a, v]) => [a, `${v.dismissed}/${v.total}`])),
    reviews: {
      audited: reviews.length,
      mainTokensP50: percentile(reviews.map(mainTokens), 0.5), mainTokensP90: percentile(reviews.map(mainTokens), 0.9),
      turnsP50: percentile(turns, 0.5), turnsP90: percentile(turns, 0.9),
      costOutliers: reviews.filter((r) => mainTokens(r) > 2 * percentile(reviews.map(mainTokens), 0.9)).length,
    },
  };
}

const mostOf = (values) => Object.entries(tally(values)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
function versionRange(versions) {
  const key = (v) => v.split(/[.-]/).slice(0, 3).map((n) => n.padStart(6, "0")).join(".");
  const sorted = [...new Set(versions)].sort((a, b) => key(a).localeCompare(key(b)));
  return sorted.length ? `${sorted[0]} .. ${sorted.at(-1)}` : "none";
}

/** The table as the report carries it: one `key value` line per fact, the format versioned. */
export function formatSignals(table) {
  const lines = ["self-review retro signals v1"];
  const walk = (prefix, value) => {
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (!keys.length) lines.push(`${prefix} none`);
      for (const key of keys) walk(prefix ? `${prefix}.${key}` : key, value[key]);
    } else lines.push(`${prefix} ${value}`);
  };
  walk("", table);
  return lines.join("\n");
}

// ---------- check ----------

const ABSOLUTE = /(?<![\w.~/-])((?:~|\$HOME|\$\{HOME\})\/[^\s`'")\]>]*|file:\/\/\/?[^\s`'")\]>*]+|\/(?:[\w.@+-]+\/)+[\w.@+-]*|[A-Za-z]:[\\/][^\s`'")\]>*]+)/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*\b/g;
// Prefix-greedy on purpose: a false alarm here costs one rewritten line of a
// local draft, and a miss is a published credential.
const TOKEN = /(?<![A-Za-z0-9_-])(?:sk-ant-|sk-|[sp]k_(?:live|test)_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abeoprs]-|xapp-|AKIA|AIza|glpat-|npm_)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SECRET_ASSIGN = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}|[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[=:]\s*["']?[^\s"']{8,}/gi;
const URL_SHAPE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s`'")\]>]+/g;
// The plugin's own repo and Claude Code's, where a report may cite an issue.
const URL_ALLOWED = /^https:\/\/github\.com\/(?:HoussemDjeghri\/self-review|anthropics\/claude-code)(?:[/?#]|$)/;
// The plugin's own paths are vocabulary: every user has them, at the same place.
const OWN_PATH = /^(?:~|\$HOME|\$\{HOME\})\/\.claude\/(?:self-review(?:\/.*)?|settings\.json)$/;
const FENCE = /^\s*(```|~~~)/;
const PLUGIN_PATH = /(?<![\w./-])plugin\/[\w./-]*[\w-]/g;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every directory the user's own logs say they worked in. */
export function userCwds({ projects = DEFAULTS.projects, logDir = DEFAULTS.logDir } = {}) {
  const cwds = new Set();
  for (const row of readJsonl(path.join(logDir, "log.jsonl"))) if (typeof row.cwd === "string") cwds.add(row.cwd);
  const gateDir = path.join(logDir, "gate");
  if (existsSync(gateDir)) for (const f of readdirSync(gateDir)) for (const row of readJsonl(path.join(gateDir, f))) if (typeof row.cwd === "string") cwds.add(row.cwd);
  for (const file of sessionFiles(projects)) {
    // The cwd is on every entry, so the head of the file holds every one a
    // session used short of a mid-session `cd` into another project.
    let head = "";
    try { head = readFileSync(file, "utf8").slice(0, 256 * 1024); } catch { continue; }
    for (const m of head.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) { try { cwds.add(JSON.parse(`"${m[1]}"`)); } catch { /* torn escape */ } }
  }
  return [...cwds].filter((c) => c && !isTempCwd(c));
}

/**
 * The names the lint watches for: each cwd whole, and each cwd's basename
 * longer than 3 characters that is not also a name in the plugin's own tree —
 * `scripts` or `hooks` are how a report says where the plugin went wrong, and
 * refusing them would make the lint unusable.
 */
export function watchedNames(cwds, { pluginRoot = PLUGIN_ROOT, home = HOME } = {}) {
  const own = new Set(["plugin", path.basename(pluginRoot).toLowerCase()]);
  for (const file of walkFiles(pluginRoot)) for (const part of file.split("/")) { own.add(part.toLowerCase()); own.add(part.replace(/\.[^.]+$/, "").toLowerCase()); }
  const names = new Set();
  for (const cwd of cwds) {
    const base = path.basename(cwd);
    // A session run inside Claude Code's own directory (a plugin cache's `0.10.0`,
    // a `memory` folder) names the harness, not a project, and a version is
    // what the report header is required to state.
    if (under(cwd, path.join(home, ".claude")) || /^\d+(?:\.\d+)+$/.test(base)) continue;
    if (base.length > 3 && !own.has(base.toLowerCase())) names.add(base);
  }
  // The name Claude Code gives the cwd's folder under ~/.claude/projects.
  const encoded = cwds.filter((cwd) => cwd.split("/").filter(Boolean).length >= 2).map((cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-"));
  return { paths: [...cwds, ...encoded], names: [...names] };
}

/** The draft's problems, one per offending line and clause, in line order. */
export function lint(text, { paths = [], names = [], pluginRoot = PLUGIN_ROOT, signals = null } = {}) {
  const problems = [];
  const lines = text.split("\n");
  const nameRe = names.length
    ? new RegExp(`(?<![A-Za-z0-9])(${names.map((name) => name.split(/[-_ ]+/).map(escape).join("[-_ ]+")).join("|")})(?![A-Za-z0-9])`, "gi")
    : null;
  let section = "";
  let inFence = false, inSignals = false, signalsAt = 0;
  const body = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const flag = (clause, what) => problems.push({ line: n, clause, what });
    if (!inFence && /^##\s/.test(line)) section = line.replace(/^##\s+/, "").trim().toLowerCase();
    if (FENCE.test(line)) {
      // Only the signals table travels as a block, once, as `text`; a fence
      // anywhere else is how code gets pasted into a report about the plugin.
      if (inSignals) { inSignals = false; inFence = false; }
      else if (!inFence && section === "signals" && !signalsAt && /^\s*(?:```|~~~)\s*text\s*$/.test(line)) { inSignals = true; inFence = true; signalsAt = n; }
      else { flag("code fence outside the signals block", line.trim().slice(0, 3)); inFence = !inFence; }
    } else if (inSignals) body.push(line);
    for (const m of line.matchAll(ABSOLUTE)) {
      const whole = m[1];
      if (!OWN_PATH.test(whole) || /(?:^|\/)\.\.(?:\/|$)/.test(whole)) flag("absolute path", m[1]);
    }
    // The block is compared to signals.txt, which `signals` builds from closed vocabularies.
    const savedTable = inSignals && typeof signals === "string";
    if (!savedTable) for (const p of paths) if (p.length > 1 && line.toLowerCase().includes(p.toLowerCase())) flag("a directory from your logs", p);
    if (nameRe && !savedTable) for (const m of line.matchAll(nameRe)) flag("a project name from your logs", m[1]);
    for (const m of line.matchAll(UUID)) flag("session id", m[0]);
    for (const m of line.matchAll(EMAIL)) flag("email address", m[0]);
    for (const m of line.matchAll(TOKEN)) flag("token shape", `${m[0].slice(0, 4)}…`);
    for (const m of line.matchAll(SECRET_ASSIGN)) flag("token shape", `${m[0].slice(0, 4)}…`);
    for (const m of line.matchAll(URL_SHAPE)) if (!/^file:/i.test(m[0]) && !URL_ALLOWED.test(m[0])) flag("url", m[0]);
    for (const m of line.matchAll(PLUGIN_PATH)) {
      const rel = m[0].slice("plugin/".length).replace(/[.:]+$/, "");
      // `..` could climb out of the plugin root to a path that exists there, so it never counts as one.
      if (/(?:^|\/)\.\.(?:\/|$)/.test(rel) || !existsSync(path.join(pluginRoot, rel))) flag("plugin path that does not exist", m[0]);
    }
    if (/^\s*[-*]?\s*\**Mechanism\**:/.test(line) && !line.match(PLUGIN_PATH)) flag("Mechanism names no plugin/ path", "Mechanism");
  });
  if (typeof signals === "string" && !signalsAt) problems.push({ line: 1, clause: "no Signals block", what: "Signals" });
  if (typeof signals === "string" && signalsAt && body.join("\n").trimEnd() !== signals.trimEnd()) {
    problems.push({ line: signalsAt, clause: "signals block differs from signals.txt", what: "Signals" });
  }
  return problems.sort((a, b) => a.line - b.line);
}

// ---------- CLI ----------

const USAGE = `usage: retro.mjs signals  [days] [--json] [--save]
       retro.mjs episodes [days] [--cap 8] [--tokens 15000]
       retro.mjs check <YYYY-MM-DD>.md`;

const VALUE_OPTIONS = ["cap", "tokens"];
const FLAGS = ["json", "save"];

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (FLAGS.includes(name)) opts[name] = true;
    else if (VALUE_OPTIONS.includes(name)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      opts[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(`${error.message}\n${USAGE}`); return 2; }
  const [mode, arg] = opts.positional;
  const projects = DEFAULTS.projects;
  const logDir = DEFAULTS.logDir;
  const retroDir = process.env.SELF_REVIEW_RETRO_DIR || path.join(logDir, "retro");
  if (mode === "check") {
    if (!arg) { console.error(USAGE); return 2; }
    if (!/^[\w.-]+\.md$/.test(arg) || /^\.+$/.test(arg.slice(0, -".md".length))) {
      console.error(`check reads drafts from ${retroDir}; pass the file name (e.g. 2026-10-23.md), got "${arg}"`);
      return 2;
    }
    const draft = path.join(retroDir, arg);
    let text;
    try { text = readFileSync(draft, "utf8"); } catch (error) { console.error(`retro: cannot read ${draft}: ${error.message}`); return 2; }
    const saved = path.join(retroDir, "signals.txt");
    const signalsText = existsSync(saved) ? readFileSync(saved, "utf8") : null;
    const problems = lint(text, { ...watchedNames(userCwds({ projects, logDir })), signals: signalsText });
    if (signalsText === null) problems.unshift({ line: 0, clause: "no saved signals table", what: "run signals --save first" });
    for (const p of problems) console.log(`line ${p.line}: ${p.clause}: ${p.what}`);
    console.log(problems.length ? `${problems.length} problem(s): rewrite those lines in plugin vocabulary, then run check again.` : "clean");
    return problems.length ? 1 : 0;
  }
  if (mode !== "signals" && mode !== "episodes") { console.error(USAGE); return 2; }
  if (arg !== undefined && !/^[1-9]\d*$/.test(arg)) { console.error(`days must be a positive integer, got "${arg}"\n${USAGE}`); return 2; }
  if (arg !== undefined && Number(arg) > 36500) { console.error(`days must be at most 36500, got "${arg}"\n${USAGE}`); return 2; }
  for (const name of ["cap", "tokens"]) {
    if (opts[name] !== undefined && !/^[1-9]\d*$/.test(opts[name])) { console.error(`--${name} must be a positive integer, got "${opts[name]}"\n${USAGE}`); return 2; }
  }
  const period = periodOf({ days: arg === undefined ? null : Number(arg), settings: DEFAULTS.settings, retroDir, projects });
  const sessions = readSessions(projects, period);
  const logs = readLogs(logDir, period);
  const { eps, reviews } = findEpisodes(sessions, logs, period, { logDir });
  if (mode === "signals") {
    const table = signals({ sessions, ...logs, reviews, period });
    console.log(opts.json ? JSON.stringify(table, null, 2) : formatSignals(table));
    if (opts.save) {
      mkdirSync(retroDir, { recursive: true });
      writeFileSync(path.join(retroDir, "signals.txt"), `${formatSignals(table)}\n`);
    }
    return 0;
  }
  const cap = Number(opts.cap ?? 8), chars = Number(opts.tokens ?? 15000) * 4;
  const out = mkdtempSync(path.join(tmpdir(), "self-review-retro-"));
  const { picked, pool } = rank(eps, cap);
  console.log(`period ${period.since.slice(0, 10)} .. ${period.until.slice(0, 10)} (${period.days} days, ${period.basis}); ${sessions.length} sessions; ${pool.length} candidate episodes; reading ${picked.length}`);
  if (period.missingBefore) console.log(`transcripts before ${period.missingBefore} no longer exist; the report header must say so`);
  picked.forEach((ep, i) => {
    const text = windowOf(ep, chars);
    const file = path.join(out, `episode-${i + 1}.txt`);
    const types = [...ep.types].join("+");
    const when = ep.source.entries[ep.idx]?.timestamp ?? "";
    writeFileSync(file, `# episode ${i + 1}: ${types} at ${when}${ep.source.reviewer ? " (a reviewer's own transcript)" : ""}\n${text}\n`);
    console.log(`${i + 1}\t${types}\t${when.slice(0, 16)}\t~${Math.round(text.length / 4)} tok\t${file}`);
  });
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
