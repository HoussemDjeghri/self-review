#!/usr/bin/env bash
# reviews-dir — the `<reviews>` base for a session that has no scratchpad (a
# headless `claude -p`), derived from the session id so the ticket and every
# round get the same path without anyone having to remember it.
#
# Usage: reviews-dir.sh    → prints <dir>/self-review/
#
# `mktemp -d` once and remembering the path was the rule before, and a model
# loses what it is told to remember across a compaction — the ticket's intent
# then sits under one base and the review under another
# (headless-reviews-dir-answer.md). The id is stable for a session's life,
# `--resume` included (measured 2026-10-15); the base is `$TMPDIR`, so the
# guarantee also assumes `$TMPDIR` does not change between the session's shell
# calls — a call with another TMPDIR gets another base. There is deliberately no fallback:
# a second way to the path is a second address. The path is predictable, so it
# is checked on every call, not only when created: a real directory, ours,
# mode 700 — anything else in a shared /tmp is someone else's.
#
# Exit: 0 printed; 2 no usable session id, or the directory is not ours.
set -euo pipefail

die() { echo "reviews-dir.sh: $*" >&2; exit 2; }

case "${1:-}" in -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
[ $# -eq 0 ] || die "takes no arguments"

id="${CLAUDE_CODE_SESSION_ID:-}"
[[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || die "CLAUDE_CODE_SESSION_ID is unset or not a session id — run this from a Claude Code session's Bash tool"
tmp="${TMPDIR:-/tmp}"
dir="${tmp%/}/self-review-$id"
mkdir -m 700 "$dir" 2>/dev/null || true
[ -d "$dir" ] && [ ! -L "$dir" ] || die "$dir is not a directory — refusing it"
[ -O "$dir" ] || die "$dir is not owned by you — refusing it"
mode="$(stat -c %a "$dir" 2>/dev/null || stat -f %Lp "$dir")"
[ "$mode" = 700 ] || die "$dir has mode $mode, not 700 — refusing it"
mkdir -p "$dir/self-review"
printf '%s/self-review/\n' "$dir"
