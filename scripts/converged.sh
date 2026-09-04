#!/usr/bin/env bash
# Marks the self-review loop as finished for the current turn.
#
# The Stop gate (hooks/self-review-gate.mjs, elsewhere in this plugin) refuses
# to end a turn that changed code until it sees a marker AFTER the last change:
# this command's output, or a Write of the typed record to
# <scratch>/self-review/CONVERGED.json. Nothing else clears it — not a prose
# claim of "reviewed", not a finished round that was never marked. So run this
# only once a round came back clean (or with the outcome that says the review
# does not apply), and run nothing that edits files after it.
#
# This is a shim on purpose: its path is what the gate matches at command
# position and what users hold permission rules for, so it stays stable while
# the work lives in marker.mjs beside it.
#
#   converged.sh --converged      --rounds 2 --fixed 3 --dismissed 1 --open 0 --intent author --tier M
#   converged.sh --not-applicable user-declined --note "<the user's words>"
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/marker.mjs" "$@"
