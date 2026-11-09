// Whether a `converged` marker's review has a pre-flight check with no verdict,
// or had its pre-flight evidence written by hand — from whichever marker form
// was used:
//
// - The review a marker means is resolved from its id: the id round.sh printed
//   is `git hash-object` of the work dir's path, so a candidate dir matches when
//   its path hashes to it. Candidates are the `work:` lines round.sh printed in
//   this session, the `--work` paths converged.sh was given, and every
//   `review-<k>` dir beside them or beside the marker file. An id that matches none is refused: a real review printed its `work:`.
// - A marker naming no review is checked against every OPEN review dir beside
//   it (one with no CONVERGED.json of its own), since one of them is the review
//   it closes.
// - Evidence written by the lead — any tool call that wrote, moved or removed a
//   `preflight*.txt` in the review's dir or a round dir — refuses the marker
//   outright: the transcript cannot tell a later genuine report from a later
//   forged one, so the review ends `checks-unverified` or starts again.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { PREFLIGHT_REPORT_RE, unverifiedChecks } from "./preflight-report.mjs";

const REVIEW_DIR_RE = /^review-\d+$/;

// `git hash-object --stdin` of the path, both object formats, for the path as
// given and as resolved: round.sh may print /var/… where realpath says
// /private/var/…, and either may be the spelling that was hashed.
function idsOf(dir) {
  const spellings = new Set([path.resolve(dir)]);
  try { spellings.add(realpathSync(dir)); } catch { /* gone: the given spelling only */ }
  const ids = new Set();
  for (const s of spellings) {
    const blob = Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(s)}\0`), Buffer.from(s)]);
    for (const algo of ["sha1", "sha256"]) ids.add(createHash(algo).update(blob).digest("hex").slice(0, 8));
  }
  return ids;
}

/** The `review-<k>` dirs directly under `base`. */
export function reviewDirsUnder(base) {
  try {
    return readdirSync(base).filter((n) => REVIEW_DIR_RE.test(n)).map((n) => path.join(base, n));
  } catch { return []; }
}

/** The candidate review dirs: the given ones and every `review-<k>` beside them. */
export function candidateDirs(works, bases = []) {
  const all = new Set(works.map((w) => path.resolve(w)));
  for (const base of [...bases, ...works.map((w) => path.dirname(path.resolve(w)))]) {
    for (const dir of reviewDirsUnder(base)) all.add(dir);
  }
  return [...all];
}

/** The candidate whose path hashes to `id`, or null. */
export function resolveReviewDir(id, candidates) {
  if (typeof id !== "string" || !id) return null;
  return candidates.find((dir) => idsOf(dir).has(id)) ?? null;
}

// The path with its longest existing prefix realpath'd: /var and /private/var,
// or /tmp and /private/tmp, are one dir, and a removed file has no realpath.
function canonical(p) {
  let head = path.resolve(p);
  const rest = [];
  while (!existsSync(head) && path.dirname(head) !== head) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  try { head = realpathSync(head); } catch { /* keep the resolved spelling */ }
  return path.join(head, ...rest);
}

const GLOB_RE = /[*?[{]/;
// Whether a shell glob as a basename (`preflight*.txt`, `preflight{,.2}.txt`,
// `*`) could name a report in `parent`. A pattern that does not compile counts.
function globNamesReport(glob, parent) {
  return globNames(glob, ["preflight.txt", "preflight-rerun.txt"], parent, PREFLIGHT_REPORT_RE);
}

// Whether `glob` matches one of `usual` or an entry of `parent`, among names `kind` accepts.
function globNames(glob, usual, parent, kind) {
  let re;
  try {
    const src = glob.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")
      .replace(/\{([^}]*)\}/g, (_, alts) => `(?:${alts.split(",").join("|")})`);
    re = new RegExp(`^${src}$`);
  } catch { return true; }
  let names = usual;
  try { names = names.concat(readdirSync(parent)); } catch { /* gone: the usual names */ }
  return names.some((n) => kind.test(n) && re.test(n));
}

/**
 * Whether a written, moved or removed path touches review dir `dir`'s
 * pre-flight evidence: a report in it or a round dir, the review dir or a
 * round dir itself, or anything above the review dir — removing or moving a
 * dir takes its reports with it.
 */
export function isEvidenceOf(file, dir) {
  const f = canonical(file);
  const root = canonical(dir);
  if (f === root || root.startsWith(f + path.sep)) return true;
  // A glob may sit in any component (`review-*/round-*/preflight*.txt`), so
  // the path is compared with the review dir one component at a time.
  const fs = f.split(path.sep), rs = root.split(path.sep);
  const same = (i) => fs[i] === rs[i] || (GLOB_RE.test(fs[i]) && globNames(fs[i], [rs[i]], rs.slice(0, i).join(path.sep) || path.sep, /^/));
  for (let i = 0; i < Math.min(fs.length, rs.length); i++) if (!same(i)) return false;
  if (fs.length <= rs.length) return true; // the review dir or an ancestor, by glob
  const rest = fs.slice(rs.length);
  const isRound = (c, parent) => /^round-\d+$/.test(c) || (GLOB_RE.test(c) && globNames(c, ["round-1"], parent, /^round-\d+$/));
  if (rest.length === 1) return isRound(rest[0], root) || PREFLIGHT_REPORT_RE.test(rest[0]) || (GLOB_RE.test(rest[0]) && globNamesReport(rest[0], root));
  if (rest.length !== 2 || !isRound(rest[0], root)) return false;
  const round = path.join(root, rest[0]);
  return PREFLIGHT_REPORT_RE.test(rest[1]) || (GLOB_RE.test(rest[1]) && globNamesReport(rest[1], round));
}

/**
 * Why `converged` may not stand for review dir `dir`: its unverified checks,
 * and every hand-written report. `written` is `[{ file, how, seq }]`, the paths
 * the session's own tool calls wrote, moved or removed, in order;
 * `allocations` is `[{ dir, seq }]`, each `round.sh --new-review` that
 * allocated a dir. An event before the latest allocation of `dir` happened to
 * an earlier review at the same path, and does not count against this one.
 */
export function evidenceProblems(dir, written, allocations = []) {
  const root = canonical(dir);
  const since = Math.max(-Infinity, ...allocations.filter((a) => canonical(a.dir) === root).map((a) => a.seq));
  const problems = [];
  for (const { file, how, seq } of written) {
    if (seq !== undefined && seq < since) continue;
    if (!isEvidenceOf(file, dir)) continue;
    problems.push(`pre-flight evidence in ${dir} was written by hand: ${how} touched ${file}. A report counts only when preflight.sh writes it, and the transcript cannot tell a later real one from another hand-written one — end --not-converged --reason checks-unverified, or start again with round.sh --new-review.`);
  }
  for (const c of unverifiedChecks(dir)) {
    problems.push(`pre-flight has no verdict on ${c.kind} \`${c.cmd}\` (${c.why}) in ${dir}: re-run it as \`findings.mjs converge\`'s next: line prints, or end --not-converged --reason checks-unverified.`);
  }
  return problems;
}

/**
 * The problems with a `converged` marker. `dir` is the review dir when the
 * marker's own path names it; otherwise `review` (the id it carries) is
 * resolved among `candidates`, and with no id every open dir in `openBases`
 * (where a bare marker sits) is checked.
 */
export function convergedProblems({ dir = null, review = null, candidates = [], openBases = [], written = [], allocations = [] }) {
  if (dir) return evidenceProblems(dir, written, allocations);
  if (review) {
    const resolved = resolveReviewDir(review, candidates);
    if (!resolved) return [`review ${review} matches no review dir this session's round.sh printed or that sits beside the marker — write <work>/CONVERGED.json, or run converged.sh with --work <work> (the work: path round.sh printed).`];
    return evidenceProblems(resolved, written, allocations);
  }
  const open = [...new Set(openBases.flatMap(reviewDirsUnder))].filter((d) => !existsSync(path.join(d, "CONVERGED.json")));
  return open.flatMap((d) => evidenceProblems(d, written, allocations)
    .map((p) => `${p} (This marker names no review, so every open review dir was checked: write <work>/CONVERGED.json, or pass --work <work>, to close only yours.)`));
}
