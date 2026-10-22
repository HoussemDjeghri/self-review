# The convergence marker — record fields and where it counts

`converged.sh` and the Stop gate refuse a malformed marker with every defect
named at once, so you do not need this resident. Read it when a refusal names a
field you do not recognise, or when choosing between the two marker forms.

## The record

| field | when | what |
|---|---|---|
| `outcome` | always | `converged`, `not-converged`, or `not-applicable` |
| `rounds` `fixed` `dismissed` `open` | `converged` / `not-converged` | non-negative integers, and `rounds` is at least 1 — a review that ran no round is `not-applicable`; all four are **refused** for `not-applicable`. `open` = questions put to the user in the report; an unfixed CONFIRMED is not open: CONFIRMED/design → recorded `unfixed`, the review ends `not-converged`; PLAUSIBLE/design → `open`. The gate does not check `open` as a convergence condition, but counts it with `fixed` and `dismissed` toward the candidate total that requires a verifier (more than 4) |
| `reason` | `not-applicable` only | `no-code-changed`, `user-declined`, `scratch-only`, `other` |
| `note` | optional; required for `reason=other` | free text — the only free text there is, and it never enters the summary |
| `tier` `adapter` | always | `tier` is `S`, `M` or `L` from `tier.json`; `adapter` from `impact.json` (`adapter=none` when impact.mjs wrote nothing) |
| `intent` | `converged` / `not-converged` | `validated`, `author` or `skipped` — who read the intent **before** the code was written. Required, because an absent field and "nobody read it" would otherwise be the same state. `validated` is refused unless a `self-review-ticket-validator` completed before this task's first code change; the gate checks that order and never the verdict |
| `review` | optional, `converged` / `not-converged` | the 8-hex id `round.sh --new-review` printed as `review:` (`converged.sh --work <work>` derives it; by hand, recover it with `printf '%s' <work> \| git hash-object --stdin \| cut -c1-8`, run in the directory round 1 ran in — scope.json's `cwd` — because the id follows that repository's object format). Pass it always; the gate reads it only in a repository you opted into branch review, where it finds the tree the review's last round read (its snapshot ref) and records that tree as reviewed |
| `forced` `computed` | when you overrode the tier | both `S`, `M` or `L` from `tier.json`, and written together — one alone does not say what was overridden |

Anything that does not validate is **refused** — by the script in the same
turn, or by the gate with every defect named at once. A refusal is not a
reminder to review; it means the review is done and the record is malformed.
Fix the named fields and write it once more.

**`not-applicable` is the honest end of a turn the loop does not fit** —
scratch files only, the user declined, or the gate armed on something that is
not really a change. Name it; do not write a review that did not happen:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/converged.sh" --not-applicable user-declined --note "<their-exact-words>"
```

It takes no counts, on purpose. `rounds=0` is how 29 of the first 112 markers —
a quarter of every marker ever written — recorded a non-review as a converged
one, and every per-tier average carried them.

## Where it counts

The file form counts only when the Write succeeded, the body parses as a JSON
object holding the record, and the path is `…/self-review/CONVERGED.json` or
`…/self-review/review-<k>/CONVERGED.json` (the review dir `round.sh --new-review`
printed) under a scratch prefix — the session scratchpad, `/tmp` or `$TMPDIR` (where `reviews-dir.sh` and `mktemp -d` put theirs), or
`~/.claude/self-review/`. A `CONVERGED.json` inside the project is not a marker
(it would clear the gate while leaving no trace). If `<work>` is a bare
`mktemp -d`, put the file in a `self-review/` subdirectory of it. The gate
writes the log line for this form.

The script's *output* is what the gate matches, so quoting or `cat`-ing it never
counts, and the command word has to resolve to this plugin's own copy — a
`converged.sh` from somewhere else is not it. If your permission mode refuses
the command (`auto` has refused `~/…`, `bash …` and `sh …` spellings), use the
file form; that is what it is for.

## What a review leaves behind

Two files in `<work>` (the `review-<k>/` dir `round.sh --new-review` printed)
are for other tools to read; everything else there is internal and may change
without notice — the ledger and every `round-<n>/` dir, including the
`scope-args`, `scope-cwd` and `tier.json` inside them.

- `CONVERGED.json` — the record above. It is there for the file form, and for
  the script form when `converged.sh` is given `--work <work>`; that form writes
  it before printing the token, and prints no token when the write fails.
  `--work` must name a review dir — one round 1 wrote `scope.json` into — or
  the marker is refused, whatever the outcome; a round 1 that refused left no
  review dir, so its marker is written without `--work`.
- `scope.json` — written by `round.sh` once round 1 passes its refusals, never
  by the author:
  `{"v": 1, "base": "<full commit sha>" | null, "paths": ["…"], "cwd": "/abs/dir"}`.
  `base` is the commit `--base` resolved to in `cwd`'s repository. `null` means
  no `--base` was given — the review covered changes against `HEAD`, staged,
  unstaged and untracked — or it resolved to nothing, when only untracked files
  were in scope. `base` is resolved in `cwd`'s repository only, so it is also
  `null` when `cwd` is outside any repository while the paths are inside one:
  `null` never proves that no `--base` was asked for. `cwd` is the directory round 1 ran in, symlinks resolved.
  `paths` are round 1's path arguments verbatim — a relative one resolves
  against `cwd`, an absolute one stays absolute; empty means no narrowing: every
  file the base comparison found.
  Later rounds replay this scope, but a review with a path list may widen to
  files changed since round 1 (printed as `scope +:`), which `scope.json` does
  not list; a review with no path list never widens.
  `v` changes with any incompatible change to the format. A review dir with no
  `scope.json` predates it or never got past round 1's refusals: its scope is
  unknown, not empty.

The two describe the same review only inside one `review-<k>/`; a marker
written to `<reviews>/CONVERGED.json`, outside a review dir, has no scope.
