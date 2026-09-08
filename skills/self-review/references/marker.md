# The convergence marker — record fields and where it counts

`converged.sh` and the Stop gate refuse a malformed marker with every defect
named at once, so you do not need this resident. Read it when a refusal names a
field you do not recognise, or when choosing between the two marker forms.

## The record

| field | when | what |
|---|---|---|
| `outcome` | always | `converged`, `not-converged`, or `not-applicable` |
| `rounds` `fixed` `dismissed` `open` | `converged` / `not-converged` | non-negative integers, and `rounds` is at least 1 — a review that ran no round is `not-applicable`; all four are **refused** for `not-applicable` |
| `reason` | `not-applicable` only | `no-code-changed`, `user-declined`, `scratch-only`, `other` |
| `note` | optional; required for `reason=other` | free text — the only free text there is, and it never enters the summary |
| `tier` `adapter` | always | `tier` is `S`, `M` or `L` from `tier.json`; `adapter` from `impact.json` (`adapter=none` when impact.mjs wrote nothing) |
| `intent` | `converged` / `not-converged` | `validated`, `author` or `skipped` — who read the intent **before** the code was written. Required, because an absent field and "nobody read it" would otherwise be the same state. `validated` is refused unless a `self-review-ticket-validator` completed before this task's first code change; the gate checks that order and never the verdict |
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
object holding the record, and the path is `…/self-review/CONVERGED.json` under
a scratch prefix — the session scratchpad, `/tmp`, a `mktemp -d`, or
`~/.claude/self-review/`. A `CONVERGED.json` inside the project is not a marker
(it would clear the gate while leaving no trace). If `<work>` is a bare
`mktemp -d`, put the file in a `self-review/` subdirectory of it. The gate
writes the log line for this form.

The script's *output* is what the gate matches, so quoting or `cat`-ing it never
counts, and the command word has to resolve to this plugin's own copy — a
`converged.sh` from somewhere else is not it. If your permission mode refuses
the command (`auto` has refused `~/…`, `bash …` and `sh …` spellings), use the
file form; that is what it is for.

