#!/usr/bin/env bash
# treecheck — did the working tree change while the reviewers ran?
#
# Usage: treecheck.sh --work <dir> --round <n> [--root <repo>] [--record]
#
# `--record` writes the snapshot round.sh takes before it prints the briefs;
# the default compares the current state against it and names what moved.
#
# It exists because a read-only finder ran the writer it was reviewing against
# the real repository and then `git checkout -- <files>` to undo it. The undo is
# the destructive half: its blast radius is every uncommitted change to those
# files, which is the author's unsaved work, and nothing in the transcript says
# so. Prose in the agent files asks reviewers not to; this does not depend on
# them obeying. It is detection, not prevention — but before the reviewers run,
# `--record` also commits the dirty tree to an object nobody's working tree can
# see (`refs/self-review/<review>/round-<n>`), so a silent loss becomes a named
# one AND a reversible one: the message below carries the restore command. That
# ordering is the design decision recorded as F9 — no command parser can decide
# what mutates a tree, but one git call makes the mutation recoverable however
# it was spelled.
#
# Silent when nothing moved: every line printed here lands in the lead's
# context and is paid for again on every later turn.
#
# Exit: 0 whether or not the tree moved — a detector that breaks the `&&` chain
# it is run in gets dropped from the chain; 2 usage, or no recorded snapshot to
# compare against, which is a thing the caller must hear rather than read as
# "clean".
set -euo pipefail

die() { echo "treecheck.sh: $*" >&2; exit 2; }

work=""; round=""; root=""; record=0
while [ $# -gt 0 ]; do
  case "$1" in
    --work)   [ $# -ge 2 ] || die "--work needs a directory"; work="$2"; shift 2 ;;
    --round)  [ $# -ge 2 ] || die "--round needs a number";   round="$2"; shift 2 ;;
    --root)   [ $# -ge 2 ] || die "--root needs a directory"; root="$2"; shift 2 ;;
    --record) record=1; shift ;;
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$work" ]  || die "--work is required"
[ -n "$round" ] || die "--round is required"
case "$round" in ''|*[!0-9]*) die "--round needs a positive integer, got: $round" ;; esac
[ "$round" -ge 1 ] || die "--round needs a positive integer, got: $round"
[ -n "$root" ] || root="$(pwd)"

# Both halves in one place, because the recorder and the comparer have to agree
# on the format and two copies of it would drift into a false "unchanged".
# The stash list is here because a `git stash` reads as a perfectly clean tree:
# it hides the change rather than deleting it, and a reviewer tidying up after
# itself is exactly the case this has to catch.
snapshot() {
  if ! git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    echo "# not a git repository: $root"
    return
  fi
  git -C "$root" status --porcelain=v1 --untracked-files=all
  echo "# git stash list"
  git -C "$root" stash list
}

# The ref holding round N's snapshot. Derived from the work dir so a second
# review running concurrently in another session cannot overwrite this one's,
# and stable across a re-run of the same round so the comparer finds it without
# being told.
snapshot_ref() {
  local id
  id="$(printf '%s' "$work" | git hash-object --stdin | cut -c1-8)"
  echo "refs/self-review/$id/round-$round"
}

# Commit the dirty tree — tracked modifications and untracked non-ignored files,
# exactly scope.sh's set — without touching anything the author can see: not the
# working tree, not the index, not HEAD, not `git status`. The real index is
# COPIED first so `add -A` keeps its stat cache and costs O(change) rather than
# O(repository). The copy is only that optimisation: git reads a GIT_INDEX_FILE
# that does not exist as an empty index and rebuilds it, so a failed copy is
# slower and still correct. A copy that half-succeeds is not — which is why
# nothing here creates the destination on failure.
#
# A ref rather than `git stash create`'s dangling object: stash create drops
# untracked files and leaves the commit unreferenced, where gc eats it. What is
# NOT saved: ignored files (`.env`, `node_modules`), the staged/unstaged split,
# and anything that destroys `.git` itself — all outside the careless-reviewer
# model this is for.
record_snapshot() {
  local idx tree commit parent
  idx="$work/round-$round/snapshot-index"
  # --git-path answers relative to $root, and this script does not run there:
  # round.sh passes --root and never cd's, so a lead working from a
  # subdirectory would copy nothing and hand git a path of its own invention.
  # On git < 2.31 --path-format is unknown, the copy is skipped, and the
  # snapshot degrades to the slow-but-correct rebuild.
  cp "$(git -C "$root" rev-parse --path-format=absolute --git-path index 2>/dev/null)" "$idx" 2>/dev/null || true
  GIT_INDEX_FILE="$idx" git -C "$root" add -A || { rm -f "$idx"; return 1; }
  tree="$(GIT_INDEX_FILE="$idx" git -C "$root" write-tree)" || { rm -f "$idx"; return 1; }
  # An unborn HEAD has no parent to give, and a repository with no commits is
  # still a repository whose untracked work can be destroyed.
  parent="$(git -C "$root" rev-parse --verify -q HEAD || true)"
  commit="$(git -C "$root" commit-tree "$tree" ${parent:+-p "$parent"} \
    -m "self-review round $round snapshot")" || { rm -f "$idx"; return 1; }
  git -C "$root" update-ref "$(snapshot_ref)" "$commit" || { rm -f "$idx"; return 1; }
  rm -f "$idx"
}

# Snapshots are worth keeping while the work they protect is still fresh and
# worth nothing after. A week is long enough to notice a loss.
prune_snapshots() {
  local ref ts now
  now="$(date +%s)"
  git -C "$root" for-each-ref --format='%(refname) %(committerdate:unix)' refs/self-review/ 2>/dev/null |
    while read -r ref ts; do
      [ -n "$ts" ] || continue
      [ "$((now - ts))" -gt 604800 ] && git -C "$root" update-ref -d "$ref" || true
    done
}

before="$work/round-$round/tree-before.txt"
if [ "$record" -eq 1 ]; then
  mkdir -p "$(dirname "$before")"
  # Never re-record the witness: re-running a round is a real recovery path (a
  # pre-flight failure fixed, the scope re-captured), and a second `--record`
  # would make the post-damage tree the baseline — erasing the evidence of
  # anything a reviewer of the first attempt wrote, silently and permanently.
  # The first snapshot is the one that answers "what did the tree look like
  # before reviewers saw it", so it wins.
  if [ -e "$before" ]; then
    echo "treecheck.sh: keeping round $round's original tree-before.txt — a re-record would erase what it witnessed"
  else
    snapshot > "$before"
  fi
  # The ref is a separate resource with the opposite idempotency, so it gets its
  # own gate rather than riding on the witness's. Overwriting a ref that exists
  # would replace good content with the damaged tree; writing one that never got
  # written costs nothing and is the entire recovery. A first attempt that
  # failed is therefore retried here — and warns again if it fails again, rather
  # than the round proceeding unprotected in silence.
  #
  # Best-effort by design, and loudly so: without the ref a reviewer's write is
  # still detected, it just cannot be undone, and that is worth a warning rather
  # than a round that refuses to start.
  if git -C "$root" rev-parse --git-dir >/dev/null 2>&1 \
    && ! git -C "$root" rev-parse --verify -q "$(snapshot_ref)" >/dev/null 2>&1; then
    prune_snapshots
    # Silent on success, like every other path here: the ref's name is only
    # useful when there is damage to undo, and that is where it is printed.
    if ! record_snapshot; then
      echo "treecheck.sh: could not save the working tree to a snapshot ref — a reviewer's write will be named but not reversible" >&2
    fi
  fi
  exit 0
fi

[ -f "$before" ] || die "no tree-before.txt for round $round — round.sh records it before the briefs; without it a reviewer's write cannot be detected, so this check did not run"

now="$(snapshot)"
before_text="$(cat "$before")"
[ "$now" != "$before_text" ] || exit 0

# The two halves are compared separately because they answer differently: the
# status names paths, and the stash list names nothing a path could stand for.
STASH_HEADER="# git stash list"
status_of() { sed "/^$STASH_HEADER\$/,\$d"; }
stash_of() { sed -n "/^$STASH_HEADER\$/,\$p"; }

# The paths that moved, not the whole status: this line goes to the user
# verbatim and has to be readable. `|| true` on diff and awk instead of grep
# because both report "no output" as a failing exit, and under pipefail that
# would abort the script exactly when it has something to say.
#
# The awk filter drops the one `#` line snapshot() can emit itself, by its exact
# text — a blanket `!/^#/` also dropped any changed path whose name begins with
# `#`, leaving the message correctly reporting a change it could not name.
paths="$({ diff <(printf '%s\n' "$before_text" | status_of) <(printf '%s\n' "$now" | status_of) || true; } \
  | sed -n 's/^[<>] //p' \
  | sed -e 's/^[ MADRCU?!][ MADRCU?!] //' -e 's/^.* -> //' \
  | awk -v notrepo="# not a git repository: $root" 'NF && $0 != notrepo' \
  | sort -u \
  | tr '\n' ' ' \
  | sed -e 's/ *$//')"
[ "$(printf '%s\n' "$before_text" | stash_of)" = "$(printf '%s\n' "$now" | stash_of)" ] \
  || paths="${paths:+$paths, }git stash list"

message="treecheck.sh: the working tree changed while reviewers ran — $paths; a reviewer wrote or reverted something"
# The restore is only offered when the ref is actually there to restore from:
# an offer that fails when taken is worse than no offer.
if git -C "$root" rev-parse --verify -q "$(snapshot_ref)" >/dev/null 2>&1; then
  message="$message. Put it back with: git -C $(printf '%q' "$root") restore --source=$(snapshot_ref) -- ."
fi
echo "$message"
