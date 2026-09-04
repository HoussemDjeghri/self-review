<div align="center">

<h1>self-review</h1>

<p><em>Claude finished the change and said "done". Nobody read it.</em></p>
<p><strong>A Stop hook that won't let the turn end until fresh-context reviewers have read the diff, their findings are verified, and the loop converges — or honestly says it didn't.</strong></p>

<p>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-D97757">
  <img alt="version 0.7.6" src="https://img.shields.io/badge/version-0.7.6-191919">
  <img alt="dependencies: node and bash" src="https://img.shields.io/badge/deps-node%20%2B%20bash-D4A27F">
  <img alt="no daemon" src="https://img.shields.io/badge/no-daemon-555">
</p>

</div>

---

"Review your own work before you stop" is exactly the instruction a model under
momentum skips, and re-reading your own diff with the context that produced it
re-derives the same conclusions. So this plugin does what teams do — hand the
change to people who were not there — and makes it non-optional: a Stop hook
reads the transcript, and if the turn changed code without converging, the turn
does not end.

```
[self-review-gate] Files changed this turn but the self-review loop has not
converged, so the turn cannot end yet.
Changed: src/queue.ts, src/queue.test.ts

Now: invoke the Skill tool with skill "self-review:self-review" …
```

What follows is the loop: three fresh subagents read the diff from different
angles, every candidate finding is checked against the file before it is
believed, what survives gets fixed — and then a new round reviews the fixes,
because a fix is a new change that can be wrong.

```
Self-review: converged in 2 rounds — 3 fixed, 1 dismissed, 1 open.
Fixed: src/queue.ts:88 — retry loop swallowed the abort signal
Fixed: src/queue.ts:141 — off-by-one drops the last batch when size % n == 0
Fixed: src/queue.test.ts:12 — test asserted the mock, not the behaviour
Open for you: src/queue.ts:60 — backoff cap is 30s; the API docs say 60s. Raise it?
Checks: `npm test` 214 passed · `tsc --noEmit` clean
```

## What it actually enforces

| | what stops you shipping unread code |
|---|---|
| **A skill you remember to run** | nothing — it runs when the model chooses to |
| **A "please review" line in CLAUDE.md** | nothing — same instruction, same momentum |
| **A linter or CI** | catches what machines catch, after the turn |
| **self-review** | a `Stop` hook reads the transcript: code changed and no convergence marker after the last edit ⇒ the turn is blocked |

Everything else in the plugin exists so that the enforced loop is worth
enforcing:

- **Reviewers have no author context.** Fresh subagents, briefed with the
  intent and the scope diff — never a fork of the session that wrote the code.
  They are read-only by instruction (their prompt forbids writes and keeps Bash
  for running tests and reproductions).
- **A finding needs a concrete failure scenario; a dismissal needs a quoted
  counter-proof.** "Seems fine" does not dismiss. When the author's dismissals
  reach three in a round, an independent verifier rules on all of them — that
  is the author bias the loop exists to counter.
- **Convergence is an outcome, not a counter.** A round that fixed something
  forces another round. The loop continues only while a severity-weighted score
  strictly drops; a plateau, an oscillation (a round calling a previous fix
  wrong), or the round backstop stops it and hands the state to you. It never
  reports "clean" because it ran out of rounds.
- **Convergence is a claim about the code against the stated intent, and never
  a claim that the intent was right.** Every reviewer is told the intent's "out
  of scope on purpose" line is deliberate, so the author's own scoping is exempt
  from review by construction — which is why a correct implementation of a wrong
  ticket converges. The `intent` field on the marker records who read the ticket
  *before* the code existed: `validated` (a `ticket` skill validator did, and the
  gate checked the ordering), `author` (you wrote it and nobody else read it), or
  `skipped`. All three are honest; only `validated` is checked.
- **Prose is not code.** Markdown, JSON/YAML, data and images are exempt from
  the gate by default and reviewed on demand (`/self-review <path>`) — a review
  loop that churns on a README costs tokens and changes nothing.
- **Waiting is one call, and it is bounded.** After spawning reviewers the
  session blocks in a single call on `scripts/wait.mjs`, which reads the
  reviewers' own transcripts and returns when each has reported or gone silent
  past a stale limit — cheaper than being woken once per finisher, and it ends
  rather than hanging when a completion notification is never delivered. A
  second hook denies `ListAgents` / `TaskOutput` polling after two checks,
  because every status check re-reads the whole context to learn nothing.

## Install

```
/plugin marketplace add HoussemDjeghri/plugins
/plugin install self-review@houssem-plugins
```

Restart your sessions so the hooks register. Requires Node ≥ 18 (CI runs 20 on
Linux and macOS) and bash; no daemon, no service of its own — the hooks and
scripts read your transcript, your files and `git`, and that is the whole of it
(`hooks/no-network.test.mjs` fails the build if a shipped hook or script ever
calls `fetch`, imports a network module, or shells out to `curl`). The reviewers are
ordinary Claude Code subagents, so they reach the network exactly as your
session does: their tool grants include `WebFetch` and `WebSearch`, for the
angles that check a cited URL or a documented API.

To remove it: `/plugin uninstall self-review@houssem-plugins`. That takes the
hooks with it; your review log (`~/.claude/self-review/log.jsonl`) and any
config you wrote (`~/.claude/self-review/config.json`) stay until you delete
them. `SELF_REVIEW_GATE=off` turns the gate off for a session without
uninstalling.

## How a turn goes

1. **The gate arms.** Any `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, any shell
   command that writes a file (redirects, `sed -i`, `cp`, `tee`, `git apply`, …)
   on a non-exempt path marks the turn as changed. The gate will also arm on the
   launch of a `self-review-applier` — the one agent type whose dispatch means it
   was told to edit, since an async subagent's result carries no record of what
   it wrote. The skill dispatches one per round (§2e): the lead writes a
   directive per finding and the applier applies them, so the edits land in an
   agent that has no shell and cannot undo the author's work with git.
   Scratch paths never count:
   `/tmp`, the session scratchpad, and Claude's own state directories
   (`~/.claude/projects`, `plans`, `todos`, `sessions`, …) — but not the rest of
   `~/.claude`, so editing your own hooks or skills is reviewed like any code.
2. **Scope.** `scripts/scope.sh` prints the changed-file list, the diff, and
   every untracked file as a full addition (a plain `git diff` shows a new file
   as nothing at all). Works outside git too.
3. **Impact and tier.** `scripts/impact.mjs` searches the tree for what still
   references the symbols the diff moved — broken references first, then tests,
   callers, docs and config — with `code-review-graph` marking edge-confirmed
   callers when a repo has built one. `scripts/tier.mjs` then classifies the
   paths, counts the lines, fires the risk markers (auth, payments, migrations,
   destructive ops, infra, contract breaks) and writes the round's plan: trivial
   changes get one reviewer, standard ones three or four, large or risky ones up
   to six — a hard cap at every tier. Both are deterministic and logged; the
   model may raise the tier on what line counts cannot see, and may lower it
   only with a recorded reason. Large and risky changes also get an independent
   verifier agent ruling on the findings; at the smaller tiers the author
   verifies against the file, and a verifier is spawned when the dismissals
   start piling up.
4. **Memory.** `scripts/findings.mjs prior` pulls the handful of findings past
   reviews of this repository recorded against the files this change touches —
   ten lines, ranked by proximity, never the running review's own — and
   `scripts/brief.mjs` renders each finder's brief from the plan: its angles
   verbatim, the intent, the impact at that row's depth, the prior lines and the
   dismissed ledger, held to a token budget.
5. **Round.** All finders of a round launch in one message, each with a
   different angle (line-level correctness, removed behaviour, cross-file
   ripple, intent fidelity, security, quality, conventions) and a call budget.
   Then the session ends its turn — the cheapest way to wait — and each
   finisher wakes it.
6. **Verify, fix, repeat.** Candidates are checked against the file, fixes are
   minimal, and every verdict is recorded (`findings.mjs record`) — which is
   also what decides whether the loop runs again (`findings.mjs converge`) — so the next
   review of these files starts warm. The next *round* gets the dismissed ledger
   but never the list of what was fixed — so each fix has to pass as correct on
   its own.
7. **Mark.** Convergence is recorded, and only then can the turn end.

## The convergence marker

Two forms; the gate accepts either, after the last change, in a message of its
own:

```
Write <scratchpad>/self-review/CONVERGED.json   {"outcome": "converged", "rounds": 2, "fixed": 3, "dismissed": 1, "open": 1, "tier": "M", "intent": "author"}
```

The file form is the default: a scratch write needs no permission rule, so it
works on any machine and under any permission mode. It counts only under a
scratch path — a `CONVERGED.json` committed in your project is not a marker.

The record is typed, and both forms refuse anything that is not: the outcome is
`converged`, `not-converged` or `not-applicable`, the counts are integers,
`intent` says who read the intent before the code was written (`validated`,
`author` or `skipped`) and is required on any outcome that has counts, and
a turn the loop does not fit is `--not-applicable <reason>` with no counts at
all rather than a review reported as `rounds=0`.

```
<plugin>/scripts/converged.sh --converged --rounds 2 --fixed 3 --dismissed 1 --open 1 --tier M --intent author
```

`<plugin>` is the installed plugin directory — `${CLAUDE_PLUGIN_ROOT}` when
Claude Code expands it for you. The script form is there for humans and for work
dirs outside scratch. The gate matches the script's *output*, so quoting or
`cat`-ing it never counts as a marker, and the command has to resolve to this
plugin's own copy.

The summary the record serialises to is `key=value` tokens — `outcome=` first,
then the counts, then `reason=` for a not-applicable turn and the
`tier`/`adapter`/`intent` labels (`forced=S|M|L` and `computed=S|M|L` join them
when the tier was overridden) — so `scripts/audit.mjs` can count reviews by tier
and adapter rather than parse prose. A `note` is the one free-text field and
never enters the summary. Either form appends a line to `~/.claude/self-review/log.jsonl` — the file form
logged by the gate, the script form by itself — and that log records
`not-converged` runs as honestly as clean ones.

## Configuration

Defaults ship in `config/defaults.json`; override per user in
`~/.claude/self-review/config.json` (or `$SELF_REVIEW_CONFIG`). Objects merge,
arrays replace — so you can shorten an exemption list, not only extend it.

```json
{
  "exempt": { "extensions": [".md", ".json", ".yaml", ".png"], "names": ["license", ".gitignore"] },
  "gate": { "maxReminders": 2 },
  "pollGuard": { "maxChecks": 2 },
  "tier": { "l": { "minLines": 300 }, "riskPaths": { "payments": ["billing", "subscriptions"] } },
  "impact": { "adapter": "auto", "maxLines": 80, "maxRefsPerSymbol": 200 },
  "brief": { "maxTokens": 2800 },
  "preflight": { "skip": [] }
}
```

A repository can carry its own `.self-review.json` at its root, merged on top of
your config for anyone reviewing changes in it. It is **default closed and
additive only**: the one thing a repository may contribute is extra *words* for
the risk markers (`tier.riskPaths`, `tier.riskContent`), appended to the lists
you already have — its own word for "payments", never a shorter list. Every
other setting is the reviewer's.

That is narrower than it started, and the narrowing is the story: a repository
is reviewed by whoever clones it, so the attacker in this threat model is the
repository. This plugin's own review loop found eight ways a repo could use its
config to make its review weaker — hiding files from the scan, emptying a marker
list, raising the bar for the deep tier out of reach, cutting the finder budget.
Each was patched, and each patch left a neighbouring door open, so the surface
is now an allow-list: a new setting is closed to repositories until someone
decides it can only add work. The words it may add are matched as literal text,
not as regexes, for the same reason — a checked-in `(a+)+$` is a way to hang the
machine reviewing it. Your own config keeps the full regex.

An override whose type does not match the default is ignored with a warning on
stderr (visible under `--debug`), and an override file that is unreadable or is
not an object is ignored whole, leaving the shipped defaults in force. If the
shipped `config/defaults.json` is itself missing or corrupt, the gate falls back
to gating *every* file: a broken install costs you a review, never skips one.
`gate.maxReminders` is the escape hatch — after that many blocks in a row the
gate releases the turn with a notice rather than trapping the session. To turn
the gate off for a session entirely, set `SELF_REVIEW_GATE=off`.

## What ships today, and what doesn't

Shipping: the gate, the poll guard, the skill and its reviewer agents, scope,
salvage and wait scripts, the cost cutters (`brief.mjs` builds a round's briefs,
`preflight.sh` runs the project's own checks first, `audit.mjs` reports what a
review cost), the context pair (`impact.mjs` computes the blast radius,
`tier.mjs` turns it into a tier and an angle plan), per-repo memory
(`findings.mjs` records every verdict and feeds the matching ones back into the
next review's briefs), config with a per-repo layer, and its own test suite.

Not yet: the eval corpus
and runner, and the measured numbers that come from them.

**On `code-review-graph`:** the impact script uses it only when the repository
already has a `.code-review-graph/` index and the binary is on your `PATH` — it
never builds one for you, and its authors' own caveat applies: on small repos
and single-file diffs the graph costs more than it returns. The name search
underneath it always runs, so the analysis has no language support to fall
outside of.

**On cost numbers:** the loop is budgeted — reviewer models and effort are
pinned, every agent has a call budget, and the session waits inside one bounded
call instead of polling or paying a turn per finisher. `scripts/audit.mjs` now measures it, per review, from the
transcripts. The numbers stay out of this README until they come from more than
one machine's sessions and from the eval corpus (§4.7) rather than from the
project's own development, because a single session's figures published as
typical would be exactly the kind of unverified claim this plugin exists to
catch. It also reports, per round, how much the angles overlapped — the share of one finder's candidates that another finder of the same round also filed — because merging two angles to save an agent is a change that has to be measured over several reviews first. Run it on your own sessions: `node scripts/audit.mjs`.

## License

MIT — see [LICENSE](LICENSE).
