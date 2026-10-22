/**
 * Branch review debt — the git half of the Stop gate's opt-in branch review.
 *
 * Every question here is answered by git, never by the transcript: the debt is
 * `git diff` between a reviewed tree and a snapshot of the worktree, not a sum
 * of what the gate saw written. A write the transcript cannot see — another
 * session in the worktree, the user's editor, a `git merge` — is in the tree,
 * so it is debt.
 *
 * WHAT IS REVIEWED lives in `refs/self-review-reviewed/<branch>`, one ref per
 * branch, written only by the gate. Refs are not repository content: clone and
 * fetch do not bring a custom namespace, push does not send one, and worktrees
 * of one clone share them. The namespace is outside treecheck.sh's
 * `refs/self-review/` so its 7-day prune never reaches it; a ref names the
 * snapshot commit of the round that was reviewed, which keeps that object alive
 * after the round's own ref is pruned.
 *
 * A REVIEWED BASELINE is the tree of any of those refs, or `merge-base(HEAD,
 * main)`: everything in one was reviewed or grandfathered, so a diff from any of
 * them can over-count unreviewed work and never under-count it. The debt is
 * the smallest such diff. That one rule absorbs a rebase onto a moved main, a
 * renamed branch and a merge of main into the branch, with no case of its own.
 *
 * Every git call runs with the `GIT_*` variables removed: a repository's
 * settings `env` could otherwise point the gate at a checked-in `.git` holding
 * forged refs, which is a repository releasing its own hold.
 *
 * The snapshot is treecheck.sh's move: a COPY of the index, `add -A` into it,
 * `write-tree`. Nothing the author can see changes — not the worktree, not the
 * index, not HEAD.
 *
 * Every function returns null when git cannot answer, and the gate reads null
 * as "measure nothing, gate the turn as today" — the strict direction.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const REVIEWED_NS = "refs/self-review-reviewed/";
const GIT_TIMEOUT_MS = 10_000;
// A ref whose branch is gone is pruned once the commit it names is this old —
// the commit's date, not the deletion's, since git keeps no record of when a
// branch went. Main's ref is never pruned: a clone may have no local main.
const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;

export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  ...extra,
});

// One deadline over every call, set by the gate: the Stop hook is killed at
// its timeout, and a killed hook decides nothing — the unmarked turn it would
// have blocked just ends. Past the deadline a call answers null, which every
// caller already reads as "measure nothing, gate the turn as today".
let deadline = Infinity;
export const setDeadline = (at) => { deadline = at; };

function run(cwd, args, extraEnv) {
  const left = deadline - Date.now();
  if (left <= 0) return { status: null, stdout: "" };
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: Math.min(GIT_TIMEOUT_MS, left), maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"], env: cleanEnv(extraEnv),
  });
}
const git = (cwd, args, extraEnv) => {
  const result = run(cwd, args, extraEnv);
  return result.status === 0 ? result.stdout : null;
};
const line = (out) => (out === null ? null : out.trim() || null);

export const topOf = (cwd) => line(git(cwd, ["rev-parse", "--show-toplevel"]));

/** The checked-out branch's short name; null when HEAD is detached or unborn. */
// Full names, stripped here: `--short` prints the disambiguated form
// (`heads/main`) when a tag or remote shares the short name.
const strip = (prefix) => (name) => (name?.startsWith(prefix) ? name.slice(prefix.length) : null);
export const branchOf = (top) => strip("refs/heads/")(line(git(top, ["symbolic-ref", "-q", "HEAD"])));

/**
 * The integration branch: `ref`, the commit to measure against, and `local`,
 * the branch name that counts as being "on" it. `override` is the user's
 * `repos.<id>.branchDebt.main` — a branch (`develop`) or a remote one
 * (`origin/develop`). Without it, `origin/HEAD`. Null when neither resolves: a
 * repository with no remote default is not one this mode can measure.
 */
export function mainOf(top, override = "") {
  const name = override || strip("refs/remotes/")(line(git(top, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])));
  if (!name) return null;
  // Full refnames first, so a tag sharing the short name cannot decide main's commit.
  const remoteRef = commitOf(top, `refs/remotes/${name}`);
  const ref = remoteRef ?? commitOf(top, `refs/heads/${name}`) ?? commitOf(top, name);
  if (!ref) return null;
  const remote = name.match(/^([^/]+)\/(.+)$/);
  const isRemote = remote !== null && remoteRef !== null;
  return { name, ref, local: isRemote ? remote[2] : name };
}

export const commitOf = (top, rev) => line(git(top, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]));
export const treeOf = (top, rev) => line(git(top, ["rev-parse", "--verify", "-q", `${rev}^{tree}`]));
export const mergeBase = (top, a, b) => line(git(top, ["merge-base", a, b]));

/** The worktree as a tree object: tracked changes and untracked, non-ignored files. */
export function worktreeTree(top) {
  const dir = mkdtempSync(path.join(tmpdir(), "self-review-debt-"));
  const index = path.join(dir, "index");
  try {
    const real = line(git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    if (real) { try { copyFileSync(real, index); } catch { /* rebuilt from scratch: slower, not wrong */ } }
    if (git(top, ["add", "-A"], { GIT_INDEX_FILE: index }) === null) return null;
    return line(git(top, ["write-tree"], { GIT_INDEX_FILE: index }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One row per changed path with its added + deleted lines; `binary` when
 * numstat would not count it. Renames are not detected on purpose: a moved
 * file is code nobody has reviewed in its new place, and the count errs high.
 */
export function diffRows(top, fromTree, toTree) {
  if (fromTree === toTree) return [];
  const out = git(top, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", fromTree, toTree]);
  if (out === null) return null;
  const rows = [];
  for (const field of out.split("\0")) {
    const match = field.match(/^(\d+|-)\t(\d+|-)\t(.+)$/s);
    if (!match) continue;
    const binary = match[1] === "-";
    rows.push({ path: match[3], lines: binary ? 0 : Number(match[1]) + Number(match[2]), binary });
  }
  return rows;
}

/**
 * The lines a numstat-binary path changed, counted from a `--text` patch.
 * numstat ignores `--text`, and the repository's own `.gitattributes` decides
 * what is binary — so `*.ts binary` would otherwise count a branch's code as
 * zero. Only code paths reach here; null when git cannot answer.
 */
export function textLines(top, fromTree, toTree, rel) {
  const out = git(top, ["--literal-pathspecs", "diff-tree", "-r", "-p", "--text", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", fromTree, toTree, "--", rel]);
  if (out === null) return null;
  let lines = 0;
  let inHunk = false;
  for (const row of out.split("\n")) {
    if (row.startsWith("diff --git ")) inHunk = false;
    else if (row.startsWith("@@")) inHunk = true;
    else if (inHunk && (row[0] === "+" || row[0] === "-")) lines += 1;
  }
  return lines;
}

/**
 * Every reviewed ref: `{ branch, commit, tree, date, parent, snapshot }`.
 * `snapshot` marks a ref written from a review (treecheck.sh's commit, whose
 * parent is HEAD when the round was recorded) rather than an adopted or
 * fast-forwarded branch tip.
 */
export function reviewedRefs(top) {
  const out = git(top, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(tree)%00%(committerdate:unix)%00%(parent)%00%(subject)", REVIEWED_NS]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean).map((row) => {
    const [ref, commit, tree, date, parent, subject] = row.split("\0");
    return {
      branch: ref.slice(REVIEWED_NS.length), commit, tree, date: Number(date) * 1000,
      parent: parent.split(" ")[0] || null, snapshot: /^self-review round \d+ snapshot$/.test(subject),
    };
  });
}

const update = (top, branch, commit) =>
  git(top, ["update-ref", "-m", "self-review: reviewed", `${REVIEWED_NS}${branch}`, commit]) !== null;

/**
 * Record `commit` as `branch`'s reviewed tree. Branch names nest like paths, so
 * a leftover `feat/x` ref blocks writing `feat` (and the reverse); a blocking
 * ref whose branch is gone is removed and the write retried.
 */
export function writeReviewed(top, branch, commit) {
  if (update(top, branch, commit)) return true;
  const blocking = (reviewedRefs(top) ?? []).filter((ref) =>
    ref.branch !== branch && (ref.branch.startsWith(`${branch}/`) || branch.startsWith(`${ref.branch}/`)));
  if (!blocking.length || blocking.some((ref) => commitOf(top, `refs/heads/${ref.branch}`))) return false;
  for (const ref of blocking) git(top, ["update-ref", "-d", `${REVIEWED_NS}${ref.branch}`]);
  return update(top, branch, commit);
}

/** Refs whose branch has been gone long enough that nothing will come back to them. */
export function pruneReviewed(top, refs, mainLocal, now = Date.now()) {
  for (const ref of refs) {
    if (ref.branch === mainLocal || now - ref.date < PRUNE_AFTER_MS) continue;
    if (commitOf(top, `refs/heads/${ref.branch}`)) continue;
    git(top, ["update-ref", "-d", `${REVIEWED_NS}${ref.branch}`]);
  }
}

/**
 * The tree the last round of review `id` read, from treecheck.sh's snapshot
 * ref: the highest `refs/self-review/<id>/round-<n>`, with the base and the
 * narrowing its commit message records. Null when the review left no snapshot.
 */
export function reviewSnapshot(top, id) {
  const out = git(top, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(tree)", `refs/self-review/${id}/`]);
  if (!out) return null;
  let best = null;
  for (const row of out.split("\n").filter(Boolean)) {
    const [ref, commit, tree] = row.split("\0");
    const round = Number(ref.match(/\/round-(\d+)$/)?.[1]);
    if (Number.isInteger(round) && (!best || round > best.round)) best = { round, commit, tree };
  }
  if (!best) return null;
  const message = git(top, ["log", "-1", "--format=%B", best.commit]) ?? "";
  const base = message.match(/^Self-Review-Base: ([0-9a-f]{40,64})$/m)?.[1] ?? null;
  const partial = /^Self-Review-Partial: yes$/m.test(message);
  return { ...best, base, partial };
}

/**
 * The tier-L path test over `riskPaths` (every category), one construction for
 * the gate and branch-debt.mjs. A pattern that does not compile is matched as
 * literal text rather than dropped: failing toward a hold, never open.
 */
export function riskPathTest(riskPaths) {
  const patterns = Object.values(riskPaths ?? {}).flat().filter((p) => typeof p === "string" && p);
  const res = patterns.map((p) => {
    try { return new RegExp(p, "i"); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  });
  return (rel) => res.some((re) => re.test(rel));
}

/** The reviewed baselines a diff may start from, each a commit and its tree. */
export function baselines(top, refs, main, { onMain }) {
  const out = refs.map((ref) => ({ commit: ref.commit, tree: ref.tree, label: `${REVIEWED_NS}${ref.branch}` }));
  // On main the merge base is HEAD itself, which would call everything reviewed.
  if (!onMain) {
    const base = mergeBase(top, "HEAD", main.ref);
    const tree = base && treeOf(top, base);
    if (tree) out.push({ commit: base, tree, label: `merge-base with ${main.name}` });
  }
  return out;
}

/**
 * The smallest debt from any baseline to `tree`, counted over the paths
 * `counts(path)` accepts — the gate passes its code test, so prose a branch
 * changes is not debt, exactly as it never arms the gate. `risky(path)` names
 * the tier-L paths the smallest diff touches, code or not. Null when no diff
 * could be read.
 */
export function smallestDebt(top, candidates, tree, { counts, risky }) {
  let best = null;
  for (const candidate of candidates) {
    const rows = diffRows(top, candidate.tree, tree);
    if (rows === null) continue;
    const code = rows.filter((row) => counts(row.path));
    let lines = 0;
    for (const row of code) {
      const counted = row.binary ? textLines(top, candidate.tree, tree, row.path) : row.lines;
      if (counted === null) { lines = null; break; } // unreadable is not zero
      lines += counted;
    }
    if (lines === null) continue;
    if (!best || lines < best.lines || (lines === best.lines && code.length < best.files)) {
      // Tier-L paths are read over every changed path: `.github/workflows/*.yml`
      // is not code by extension and is still tier L.
      best = { base: candidate, lines, files: code.length, risky: rows.map((row) => row.path).filter(risky) };
    }
  }
  return best;
}

/**
 * Whether main's committed tree is one review already covered: equal to a
 * reviewed tree (a fast-forward, a squash onto an unmoved main), or to a clean
 * `merge-tree` of main's reviewed commit with a reviewed branch (a merge, a PR
 * merge onto a moved main) — or the parent of a review's snapshot, below.
 * `head` is a commit. Content arriving from origin is not trusted on its
 * own — a push or a PR merge of unreviewed work is the commonest path there is.
 */
export function mainCovered(top, refs, mainLocal, head) {
  const headTree = treeOf(top, head);
  if (!headTree) return false;
  if (refs.some((ref) => ref.tree === headTree)) return true;
  // A review run on main with the work still uncommitted snapshots HEAD plus
  // that work, so the committed tree it started from is its snapshot's parent.
  // Uncommitted work on main stays under the per-turn rule; this only stops a
  // review of it from holding the commit underneath. Main's own ref only: a
  // branch review's snapshot can sit on HEAD having started from it, which
  // says nothing about the commits under HEAD.
  if (refs.some((ref) => ref.branch === mainLocal && ref.snapshot && ref.parent === head)) return true;
  const reviewedMain = refs.find((ref) => ref.branch === mainLocal);
  if (!reviewedMain) return false;
  for (const ref of refs) {
    if (ref.branch === mainLocal) continue;
    const merged = run(top, ["merge-tree", "--write-tree", reviewedMain.commit, ref.commit]);
    if (merged.status === 0 && merged.stdout.split("\n")[0].trim() === headTree) return true;
  }
  return false;
}
