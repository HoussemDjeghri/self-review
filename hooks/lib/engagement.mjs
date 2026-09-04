// Proof that tree-guard engaged.
//
// Ruling 1 (docs/design-notes/questions/review-process-misses-answer.md) named
// the shape every defect this repo has shipped shares: a mechanism whose
// working and inert behaviours are identical. `evaluate()` in tree-guard.mjs
// returns null whether it matched a reviewer or was watching nothing — the deny
// path carries a systemMessage, and the allow path and the inert path are the
// same silence. That is how the guard came to be inert for roughly ninety named
// finders, each holding a shell in the author's working tree, with every review
// round reading the file and correctly finding it correct.
//
// So the guard records whether it matched, and convergence reads the record.
// The ruling's words: "a mechanism that can be silently inert must prove it
// engaged". This is not a registry — nothing reads it to decide anything, only
// to audit afterwards.
//
// Scoped to a repository with a review in progress: `round.sh` opens the log
// for the round it is setting up, and the guard appends only to a log that is
// already open. A project that never runs this loop writes nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LOG_DIR, realpathOr } from "./config.mjs";

// Keyed by the repository the reviewers are reading, which is the one identity
// both sides have: `round.sh` knows the root it captured scope from, and the
// guard has the payload's `cwd`. Hashed for a filesystem-safe name, not to hide
// anything — the rows beside it name the agent types in full.
//
// Resolved before hashing, because the two sides spell the same repository
// differently and a raw string made them two repositories. `round.sh` passes
// `git rev-parse --show-toplevel`; the guard passes the payload's `cwd`. A
// checkout reached through a symlink hashed `b558beff…` from one and
// `eaa7be3d…` from the other, measured — and then every guarded call vanished
// into a log nothing read, which is the inert shape this file exists to end.
// `findings.mjs` already resolves for the identical reason (its `repoId`).
export const engagementFile = (repoRoot, logDir = LOG_DIR) =>
  path.join(logDir, "engagement",
    `${createHash("sha256").update(realpathOr(path.resolve(String(repoRoot || ".")))).digest("hex").slice(0, 16)}.jsonl`);

/** Open the log for a round. Called by round.sh before any reviewer starts. */
export function openEngagement(repoRoot, round, { logDir = LOG_DIR, now = () => new Date().toISOString() } = {}) {
  const file = engagementFile(repoRoot, logDir);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now(), kind: "round", round, repoRoot })}\n`);
  return file;
}

// The open log for this call's directory, or null. Resolving both sides is not
// enough on its own: a session started in a subdirectory gives the guard
// `<repo>/plugin` while `round.sh` opened the log under `<repo>`, so the walk
// climbs to the root the round actually opened. Bounded by the filesystem root,
// and it stops at the first open log — a nested checkout's own round wins over
// its parent's, which is the right precedence for "who is reviewing this call".
function openLogFor(startDir, logDir) {
  let dir = path.resolve(String(startDir || "."));
  for (;;) {
    const file = engagementFile(dir, logDir);
    if (existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Record one guarded invocation. Best effort and silent on failure: a hook that
 * cannot write its audit line must still let the tool call through, and a hook
 * that throws is a turn held hostage.
 *
 * Appends only when the log already exists — that is the whole of the scoping.
 *
 * The row carries the payload's `session_id`, and rows without one are written
 * but not counted. This raises the bar; it does not authenticate. `session_id`
 * arrives in the same stdin JSON as `agentType`, so a reviewer that knows its
 * own session id can write a row no check here can tell from a harness row —
 * the field is self-reported, and nothing a hook reads from its own stdin can
 * prove who dispatched it. What it does separate is the careless probe from the
 * harness, which is every probe measured so far: the log had no way to tell
 * "the harness asked the guard about a real tool call" from "somebody ran the
 * guard", and the
 * first live alarm this instrument raised was manufactured by a reviewer
 * probing the hook with a hand-made payload, and of eight such probes in one
 * day, two used a real finder's name — writing `matched: true` and able to mask
 * a genuinely blind round. Stamping rather than filtering is deliberate: a
 * write filter would make a change in the payload's shape look like a quiet
 * round, which is the inert shape this file exists to abolish. Unattributed
 * rows are kept, counted separately, and reported — so the same evidence that
 * let this be chased down stays on disk.
 */
export function noteEngagement(repoRoot, agentType, matched, { session = null, logDir = LOG_DIR, now = () => new Date().toISOString() } = {}) {
  try {
    const file = openLogFor(repoRoot, logDir);
    if (!file) return null;
    const row = { ts: now(), kind: "agent", agentType, matched, session: session || null };
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return row;
  } catch {
    return null;
  }
}

// A name this plugin generated, asked INDEPENDENTLY of the regex under audit.
// `tier.mjs` emits `<agent-type>-r<round>-<angles>` and a spawn with no name
// sends the registered type, so both begin with the agent's own type — that
// prefix is the claim, and whether tree-guard's REVIEWER matched it is the
// measurement. Deliberately not tree-guard's regex: a check written in the
// terms of the thing it checks passes whenever that thing is consistent with
// itself, which is exactly the failure being audited.
export const OURS = /^(self-review:)?self-review-(finder|verifier|cold-grader|applier|ticket-validator)\b/;

// Of the names this plugin generates, the ones tree-guard is meant to cover.
// The split decides which of two DIFFERENT failures an unmatched row is, and
// they have different remedies: a covered type the guard did not match means
// the guard's regex has gone inert (F10h, the defect this log exists to catch);
// an uncovered type means an agent ran a shell that no guard was ever watching.
// Kept as a static list rather than read from tree-guard, for the reason OURS
// is: a check written in the terms of the thing it checks passes whenever that
// thing is consistent with itself. `engagement.test.mjs` asserts tree-guard's
// REVIEWER really does match one canonical spelling of each name here, so the
// two constants cannot drift apart in silence.
const COVERED = /^(self-review:)?self-review-(finder|verifier|cold-grader|ticket-validator)\b/;

/**
 * What the log says about the round that just ran.
 *
 * Two findings, and they are different failures. `unmatched` is a name this
 * plugin generated that the guard did not recognise — the F10h defect, where a
 * regex stopped matching the names the harness actually sends. `blind` is a
 * round in which reviewers ran shell commands and the guard matched none of
 * them, which is the same defect seen from the other side and the only one
 * that would have caught F10h before ninety finders had run.
 *
 * No rows at all is not a finding: a round whose reviewers ran no Bash — a
 * cold-grader has no shell — exercised nothing to prove.
 */
export function auditEngagement(text, { round = null } = {}) {
  const rows = String(text ?? "").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  // From the round's own marker to the NEXT marker, not to the end of the file:
  // the log is append-only across a whole review, so slicing to the end reported
  // every later round's calls as this one's — which is the direction that hides
  // a blind round behind a later round that engaged.
  const openedAt = round === null
    ? rows.findLastIndex((row) => row.kind === "round")
    : rows.findLastIndex((row) => row.kind === "round" && row.round === round);
  // A named round whose marker is absent was never opened, and the file's other
  // rounds are not evidence about it. Substituting the whole file here — which
  // this did — reported a round the guard never watched as fully engaged, using
  // rows from earlier rounds: a green line manufactured out of the absence of
  // the thing it claims to have measured. `round.sh` ends the open call in
  // `|| true`, so a failed open is exactly this silent. The whole-file fallback
  // survives only for `round === null`, where "no markers at all" is the
  // question being asked rather than an answer being invented.
  // No marker for the round asked for — or, when none was asked for, no marker
  // at all — means nothing opened a round here, and the file's other rows are
  // not evidence about it.
  if (openedAt === -1) {
    return { calls: 0, matched: 0, unmatched: [], uncovered: [], unattributed: 0, blind: false, opened: false };
  }
  const after = rows.slice(openedAt + 1);
  const nextRound = after.findIndex((row) => row.kind === "round");
  const mine = (nextRound === -1 ? after : after.slice(0, nextRound))
    .filter((row) => row.kind === "agent");
  // Only rows the harness attributed to a session are evidence; the rest are
  // kept, counted, and reported on their own line.
  const attributed = mine.filter((row) => row.session);
  const unattributed = mine.length - attributed.length;
  const typeOf = (row) => String(row.agentType ?? "");
  const covered = attributed.filter((row) => COVERED.test(typeOf(row)));
  const unmatched = [...new Set(covered.filter((row) => !row.matched).map(typeOf))];
  // Counted in ROWS, not names: "1 name" understated three shell calls the
  // first time this fired, and the number that matters is how many calls went
  // unwatched.
  const uncovered = [...attributed
    .filter((row) => OURS.test(typeOf(row)) && !COVERED.test(typeOf(row)))
    .reduce((tally, row) => tally.set(typeOf(row), (tally.get(typeOf(row)) ?? 0) + 1), new Map())]
    .map(([agentType, rows]) => ({ agentType, rows }));
  return {
    calls: attributed.length,
    matched: attributed.filter((row) => row.matched).length,
    unmatched,
    uncovered,
    unattributed,
    // Over EVERY attributed row, not just the covered ones. Restricting it to
    // covered types would have made it silent in precisely the case it exists
    // for: when the guard's regex dies, the names it fails on are the ones no
    // regex here matches either, so `covered` would be empty and the alarm
    // would not fire. The `uncovered` case is separated by the line's priority
    // order instead — a round with matched rows is not blind, so it falls
    // through to the uncovered clause.
    blind: attributed.length > 0 && attributed.every((row) => !row.matched),
    opened: true,
  };
}

/** The one line the audit adds to a round's output, or null when it has nothing to say. */
export function engagementLine(audit) {
  if (audit.opened === false) {
    return "# tree-guard: no engagement log was opened for this round — the guard proved nothing, " +
      "and this line is the absence, not a pass (ruling 1, item 2)";
  }
  if (audit.unmatched.length) {
    return `# tree-guard did NOT match ${audit.unmatched.length} name this plugin generated (${audit.unmatched.join(", ")}) — ` +
      "its reviewer regex has gone inert against what the harness now sends, and every shell those agents ran was unguarded (ruling 1, item 2)";
  }
  if (audit.uncovered?.length) {
    const rows = audit.uncovered.reduce((n, one) => n + one.rows, 0);
    return `# ${rows} shell call${rows === 1 ? "" : "s"} under ${audit.uncovered.map((one) => one.agentType).join(", ")}, ` +
      "a name the guard does not cover. That agent is declared with no Bash tool at all; if a real one ran these, " +
      "its tool list is not being honoured and no guard was watching";
  }
  // After `uncovered`, and deliberately: a round whose only unmatched rows are
  // uncovered types is not a blind guard, and saying "no reviewer ran a shell
  // under a name it knows" there names the wrong defect. The inert clause stays
  // FIRST, because a dead regex fails on names COVERED does match, so it can
  // never be misfiled as uncovered.
  if (audit.blind) {
    return `# tree-guard matched none of the ${audit.calls} subagent shell call${audit.calls === 1 ? "" : "s"} this round — ` +
      "either no reviewer ran a shell under a name it knows, or it is watching nothing (ruling 1, item 2)";
  }
  // Every reviewer type has now been observed running a shell, so an open log
  // the guard was never asked about is anomalous rather than ordinary.
  if (!audit.calls) {
    if (audit.unattributed) {
      return `# tree-guard recorded ${audit.unattributed} shell call${audit.unattributed === 1 ? "" : "s"} this round and none carried a session id — ` +
        "the harness payload changed shape, or something ran the hook by hand. The guard proved nothing (ruling 1, item 2)";
    }
    return "# tree-guard was asked about no subagent shell call this round — the log was open and nothing reached it, " +
      "which every reviewer type running a shell makes unlikely (ruling 1, item 2)";
  }
  return `# tree-guard engaged: ${audit.matched}/${audit.calls} subagent shell calls matched a reviewer` +
    (audit.unattributed ? ` · ${audit.unattributed} by hand, not counted` : "");
}
