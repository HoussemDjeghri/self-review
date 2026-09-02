#!/usr/bin/env bash
# self-review scope — everything changed, as one reviewable bundle.
#
# Usage: scope.sh [--base <git-ref>] [--work <dir>] [path ...]
#
# Inside a git repo it prints a header, the changed-file list, the unified diff
# of the working tree against --base (default HEAD; pass the commit that was
# HEAD before your first commit this turn if you committed), and then every
# UNTRACKED file rendered as a full addition. That last part is the reason this
# script exists: `git diff` never shows a brand-new file, so new modules, docs
# and configs silently escape a diff-based review. Paths narrow the scope.
#
# Outside a git repo, each given path is diffed against the repo IT lives in
# (a skill directory tracked on its own, say), grouped per repo; paths in no
# repo are printed in full (reviewers still Read the live files; this is the
# shared snapshot).
#
# Output is capped at MAX_LINES so a giant scope file can't blow a reviewer's
# context — the cap is announced so nobody mistakes it for the whole change.
set -euo pipefail

# shellcheck source=lib/path.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/path.sh"

MAX_LINES=${SELF_REVIEW_SCOPE_MAX_LINES:-6000}
base="HEAD"
paths=()
work=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "scope.sh: --base needs a ref" >&2; exit 2; }
            base="$2"; shift 2 ;;
    --base=*) base="${1#--base=}"; shift ;;
    --work) [ $# -ge 2 ] || { echo "scope.sh: --work needs a directory" >&2; exit 2; }
            work="$2"; shift 2 ;;
    --work=*) work="${1#--work=}"; shift ;;
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    # A typo'd flag used to fall through to the path list, where it became a
    # "deleted this turn?" entry: a plausible-looking, empty, exit-0 scope, which
    # the round then measures. A file whose name really begins with `-` is passed
    # as `./-name`, which is the trade round.sh and preflight.sh already make.
    -*) echo "scope.sh: unknown option: $1" >&2; exit 2 ;;
    *) paths+=("$1"); shift ;;
  esac
done

[ -z "$work" ] || refuse_if_inside_repo "$work" "scope.sh"

# Given paths are always resolved to their own repo — the cwd's repo is just
# one of the possible answers, and a path outside it must not vanish. With no
# paths, the cwd decides: its repo's whole working tree, or nothing to print.
emit() {
  local root
  if [ ${#paths[@]} -gt 0 ]; then
    emit_by_repo "${paths[@]}"
  elif root=$(git rev-parse --show-toplevel 2>/dev/null); then
    emit_git "$root"
  else
    emit_plain
  fi
}

# Resolve a path's repo from the path itself, as bash 3.2 allows: one
# "root<TAB>abs-path" line per path, sorted so each repo's paths are adjacent.
repo_of() {
  local dir="$1"; [ -d "$dir" ] || dir=$(dirname -- "$dir")
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true
}
emit_by_repo() {
  local p root plain=() grouped=""
  for p in "$@"; do
    root=$(repo_of "$p")
    if [ -n "$root" ]; then grouped+="$root"$'\t'"$(abs_path "$p")"$'\n'; else plain+=("$p"); fi
  done
  local current="" members=()
  while IFS=$'\t' read -r root p; do
    [ -n "$root" ] || continue
    if [ "$root" != "$current" ]; then
      [ -z "$current" ] || emit_git "$current" "${members[@]}"
      current="$root"; members=()
    fi
    members+=("$p")
  done < <(printf '%s' "$grouped" | sort)
  [ -z "$current" ] || emit_git "$current" "${members[@]}"
  [ ${#plain[@]} -eq 0 ] || emit_plain "${plain[@]}"
}

# The changed-file list is derived from the diff, not from `git status`, and
# that is the whole of it: `git status` forgets a change the moment it is
# committed, so after a commit this section went empty while the diff below
# held real lines. The list is not decoration — tier.mjs sizes the round from
# it, round.sh aborts "scope is empty" on it, and coldrun.sh picks entry points
# from it — so all three read nothing and the round measured a change that was
# right there. Untracked files come from `git status`, which is the one thing a
# diff against a commit cannot see.
#
# Rendered in porcelain form (` M path`, `A  path`, `R  old -> new`) because
# impact.mjs parseStatusLine and the awk in coldrun.sh parse this section.
emit_changed_files() {
  local root="$1" base_ok="$2"; shift 2
  if [ "$base_ok" = 1 ]; then
    git -C "$root" diff --name-status --find-renames "$base" -- "$@" | awk -F'\t' '
      NF >= 2 {
        code = substr($1, 1, 1)
        path = (code == "R" || code == "C") ? $2 " -> " $3 : $2
        printf "  %s %s\n", (code == "M" ? " M" : code " "), path
      }'
  fi
  git -C "$root" status --porcelain=v1 --untracked-files=all -- "$@" | awk '/^\?\? /{print "  " $0}'
}

emit_git() {
  local root="$1"; shift
  local branch base_ok=0
  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  # Paths may span repos, and one --base cannot be a commit in all of them:
  # say so in the diff section rather than leave a blank one that reads as
  # "no change". Asked once here; both sections below need the answer.
  ! git -C "$root" rev-parse --verify -q "$base^{commit}" >/dev/null || base_ok=1
  echo "# self-review scope"
  echo "# repo: $root"
  echo "# branch: $branch   base: $base   generated: $(date -u +%FT%TZ)"
  echo
  echo "## Changed files (vs $base + untracked, M=modified A=added D=deleted R=renamed ?=untracked)"
  emit_changed_files "$root" "$base_ok" "$@"
  echo
  echo "## Diff vs $base (tracked files, committed this turn + staged + unstaged)"
  if [ "$base_ok" = 1 ]; then
    git -C "$root" diff --no-color --no-ext-diff "$base" -- "$@"
  else
    echo "# base $base is not a commit in this repo — no diff computed; pass a base that exists here"
  fi
  echo
  echo "## Untracked files (rendered as full additions)"
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # --no-index exits 1 when the files differ, which they always do here.
    git -C "$root" diff --no-color --no-index -- /dev/null "$f" || true
  done < <(git -C "$root" status --porcelain=v1 --untracked-files=all -- "$@" | awk '/^\?\? /{print substr($0,4)}')
}

emit_plain() {
  echo "# self-review scope (not a git repo — full file contents)"
  echo "# generated: $(date -u +%FT%TZ)"
  if [ $# -eq 0 ]; then
    echo "# no paths given: outside git, pass the files you produced as arguments"
    return
  fi
  local f
  for f in "$@"; do
    echo
    echo "==> $f <=="
    if [ -d "$f" ]; then
      find "$f" -type f | sed 's/^/  (dir contains) /'
    elif [ -f "$f" ]; then
      cat -- "$f"
    else
      echo "  (missing — deleted this turn?)"
    fi
  done
}

out=$(emit)
total=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$total" -gt "$MAX_LINES" ]; then
  printf '%s\n' "$out" | head -n "$MAX_LINES"
  echo
  echo "# TRUNCATED: $total lines total, showing $MAX_LINES. Narrow with path arguments, or Read the files directly."
else
  printf '%s\n' "$out"
fi
