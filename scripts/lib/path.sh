# shellcheck shell=bash
# Shared shell path helpers. Sourced, never executed.

# One absolute path with symlinks resolved, so two spellings of the same
# location compare equal. `pwd -P`, not `pwd`: git reports its toplevel
# resolved, and on macOS a temp dir reached as /var/folders really lives at
# /private/var/folders — the logical path never matches. This is the shell half
# of hooks/lib/config.mjs's realpathOr, and it lives here because round.sh
# reimplemented scope.sh's copy of it and a reviewer caught the duplicate
# before a third script could copy it again.
#
# A path whose parent does not exist yet still has exactly one true location,
# so this walks UP to the nearest existing ancestor and re-appends the missing
# tail. Returning the caller's literal spelling instead is what a reviewer
# found: round.sh compares the result against the repo root to refuse a work
# dir inside the tree, and an unresolved path never matched, so
# `--work <repo>/nested/not/yet/created` walked straight through the guard and
# the round scoped its own scope.diff. A resolver that fails open is worse than
# no resolver, because every caller reads its answer as canonical.
abs_path() {
  local target="$1" tail="" parent dir
  case "$target" in */) target="${target%/}"; [ -n "$target" ] || { printf '/\n'; return; } ;; esac
  while :; do
    parent="$(dirname -- "$target")"
    if dir=$(cd "$parent" 2>/dev/null && pwd -P); then
      printf '%s\n' "${dir%/}/$(basename -- "$target")${tail:+/$tail}"
      return
    fi
    # Root reached without finding anything that exists: nothing to resolve
    # against, so hand back the input rather than inventing a location.
    [ "$parent" != "$target" ] || { printf '%s\n' "$1"; return; }
    tail="$(basename -- "$target")${tail:+/$tail}"
    target="$parent"
  done
}

# Refuse a work dir inside the repository under review, and say which one.
#
# It lives here, not in round.sh, because round.sh is not the only caller that
# can make the mistake: SKILL.md keeps running the six scripts by hand as a
# supported fallback, and scope.sh is the one that actually walks `git status`.
# Guarding only the convenient path leaves the documented path unprotected —
# with the work dir inside the tree, scope.sh picks up the round's own
# scope.diff, impact.json and ledger.md as changed files, the loop reviews its
# own paperwork, and the tier climbs every round (observed at 16 changed files
# and a spurious "payments" marker on ledger.md).
refuse_if_inside_repo() {
  local work="$1" who="$2" root work_abs
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 0   # not a repo: nothing to be inside of
  work_abs="$(abs_path "$work")"
  case "$work_abs/" in
    "$root"/*)
      echo "$who: the work dir is inside the repository under review ($work_abs) — the round would scope its own artifacts and climb a tier every round; use the session scratchpad" >&2
      exit 2 ;;
  esac
}
