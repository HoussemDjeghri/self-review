#!/usr/bin/env node
// self-review tier — the deterministic tier and angle plan for a round.
//
// Usage:
//   tier.mjs --scope round-N/scope.diff --out round-N/ [--impact round-N/impact.json]
//            [--round N] [--force S|M|L --reason "…"] [--compact] [--cap S|M|L]
//
// What the model used to do by reading SKILL.md §0's table is done here so it
// is logged, tested and tuned from evals instead of from taste: classify the
// changed paths, count their lines, fire the risk markers, apply the first
// rule that matches, and emit the round's finder rows. Writes `tier.json` and
// prints at most eight lines — the tier with its reasons, one line per finder,
// and the footer brief.mjs needs.
//
// What stays the model's (DESIGN §4.5): *raising* the tier when it reads a
// contract change that line counts cannot see; the INTENT block; where to
// split a scope this script only flags as too big; the verifier trigger and
// the convergence calls. Overriding the verdict in either direction needs
// `--force X --reason "…"`, which is written into tier.json and the marker
// alongside the tier the rules computed — so a habit of forcing *down* is a
// number, not a feeling.
//
// Exit 0; 2 usage (a `--force` without `--reason` is a usage error); 3 the
// scope is unreadable.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMain, loadConfig } from "../hooks/lib/config.mjs";
import { parseDiff, changedLineCounts } from "./lib/diff.mjs";
import { classifyPath, isTestPath, matchesAnyGlob } from "./lib/paths.mjs";
import { parseScope } from "./impact.mjs";

const SCHEMA = 1;

// --- step 1: kinds ---------------------------------------------------------
export function classifyChanged(files, config, exempt, root = null) {
  const kinds = { code: [], docs: [], config: [], instructional: [], asset: [], ignored: [] };
  for (const { path: file } of files) {
    if (matchesAnyGlob(config.ignore, file)) { kinds.ignored.push(file); continue; }
    const kind = classifyPath(file, exempt);
    kinds[kind].push(file);
    // Instructions for a model or an operator are docs that are executed by a
    // reader: that is angle P4, and it is the reason this list exists.
    if (kind === "docs" && matchesAnyGlob(config.instructional, file)) kinds.instructional.push(file);
  }
  kinds.executable = executableSurface(kinds, config, root);
  return kinds;
}

/**
 * The changed files a user actually runs — the surface angle X executes.
 *
 * Asked of the file, not guessed from its directory: a shebang or the execute
 * bit is the file declaring itself an entry point, which `scripts/**` cannot
 * distinguish from the library next to it. `scripts/lib/wire.mjs` and
 * `scripts/impact.mjs` live one directory apart and only one of them is a
 * thing anyone invokes. The glob list covers what carries no shebang of its
 * own — a Makefile, a Dockerfile, a manifest whose `bin` or `files` field is
 * exactly where "ships nothing" hides.
 *
 * Reading the working tree is deliberate and is not the banned second look at
 * the change: the question is a property of the file that will ship, not what
 * the diff did to it. Unreadable fails closed to "not an entry point" — a
 * missed finder, never a crashed plan.
 */
function executableSurface(kinds, config, root) {
  const candidates = [...kinds.code, ...kinds.config];
  return candidates.filter((file) => shipped(file, config) && (matchesAnyGlob(config.executable, file) || declaresItselfRunnable(file, root)));
}

/**
 * A fixture is not the product. This repository's own eval corpora hold a
 * `bin/publish.sh` with a real shebang and execute bit, a `Dockerfile` and a
 * `package.json` — and a bare glob like `Dockerfile` matches by basename at
 * any depth, so editing any of them planned a Cold-run finder to go install
 * and run a wire-break test fixture as if it were the plugin. Angle X asks
 * what a user runs, and nobody installs a corpus.
 */
export const shipped = (file, config) => !isTestPath(file) && !matchesAnyGlob(config.executableExclude, file);

// Exported because `coldrun.sh` asks the same question about the same files.
// It used to ask it in bash, as `[ -x "$file" ]`, and the two answers could
// differ: `[ -x ]` asks whether THIS uid may execute the file (so a 0711 file
// owned by someone else is invisible on an ownership-skewed checkout, and the
// entry point tier.mjs planned a Cold-run finder against is silently missing
// from the transcript it grades), and `[ -x ]` follows a symlink out of the
// tree where this refuses. One predicate, one implementation.
export function declaresItselfRunnable(file, root) {
  if (!root) return false;
  const full = path.join(root, file);
  try {
    // lstat, not stat: a symlink's target is not the thing that ships, and
    // following one asks the question of a file that may sit outside the tree
    // entirely. Fails closed, like every other branch here.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    if (stat.mode & 0o111) return true;
    const head = Buffer.alloc(2);
    const fd = openSync(full, "r");
    try { readSync(fd, head, 0, 2, 0); } finally { closeSync(fd); }
    return head.toString("latin1") === "#!";
  } catch {
    return false;   // deleted, unreadable, or outside the tree
  }
}

// --- step 3: risk markers --------------------------------------------------
// Everything is matched case-insensitively, paths and content alike.
//
// Case was tried as a discriminator in 0.3.0 and reverted the same day (DESIGN
// §7.6). The prose false positive is real — a comment reading "truncate the
// summary" or "we drop the field" fires the destructive marker, and this file's
// own `scopeTruncated` line is one of them — but case does not separate the two
// populations. Real code writes `db.raw("drop table sessions")` and
// `db.execute("truncate table logs")` lowercase, and security tokens are
// camelCase identifiers (`clientSecret`, `userPassword`) as often as they are
// ALL_CAPS env vars. Matching literally missed all of those, and
// `markers.security` / `markers.concurrency` are the only thing that spawns the
// angle-G and angle-H finders. A miss costs a reviewer; a false positive costs
// a tier bump (§0: err toward reviewing more), so the bump is the accepted cost.
const anyOf = (patterns) => new RegExp(patterns.join("|"), "i");
const EVIDENCE_PER_MARKER = 3;

/**
 * Each marker with the path or line that fired it, so `reasons` can quote it.
 * Path markers match the repo-relative path; content markers match only added
 * lines, and only in code and config files — a README that documents `rm -rf`
 * is not a destructive change.
 */
export function riskMarkers({ files, diff, kinds, config, broken, wire = [] }) {
  const markers = { auth: [], payments: [], migration: [], infra: [], destructive: [], security: [], concurrency: [], contractBreak: [], wireBreak: [] };
  for (const [name, patterns] of Object.entries(config.riskPaths)) {
    if (!patterns.length) continue;
    const pattern = anyOf(patterns);
    for (const { path: file } of files) {
      if (kinds.ignored.includes(file)) continue;
      const hit = file.match(pattern);
      if (hit && markers[name].length < EVIDENCE_PER_MARKER) markers[name].push(`${file} (${hit[0]})`);
    }
  }
  // Content markers are read out of code and config files only: a doc quoting
  // `rm -rf` is describing it, not running it. Config counts because
  // `Dockerfile`, `docker-compose.yml` and `.github/workflows/*` are where
  // destructive commands actually live.
  const scanned = new Set([...kinds.code, ...kinds.config]);
  for (const [name, patterns] of Object.entries(config.riskContent)) {
    if (!patterns.length) continue;
    const pattern = anyOf(patterns);
    for (const { file, hunks } of diff) {
      if (!scanned.has(file)) continue;
      for (const hunk of hunks) {
        for (const { sign, text, line } of hunk.lines) {
          if (sign !== "+") continue;
          const hit = text.match(pattern);
          if (hit && markers[name].length < EVIDENCE_PER_MARKER) markers[name].push(`${file}:${line} ${hit[0].trim()}`);
        }
      }
    }
  }
  if (broken > 0) markers.contractBreak.push(`${broken} remaining reference${broken === 1 ? "" : "s"} to a removed or renamed symbol`);
  // Kept separate from contractBreak on purpose: they are different evidence
  // (a symbol reference vs a string over a wire), the reason line has to quote
  // different things, and folding them would make every eval baseline that
  // counts contractBreak silently mean something else.
  for (const row of wire.slice(0, EVIDENCE_PER_MARKER)) markers.wireBreak.push(row);
  return markers;
}

// --- step 2 + 4: metrics and the tier --------------------------------------
const NEW = new Set(["A", "?"]);

export function measure({ scope, files, diff, kinds, impact }) {
  const perFile = changedLineCounts(diff);
  const lines = { code: 0, docs: 0, config: 0 };
  for (const [file, count] of perFile) {
    const kind = kinds.code.includes(file) ? "code" : kinds.docs.includes(file) ? "docs" : kinds.config.includes(file) ? "config" : null;
    if (kind) lines[kind] += count;
  }
  const counted = files.filter(({ path: file }) => !kinds.ignored.includes(file) && !kinds.asset.includes(file));
  return {
    lines,
    files: counted.length,
    newFiles: counted.filter(({ status }) => NEW.has(status)).length,
    deletedFiles: files.filter(({ status }) => status === "D").length,
    callerFiles: impact?.counts?.caller_files ?? null,
    broken: impact?.counts?.broken ?? 0,
    untested: impact?.untested ?? [],
    projectHasTests: impact?.project_has_tests ?? false,
    scopeTruncated: scope.truncated,
    graphRisk: impact?.graph?.risk_score ?? null,
  };
}

const PLURAL = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The first rule that matches wins (DESIGN §4.5 step 4). */
// The markers that make a change L on their own. Exported because the round-2+
// ceiling has to ask whether a marker is NEW this round, and a second copy of
// this list would let the two answers drift.
export const ESCALATING = ["auth", "payments", "migration", "destructive", "infra", "contractBreak", "wireBreak"];

/** Every marker riskMarkers() can fire, escalating or not. */
export const MARKER_NAMES = [...ESCALATING, "security", "concurrency"];

export function pickTier({ metrics, markers, kinds, config, hasImpact }) {
  const reasons = [];
  const fired = Object.entries(markers).filter(([, evidence]) => evidence.length);
  const quote = (name) => `${name}: ${markers[name][0]}`;
  const escalating = ESCALATING.filter((name) => markers[name].length);

  const large = [];
  if (metrics.scopeTruncated) large.push("the scope is truncated — too big for one review");
  if (metrics.lines.code > config.l.minLines) large.push(`${PLURAL(metrics.lines.code, "changed code line")} (> ${config.l.minLines})`);
  if (metrics.files > config.l.minFiles) large.push(`${PLURAL(metrics.files, "changed file")} (> ${config.l.minFiles})`);
  for (const name of escalating) large.push(quote(name));
  if (metrics.callerFiles !== null && metrics.callerFiles >= config.l.minCallerFiles) large.push(`${PLURAL(metrics.callerFiles, "caller file")} (≥ ${config.l.minCallerFiles})`);
  if (metrics.graphRisk !== null && metrics.graphRisk >= config.l.graphRisk) large.push(`graph risk ${metrics.graphRisk} (≥ ${config.l.graphRisk})`);
  if (large.length) return { tier: "L", reasons: large, split: metrics.scopeTruncated };

  const single = metrics.files === 1;
  const budget = kinds.code.length ? config.s.maxLines : config.s.docsMaxLines;
  const size = metrics.lines.code + metrics.lines.docs + metrics.lines.config;
  const trivial = single && size <= budget && fired.length === 0 && metrics.newFiles === 0 && metrics.callerFiles === 0;
  if (trivial) {
    return { tier: "S", reasons: [`one file, ${PLURAL(size, "changed line")} (≤ ${budget}), no risk marker, nothing references it`], split: false };
  }

  reasons.push(`${PLURAL(metrics.files, "changed file")}, ${metrics.lines.code} code / ${metrics.lines.docs} docs / ${metrics.lines.config} config lines`);
  for (const [name] of fired) reasons.push(quote(name));
  // The S rule's last clause cannot be checked without impact, so a change
  // that would have been S stays M rather than quietly skipping reviewers.
  if (!hasImpact) reasons.push("no impact.json: the cross-file rules were skipped");
  else if (metrics.untested.length) reasons.push(`untested: ${metrics.untested.slice(0, 3).join(", ")}`);
  // New code with no test in a project that has tests is new untested surface.
  const untestedNewFile = newUntestedSurface({ metrics, kinds });
  if (untestedNewFile) return { tier: "L", reasons: [...reasons, `new untested file: ${untestedNewFile}`], split: false };
  return { tier: "M", reasons, split: false };
}

function newUntestedSurface({ metrics, kinds }) {
  if (!metrics.projectHasTests || !metrics.newCodeFiles) return null;
  return metrics.newCodeFiles.find((file) => !isTestPath(file) && metrics.untestedFiles.includes(file)) ?? null;
}

// --- step 5: the plan ------------------------------------------------------
const COMPACT = { group: "compact", angles: ["compact"], kind: "code" };
// Round 3 means two rounds of fixes did not settle it, and a third defect in
// the same place is evidence about the design, not about the lines. From here
// one reviewer stops hunting defects and asks whether the shape is right —
// with the standing to answer "delete it", which no defect angle can.
const SHAPE = { group: "shape", angles: ["S"], kind: "code" };
// Spreading a row copies the reference to its `angles` array, so a later
// `.push` onto the copy edits the module constant for every call after it in
// the process. The round-2 branch cloned defensively because that is where the
// push was added; the other three spread sites had the same hazard sitting
// unfixed. One helper, used everywhere a constant row becomes a plan row.
const cloneRow = (row, over = {}) => ({ ...row, angles: [...row.angles], ...over });

// SKILL.md §2a's groups, as constants: a user tunes thresholds and keyword
// lists, not the catalogue's grouping.
// Whose angles a single-finder round takes: a change is reviewed as what it
// mostly is, and tier S has one file to begin with.
const dominantKind = (kinds) => (kinds.code.length ? "code" : kinds.docs.length ? "docs" : "config");

const groupsFor = (tier, kinds, markers) => {
  // Tier S is one reviewer with the compact brief — the whole point of the
  // tier is that a one-word fix costs one agent, not four.
  if (tier === "S") return [cloneRow(COMPACT, { kind: dominantKind(kinds) })];
  const code = [], docs = [], config = [];
  if (kinds.code.length) {
    if (tier === "L") {
      code.push({ group: "A+B", angles: ["A", "B"] }, { group: "C+D", angles: ["C", "D"] }, { group: "E+F", angles: ["E", "F"] }, { group: "Q+V", angles: ["Q", "V"] });
      if (kinds.executable.length) code.push({ group: "X", angles: ["X"] });
      if (markers.security.length || markers.auth.length) code.push({ group: "G", angles: ["G"], model: "opus" });
      if (markers.concurrency.length) code.push({ group: "H", angles: ["H"], model: "opus" });
    } else {
      code.push({ group: "A+B+D", angles: ["A", "B", "D"] });
      const verify = ["C", "E", "F"];
      if (markers.concurrency.length) verify.push("H");
      code.push({ group: verify.join("+"), angles: verify });
      if (kinds.executable.length) code.push({ group: "X", angles: ["X"] });
      code.push({ group: "Q+V", angles: ["Q", "V"] });
      if (markers.security.length || markers.auth.length) code.push({ group: "G", angles: ["G"] });
    }
  }
  if (kinds.docs.length) {
    if (tier === "L") {
      docs.push({ group: "P1", angles: ["P1"] }, { group: "P2+V", angles: ["P2", "V"] }, { group: "P3", angles: ["P3"] });
      if (kinds.instructional.length) docs.push({ group: "P4", angles: ["P4"] });
    } else {
      docs.push({ group: "P1+P3", angles: ["P1", "P3"] });
      docs.push({ group: "P2+V", angles: kinds.instructional.length ? ["P2", "V", "P4"] : ["P2", "V"] });
    }
  }
  if (kinds.config.length) {
    if (tier === "L") config.push({ group: "K1", angles: ["K1"] }, { group: "K2", angles: ["K2"] });
    else config.push({ group: "K1+K2", angles: ["K1", "K2"] });
  }
  return [...code.map((row) => ({ ...row, kind: "code" })), ...docs.map((row) => ({ ...row, kind: "docs" })), ...config.map((row) => ({ ...row, kind: "config" }))];
};

// Applied in order until the round fits its cap. Merges never cross kinds — a
// finder reviews one kind — and no kind is ever dropped.
const MERGE_ORDER = {
  M: [["G", "Q+V"], ["P2+V", "P1+P3"], ["H", "C+E+F"], ["Q+V", "A+B+D"]],
  L: [["P4", "P2+V"], ["P3", "P1"], ["K2", "K1"], ["H", "C+D"], ["G", "Q+V"], ["E+F", "C+D"], ["P2+V", "P1"], ["Q+V", "A+B"]],
};

export function mergeToFit(rows, tier, cap) {
  const merged = [];
  const kept = [...rows];
  for (const [from, into] of MERGE_ORDER[tier] ?? []) {
    if (kept.length <= cap) break;
    const source = kept.findIndex((row) => row.group === from);
    const target = kept.findIndex((row) => row.group === into);
    if (source === -1 || target === -1 || kept[source].kind !== kept[target].kind) continue;
    // The absorbed angles lead: the merged finder is named for what it gained.
    kept[target] = { ...kept[target], angles: [...kept[source].angles, ...kept[target].angles] };
    kept.splice(source, 1);
    merged.push([from, "into", into]);
  }
  return { rows: kept, merged };
}

/**
 * X on its own, which is the only shape it is ever planned in — because its
 * reviewer has no shell and cannot share a row with an angle that needs one.
 */
const isColdGrader = (row) => row.angles.length === 1 && row.angles[0] === "X";

const ROUND_2 = [
  { group: "A+B+D+Q+V", angles: ["A", "B", "D", "Q", "V"], kind: "code" },
  { group: "C+E+F+G+H", angles: ["C", "E", "F", "G", "H"], kind: "code" },
];

/** Later rounds are narrower on purpose: round 2 is at most two finders, round 3+ is one. */
export function laterRound(round, kinds, compact) {
  // Compact is checked FIRST. It used to come second, so a tier-S review that
  // reached round 3 spent two finders — the compact one and a whole extra
  // agent for shape — which is the escalation this whole change exists to
  // stop, and it falsified the rule outright. Two reviewers found it
  // independently. Round 3 still gets the shape question at tier S; it rides
  // along in the one compact brief instead of buying a second reviewer,
  // because "S" means one reviewer and a re-check of an S change is not a
  // bigger job than the change was.
  if (compact) return [cloneRow(COMPACT, { kind: dominantKind(kinds), ...(round >= 3 ? { angles: [...COMPACT.angles, ...SHAPE.angles] } : {}) })];
  if (round >= 3) return [cloneRow(COMPACT, { kind: dominantKind(kinds) }), cloneRow(SHAPE)];
  const rows = [];
  if (kinds.code.length) {
    rows.push(...ROUND_2.map((row) => cloneRow(row)));
    // A fix is a new change and can break the cold run the same way the
    // original could — but only where there is still something to run. Handed
    // to a round with no entry point in it, "run the artifact" has no subject,
    // and a reviewer with no subject reports a pass it did not earn.
    //
    // Its own row, not an angle appended to a code finder: X is graded by an
    // agent with no shell, so it cannot share a reviewer with angles that need
    // one. That makes round 2 three finders instead of two wherever the change
    // ships something runnable — the cost of the property, paid where it is
    // visible rather than hidden by merging X into a finder that could run the
    // artifact itself.
    if (kinds.executable.length) rows.push({ group: "X", angles: ["X"], kind: "code" });
  }
  if (kinds.docs.length) {
    const angles = ["P1", "P2", "P3", "V"];
    if (kinds.instructional.length) angles.push("P4");
    rows.push({ group: "docs", angles, kind: "docs" });
  }
  // Config folds into the nearest finder rather than spending a whole one on
  // it: round 2 is a re-check, not a fresh sweep.
  if (kinds.config.length) {
    // Never the cold row. `rows[rows.length - 1]` IS the X row whenever the
    // change touches code and config but no docs — an ordinary round-2 shape,
    // a CI fix beside a code fix — and pushing K1/K2 into it made
    // `isColdGrader` false, which routed angle X to a finder WITH a shell
    // holding a brief that tells it it has none. That is the exact wrong-layer
    // failure this whole feature exists to remove, reached by accident.
    const foldable = rows.filter((row) => !isColdGrader(row));
    const host = foldable.find((row) => row.kind === "docs") ?? foldable[foldable.length - 1];
    if (host) host.angles.push("K1", "K2");
    else rows.push({ group: "K1+K2", angles: ["K1", "K2"], kind: "config" });
  }
  // Counted without the cold row, because X is an ADDITION to the round-2
  // budget, not a claim on it. Counting it here made its own presence trigger
  // the fold: a code-and-script change with no docs went from two 5-angle
  // finders to one 10-angle finder plus X, so the round that ships something
  // runnable got the *least* attention per angle — the opposite of the reason
  // X exists, and a direct contradiction of the comment three lines above.
  if (rows.filter((row) => !isColdGrader(row)).length > 2) {
    // X is held out of the fold and out of the slice: folding it in would hand
    // the transcript to a finder with a shell, and slicing it away would drop
    // the angle silently on exactly the changes that ship something runnable.
    const cold = rows.filter(isColdGrader);
    const code = rows.filter((row) => row.kind === "code" && !isColdGrader(row));
    const rest = rows.filter((row) => row.kind !== "code");
    const folded = { group: "code", angles: [...new Set(code.flatMap((row) => row.angles))], kind: "code" };
    return [...(code.length ? [folded] : []), ...rest].slice(0, 2).concat(cold);
  }
  return rows;
}

export function buildFinders({ tier, round, kinds, markers, config, impactConfig, compact }) {
  const base = round >= 2 || compact ? laterRound(round, kinds, compact) : groupsFor(tier, kinds, markers);
  const cap = round >= 2 || compact ? Math.min(2, config.finders.maxPerRound) : config.finders.maxPerRound;
  const { rows, merged } = round >= 2 || compact ? { rows: base, merged: [] } : mergeToFit(base, tier, cap);
  const callsFor = { code: config.finders.callsCode, docs: config.finders.callsDocs, config: config.finders.callsConfig };
  const full = new Set(impactConfig.fullFor);
  const docsDepth = new Set(impactConfig.docsFor);
  const finders = rows.map((row) => ({
    name: `r${round}-${row.angles.join("").toLowerCase()}`,
    kind: row.kind,
    angles: row.angles,
    // X alone gets the grader, which has no shell. Every other angle reads the
    // change; X reads a TRANSCRIPT that `coldrun.sh` already produced inside
    // containment, and the one thing that must stay impossible is a reviewer
    // deciding for itself which invocation of unknown code is safe to run.
    // Held by the agent's tool list rather than by a sentence in its brief —
    // two review rounds in a row returned `wrong-layer` on the sentence.
    agent: isColdGrader(row) ? "self-review-cold-grader" : "self-review-finder",
    model: row.model ?? "sonnet",
    effort: "high",
    // The grader's work is one transcript plus the entry points it names, not
    // the whole change: a code finder's budget would be forty calls of reading
    // it does not need to do.
    calls: isColdGrader(row) ? config.finders.callsCold : callsFor[row.kind],
    // Tracing angles get the whole blast radius; prose angles get the sections
    // they can act on; the rest get two lines and a path (DESIGN §4.3).
    impact: row.angles.some((angle) => full.has(angle)) ? "full" : row.angles.some((angle) => docsDepth.has(angle)) ? "docs" : "summary",
    weightFixLines: true,
  }));
  return { finders, merged };
}

// --- assembly --------------------------------------------------------------
/**
 * Tiers, weakest first — so a later round can be held at or below the tier the
 * change itself earned.
 */
const RANK = { S: 0, M: 1, L: 2 };

/**
 * One line per changed wire contract that still has a live consumer — the tier
 * marker's evidence. Gated on consumers FOUND, never on a contract having
 * changed: every route edit would otherwise escalate and the marker would mean
 * nothing.
 */
export function wireEvidence(impact) {
  const wire = impact?.wire;
  if (!wire?.tokens?.length) return [];
  const live = new Map();   // token key -> the first consumer that proves it
  for (const reference of wire.references ?? []) {
    // The same filter counts.wire_broken uses: a generated client is a
    // "regenerate", and a mention in a doc is not a caller.
    if (reference.generated || reference.kind === "docs" || live.has(reference.token)) continue;
    live.set(reference.token, reference);
  }
  return wire.tokens
    .filter((token) => token.state !== "added" && live.has(token.key))
    .map((token) => {
      const consumer = live.get(token.key);
      const name = token.verb ? `${token.verb} ${token.value}` : token.value;
      return `${name} ${token.to ? `→ ${token.to}` : "(removed)"}, still named at ${consumer.file}:${consumer.line}`;
    });
}

// --- the dominance note ----------------------------------------------------
/**
 * One line when a single top-level directory holds most of the change, else
 * null. The generic, guessing half of F2: `round.sh` refuses a scope whose
 * paperwork signature is unmistakable, and this only says out loud what the
 * scope is mostly made of, because a vendored tree or a generated bundle has
 * no signature to match and a false refusal would drop a real change.
 *
 * Both thresholds have to fire — the share, so an ordinary change concentrated
 * in one directory stays quiet, and the floor, so a 12-line change never gets
 * advice about narrowing it.
 */
export function dominantDirectory(perFile, { share = 0.6, floor = 1000 } = {}) {
  const byDirectory = new Map();
  let total = 0;
  for (const [file, count] of perFile) {
    total += count;
    // A file at the root has no directory to narrow to, so it counts toward
    // the total and can never be the answer.
    const [top, ...rest] = file.split("/");
    if (!rest.length) continue;
    byDirectory.set(top, (byDirectory.get(top) ?? 0) + count);
  }
  const [top, lines] = [...byDirectory].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!top || lines < floor || lines < total * share) return null;
  const count = (n) => n.toLocaleString("en-US");
  return `note: ${count(lines)} of ${count(total)} changed lines are under ${top}/ — if that is not the change, narrow the scope`;
}

export function plan({ scope, impact, round = 1, compact = false, force = null, reason = null, cap = null, capMarkers = [], config, exempt }) {
  const repo = scope.repos[0];
  const files = repo?.files ?? [];
  const diff = parseDiff(repo?.diff ?? []);
  const kinds = classifyChanged(files, config, exempt, repo?.root || null);
  const metrics = measure({ scope, files, diff, kinds, impact });
  // Which new code files have no test naming them: the M → L modifier's input.
  metrics.newCodeFiles = files.filter(({ path: file, status }) => NEW.has(status) && kinds.code.includes(file)).map(({ path: file }) => file);
  metrics.untestedFiles = (impact?.symbols ?? []).filter((symbol) => symbol.test_refs === 0).map((symbol) => symbol.file);
  const markers = riskMarkers({ files, diff, kinds, config, broken: metrics.broken, wire: wireEvidence(impact) });
  const chosen = pickTier({ metrics, markers, kinds, config, hasImpact: Boolean(impact) });
  // A later round reviews the fix to the round before it, but the scope is
  // captured against HEAD — so the fix's lines are ADDED to the original
  // change's and the tier can only ratchet up. Measured 2026-08-29: a 2-line
  // tier-S change whose round-1 fix added a 24-line test file recomputed as
  // tier M in round 2 and spawned two finders where round 1 had spent one.
  // Fixing a finding well must not cost more than finding it, so round 2+ is
  // held at the tier the change itself earned. `--force` still wins: raising a
  // round deliberately is a judgement the cap has no business overriding.
  //
  // But a ceiling that is a bare tier-vs-tier comparison cannot tell those two
  // apart from a fix that became DANGEROUS: a round-2 fix that first touches
  // `auth/`, or first adds a `DROP TABLE`, reaches L through pickTier's
  // escalating list, and capping it to S would drop exactly the opus security
  // finder the marker exists to force — silently, since nothing but a human
  // re-reading the tier line would notice. So the cap binds only on markers the
  // capping round ALREADY had; one that fires for the first time lifts it.
  const newMarkers = ESCALATING.filter((name) => markers[name].length && !capMarkers.includes(name));
  const capBinds = Boolean(cap) && newMarkers.length === 0;
  const capped = capBinds && RANK[chosen.tier] > RANK[cap] ? cap : chosen.tier;
  const tier = force ?? capped;
  const lifted = Boolean(cap) && !capBinds && RANK[chosen.tier] > RANK[cap];
  const reasons = force ? [`forced ${force}: ${reason}`, ...chosen.reasons]
    : capped !== chosen.tier ? [`held at ${cap}: round 1 tiered the change ${cap}, and a round that reviews the fix inherits it`, ...chosen.reasons]
    : lifted ? [`ceiling ${cap} lifted: ${newMarkers.join(", ")} fired for the first time this round`, ...chosen.reasons]
    : chosen.reasons;
  // One finder at tier S in every round, not only the first: the compact brief
  // is what "S" buys, and a re-check of an S change is not a bigger job.
  const one = compact || (round >= 2 && tier === "S");
  const { finders, merged } = buildFinders({ tier, round, kinds, markers, config, impactConfig: config.impactDepths, compact: one });
  const notes = [dominantDirectory(changedLineCounts(diff))].filter(Boolean);
  delete metrics.newCodeFiles;
  delete metrics.untestedFiles;
  return {
    schema: SCHEMA, tier, computed: chosen.tier, forced: force, cappedTo: !force && capped !== chosen.tier ? cap : null, capLifted: !force && lifted ? newMarkers : null, reason, split: chosen.split, round,
    reasons, notes, kinds, metrics, markers, finders, merged,
    verifier: tier === "L" ? "agent" : "author",
    roundsCap: config.finders.roundsCap[tier],
    impactAdapter: impact?.adapter ?? null,
  };
}

// --- CLI -------------------------------------------------------------------
const TIERS = new Set(["S", "M", "L"]);

export function parseArgs(argv) {
  const options = {};
  const flags = ["scope", "out", "impact", "round", "force", "reason", "cap", "cap-markers"];
  const booleans = ["compact"];
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].startsWith("--") ? argv[i].slice(2).split(/=(.*)/s) : [null, null];
    if (booleans.includes(name)) { options[name] = true; continue; }
    if (!name || !flags.includes(name)) throw Object.assign(new Error(`unknown argument ${argv[i]}`), { exitCode: 2 });
    const value = inline ?? argv[++i];
    if (value === undefined) throw Object.assign(new Error(`--${name} needs a value`), { exitCode: 2 });
    options[name] = value;
  }
  return options;
}

const read = (file, what, exitCode) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw Object.assign(new Error(`cannot read ${what} (${file}): ${error.message}`), { exitCode });
  }
};

export function main(argv, { log = console.log } = {}) {
  const options = parseArgs(argv);
  const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });
  for (const required of ["scope", "out"]) if (!options[required]) throw usage(`--${required} is required`);
  const force = options.force ? options.force.toUpperCase() : null;
  if (force && !TIERS.has(force)) throw usage(`--force must be one of ${[...TIERS].join(", ")}`);
  const cap = options.cap ? options.cap.toUpperCase() : null;
  if (cap && !TIERS.has(cap)) throw usage(`--cap must be one of ${[...TIERS].join(", ")}`);
  // The markers the capping round already had — all of them, not only the
  // escalating ones: round.sh reads them straight out of round 1's tier.json,
  // and `security`/`concurrency` are real markers that just do not escalate.
  // An unknown name is still a usage error, so a typo cannot silently disarm
  // the ceiling's one exception.
  const capMarkers = (options["cap-markers"] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of capMarkers) if (!MARKER_NAMES.includes(name)) throw usage(`--cap-markers must name risk markers (${MARKER_NAMES.join(", ")}), got ${name}`);
  if (capMarkers.length && !cap) throw usage("--cap-markers belongs to --cap");
  // An override with no reason cannot be audited later, and an unauditable
  // override is how a review quietly shrinks.
  if (force && !options.reason) throw usage("--force needs --reason \"…\": a lowered tier has to be auditable");
  if (options.reason && !force) throw usage("--reason belongs to --force");
  const round = Number(options.round ?? 1);
  if (!Number.isInteger(round) || round < 1) throw usage("--round needs a positive integer");

  const scope = parseScope(read(path.resolve(options.scope), "the scope", 3));
  const root = scope.repos[0]?.root;
  const config = loadConfig(root);
  const impact = options.impact ? JSON.parse(read(path.resolve(options.impact), "the impact JSON", 3)) : null;

  const result = plan({
    scope, impact, round, compact: Boolean(options.compact), force, reason: options.reason ?? null, cap, capMarkers,
    config: { ...config.tier, impactDepths: config.impact }, exempt: config.exempt,
  });
  const outDir = path.resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "tier.json");
  writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);

  // Eight lines at most: this lands in the main session's context, where every
  // line is paid for again on every later turn.
  log(`tier ${result.tier}${result.forced ? " (forced)" : result.cappedTo ? " (held)" : result.capLifted ? " (ceiling lifted)" : ""} · round ${round}${result.split ? " · SPLIT: the scope is too big for one review" : ""} — ${result.reasons.slice(0, 3).join("; ")}`);
  for (const row of result.finders) {
    log(`${row.name}  ${row.kind}  ${row.angles.join("+")}  ${row.model}/${row.effort}  ${row.calls} calls  impact=${row.impact}`);
  }
  // After the finder rows, before the footer: it is advice about the scope, and
  // a lead who reads only the first line has already seen the tier it bought.
  for (const note of result.notes) log(note);
  const mergedText = result.merged.length ? ` · merged ${result.merged.map(([from, , into]) => `${from}→${into}`).join(", ")}` : "";
  log(`verifier: ${result.verifier} · rounds cap ${result.roundsCap}${mergedText} · plan: ${file}`);
  return result;
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tier.mjs: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
