<div align="center">

<img src="assets/logo.png" width="132" alt="self-review logo: a terminal window circled by a review loop, with a check mark where the loop closes">

<h1>self-review</h1>

<p><em>Claude finished the change and said "done". Nobody read it.</em></p>
<p><strong>A Stop hook that won't let the turn end until fresh reviewers have read the diff, their findings are checked, and the loop converges — or honestly says it didn't.</strong></p>

<p>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-D97757">
  <img alt="version 0.10.2" src="https://img.shields.io/badge/version-0.10.2-191919">
  <img alt="dependencies: node and bash" src="https://img.shields.io/badge/deps-node%20%2B%20bash-D4A27F">
  <img alt="no daemon" src="https://img.shields.io/badge/no-daemon-555">
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#what-you-see">What you see</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#why-you-can-trust-the-result">Why trust it</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#reference">Reference</a>
</p>

</div>

---

"Review your own work before you stop" is exactly the instruction a model under
momentum skips — and re-reading a diff with the context that produced it
re-derives the same conclusions. So self-review does what teams do: it hands the
change to reviewers who were not there, and makes that non-optional.

| | what stops unread code from shipping |
|---|---|
| A skill you remember to run | nothing — it runs when the model chooses to |
| A "please review" line in CLAUDE.md | nothing — same instruction, same momentum |
| A linter or CI | catches what machines catch, after the turn |
| **self-review** | a `Stop` hook reads the transcript: code changed and no convergence marker after the last edit ⇒ **the turn is blocked** |

## Install

```
/plugin marketplace add HoussemDjeghri/plugins
/plugin install self-review@houssem-plugins
```

Restart your sessions so the hooks register. That's it — the next turn that
changes code is reviewed.

**Requires** Claude Code 2.1.292 or later (the reviewer calls pass a per-call
`effort`), Node ≥ 18 (CI runs 20 on Linux and macOS) and bash. No daemon, no
service: the hooks and scripts read your transcript, your files and `git`, and
nothing else. A shipped test (`hooks/no-network.test.mjs`) fails the build if a
hook or script ever calls `fetch`, imports a network module, or shells out to
`curl`. The reviewers are ordinary Claude Code subagents, so they reach the
network exactly as your session does — `WebFetch` and `WebSearch` are in their
tool grants for the angles that check a cited URL or a documented API.

## What you see

A turn that changed code and tries to stop without a review is sent back:

```
[self-review-gate] Files changed this turn but the self-review loop has not
converged, so the turn cannot end yet.
Changed: src/queue.ts, src/queue.test.ts

Now: invoke the Skill tool with skill "self-review:self-review" …
```

The loop runs, and the turn ends with a report like this:

```
Self-review: converged in 2 rounds — 3 fixed, 1 dismissed, 1 open.
Fixed: src/queue.ts:88 — retry loop swallowed the abort signal
Fixed: src/queue.ts:141 — off-by-one drops the last batch when size % n == 0
Fixed: src/queue.test.ts:12 — test asserted the mock, not the behaviour
Open for you: src/queue.ts:60 — backoff cap is 30s; the API docs say 60s. Raise it?
Checks: `npm test` 214 passed · `tsc --noEmit` clean
```

A loop that does not converge ends the same way, reported as `not-converged`
with what is still open, and hands the decision to you.

Everyday controls:

| you want to… | do this |
|---|---|
| review a doc, config or plan on demand | `/self-review <path>` |
| write the ticket before the code, and have it checked | `/ticket` |
| switch the gate off for one session | launch with `SELF_REVIEW_GATE=off claude` |
| see what your reviews cost | `node <plugin>/scripts/audit.mjs` |

`<plugin>` is the installed plugin directory — `${CLAUDE_PLUGIN_ROOT}` inside
Claude Code.

## How it works

```
 code changed ─▶ Stop gate blocks ─▶ round: fresh finders read the diff
                                        │
                     ┌──────────────────┘
                     ▼
        verify each finding against the file ─▶ apply the fixes
                     │
                     ▼
       fixed something? ── yes ─▶ next round reviews the fixes
                     │
                     no
                     ▼
        converged marker ─▶ the turn may end
```

1. **The gate arms.** Any `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, or any shell
   command that writes a file (redirects, `sed -i`, `cp`, `tee`, `git apply`, …),
   on a non-exempt path marks the turn as changed. So does launching a
   `self-review-applier`, the one agent type that is dispatched to edit. Scratch
   paths never count: `/tmp`, the session scratchpad, and Claude's own state
   directories (`~/.claude/projects`, `plans`, `todos`, `sessions`, …) — but the
   rest of `~/.claude` does, so editing your own hooks or skills is reviewed like
   any code.
2. **Scope, impact and tier.** The scripts collect the diff (untracked files
   included, outside git too), search the tree for what still references the
   symbols it moved, and size the review. Trivial changes get one reviewer,
   standard ones three or four, large or risky ones up to six — a hard cap at
   every tier. Risk markers (auth, payments, migrations, destructive operations,
   infra, contract breaks) raise the tier. The model may raise it further for
   what line counts cannot see, and may lower it only with a recorded reason.
3. **A round.** All finders launch at once, each from a different angle —
   line-level correctness, removed behaviour, cross-file ripple, intent fidelity,
   security, quality, conventions — and each with a call budget. The session
   then waits in one bounded call (`scripts/wait.mjs`) until every reviewer has
   reported or gone silent.
4. **Verify, fix, repeat.** Every candidate is checked against the file before it
   is believed. What survives is fixed by an applier agent that has no shell,
   so it cannot undo your work with git. A round that fixed anything forces
   another round, because a fix is a new change that can be wrong. The next
   round gets the dismissed ledger but never the list of what was fixed, so
   each fix has to pass as correct on its own.
5. **Mark.** Convergence is recorded, and only then can the turn end.

Past reviews of a repository feed the next one: every verdict is recorded, and
the findings that touch the files you changed are handed to the next review's
reviewers.

## Why you can trust the result

- **Reviewers have no author context.** They are fresh subagents briefed with
  the intent and the diff — never a fork of the session that wrote the code. They
  are read-only by instruction, and keep Bash only for running tests and
  reproductions.
- **A finding needs a concrete failure; a dismissal needs quoted proof.** "Seems
  fine" dismisses nothing. Large or risky changes always get an independent
  verifier; at smaller tiers the author verifies against the file, and a single
  dismissal or more than four candidates brings in the verifier — the gate
  refuses a converged marker that has none behind it.
- **Convergence is an outcome, not a counter.** The loop continues only while a
  severity-weighted score strictly drops. A plateau, an oscillation (a round
  calling a previous fix wrong) or the round backstop stops it and hands the
  state to you. It never reports "clean" because it ran out of rounds.
- **It checks the code against the intent, not the intent itself.** Reviewers
  leave alone a deliberate cut that only narrows the ask, and flag one that
  contradicts the request or a governing document the intent cites — so a
  correct implementation of a wrong ticket still converges. The marker's
  `intent` field says who read the ticket *before* the code existed: `validated`
  (a `/ticket` validator did, and the gate checked the order), `author` (only
  you), or `skipped`. All three are honest; only
  `validated` is checked.
- **Prose is not code.** By default, Markdown, JSON/YAML, data and images don't
  arm the gate — a loop that churns on a README costs tokens and changes nothing. Review them on
  demand with `/self-review <path>`.
- **Waiting is cheap and bounded.** One call waits for all reviewers, and it ends
  rather than hangs when a notification never arrives. A second hook denies
  `ListAgents` / `TaskOutput` polling after two checks, because every status
  check re-reads the whole context to learn nothing.

## Configuration

Defaults ship in `config/defaults.json`. Override them per user in
`~/.claude/self-review/config.json` (or `$SELF_REVIEW_CONFIG`). Objects merge and
arrays replace, so you can shorten an exemption list, not only extend it.

```json
{
  "exempt": { "extensions": [".md", ".json", ".yaml", ".png"], "names": ["license", ".gitignore"], "paths": ["~/code/app/prototypes/**"] },
  "gate": { "maxReminders": 2 },
  "pollGuard": { "maxChecks": 2 },
  "tier": { "l": { "minLines": 300 }, "riskPaths": { "payments": ["billing", "subscriptions"] } },
  "impact": { "adapter": "auto", "maxLines": 80, "maxRefsPerSymbol": 200 },
  "brief": { "maxTokens": 2800 },
  "preflight": { "skip": [] }
}
```

- **`exempt.paths`** takes absolute globs only (`/…` or `~/…`); anything else is
  dropped with a warning on the hook's stderr (visible with `claude --debug`),
  because a relative glob in a global file would exempt that path in every
  repository. `*` and `?` stay inside one path segment and `**` crosses them, so
  `~/code/app/prototypes/**` covers everything below `prototypes/` and
  `~/code/app/prototypes/*` only its direct children. An exempt path stops the
  gate arming and nothing else: a review whose scope includes it still reads it.
- **`gate.maxReminders`** is the escape hatch: after that many blocks in a row the
  gate releases the turn with a notice rather than trapping the session.
- **Bad config fails safe.** An override of the wrong type is ignored with a
  warning; an override file that is unreadable or not an object is ignored
  whole. If the shipped `config/defaults.json` is itself missing or corrupt,
  the gate gates *every* file: a broken install costs you a review, never skips
  one.

<details>
<summary><strong>A repository's own <code>.self-review.json</code> — additive only</strong></summary>

<br>

A repository can carry `.self-review.json` at its root, merged on top of your
config for anyone reviewing changes in it. It is **default closed and additive
only**: the one thing a repository may contribute is extra *words* for the risk
markers (`tier.riskPaths`, `tier.riskContent`), appended to your lists — its own
word for "payments", never a shorter list. Every other setting is yours. The Stop
gate loads your config alone, so a repository's file shapes a round's tier and
never when the gate arms or what releases it. The one exception can only add
holds: in a repository you opted into branch review, its `riskPaths` words count
toward the tier-L path test that holds a branch.

Why so narrow: a repository is reviewed by whoever clones it, so in this threat
model the attacker is the repository. This plugin's own review loop found eight
ways a repository could use its config to weaken its own review — hiding files
from the scan, emptying a marker list, raising the deep-tier bar out of reach,
cutting the finder budget. Each patch left a neighbouring door open, so the
surface is now an allow-list: a new setting stays closed to repositories until
someone decides it can only add work. The added words are matched as literal
text, not regexes, because a checked-in `(a+)+$` is a way to hang the machine
reviewing it. Your own config keeps full regexes.

</details>

<details>
<summary><strong>Branch review — review a long branch in larger pieces (opt-in, per repository)</strong></summary>

<br>

By default every code-writing turn has to converge before it ends. Opt a
repository in from **your** config (a repository's own file cannot):

```json
{ "repos": { "<id>": { "branchDebt": { "maxLines": 500 }, "tier": { "riskPaths": { "protected": ["^src/core/"] } } } } }
```

`<plugin>/scripts/branch-debt.mjs --id` prints the id (the repository's hashed
`origin` URL, so its clones and worktrees share it); `<plugin>/scripts/branch-debt.mjs`
prints the branch, its reviewed baseline and its debt.

In that repository, on a branch, a code turn may end unmarked while the branch's
unreviewed code — `git diff` from the last reviewed tree to the worktree, prose
not counted — stays within `maxLines` and touches no tier-L path (`riskPaths`,
including the `protected` category, which escalates any one-line edit). Past
that the gate holds, and names the commit to review from. A converged marker
carrying the review's `review` id records the tree its last round read as
reviewed, in `refs/self-review-reviewed/<branch>` — refs that clone, fetch and
push never carry.

- On main nothing is deferred: a Stop on main whose committed tree no review
  covers — an unreviewed merge, a push from elsewhere — is held.
- Only writes inside the repository defer. A turn that also wrote elsewhere, or
  whose subagent or shell writes the gate cannot place, is gated per turn.
  Untracked files your `.gitignore` hides are not measured.
- `branchDebt.main` overrides `origin/HEAD` as main. The first Stop after opting
  in records main's tip as reviewed, so earlier history is not debt.
- **Opt out** by deleting the `repos.<id>` entry. **Reset** the baselines by
  deleting the refs —
  `git for-each-ref --format='%(refname)' refs/self-review-reviewed/ | xargs -n1 git update-ref -d`
  — and the next Stop adopts main's tip again.

Known limit, the same class as `SELF_REVIEW_GATE=off`: a repository's checked-in
`.claude/settings.json` can set `env`, so it can point `SELF_REVIEW_CONFIG` at a
file that opts it in. The gate strips `GIT_*` variables from its own git calls
for the same reason, so that hole is not also a forged-refs hole.

</details>

## Reference

<details>
<summary><strong>The convergence marker</strong></summary>

<br>

The gate accepts either of two forms, written after the last change, in a
message of its own. The file form is the default — a scratch write needs no
permission rule, so it works on any machine and under any permission mode:

```
Write <scratchpad>/self-review/CONVERGED.json   {"outcome": "converged", "rounds": 2, "fixed": 3, "dismissed": 1, "open": 1, "tier": "M", "intent": "author"}
```

It counts only under a scratch path — a `CONVERGED.json` committed in your
project is not a marker. The script form is for humans and for work dirs outside
scratch:

```
<plugin>/scripts/converged.sh --converged --rounds 2 --fixed 3 --dismissed 1 --open 1 --tier M --intent author
```

`<plugin>` is the installed plugin directory (`${CLAUDE_PLUGIN_ROOT}` when Claude
Code expands it). The gate matches the script's *output*, so quoting or
`cat`-ing it never counts, and the command has to resolve to this plugin's own
copy.

The record is typed, and both forms refuse anything that is not:

- `outcome` is `converged`, `not-converged` or `not-applicable`; the counts are
  integers.
- `intent` (`validated`, `author` or `skipped`) is required on any outcome that
  has counts.
- A turn the loop does not fit is `--not-applicable <reason>` with no counts,
  never a review reported as `rounds=0`.
- The summary is `key=value` tokens — `outcome=` first, then the counts, then
  `reason=` or the `tier`/`adapter`/`intent` labels (`forced=` and `computed=`
  join them when the tier was overridden) — so `scripts/audit.mjs` can count
  reviews by tier and adapter instead of parsing prose. A `note` is the one
  free-text field and never enters the summary.

Either form appends a line to `~/.claude/self-review/log.jsonl`, and that log
records `not-converged` runs as honestly as clean ones.

</details>

<details>
<summary><strong>Delegating a review to another session</strong></summary>

<br>

The loop runs in the session that changed the code. A subagent can't run it for
its lead: the reviewers it launches never appear in the lead's transcript, so
the lead's gate refuses the marker. To review finished work elsewhere, run
`claude -p "/self-review <paths>"` in the repository, with the permission flags
your headless sessions use (a `-p` session cannot answer a prompt, so a tool it
is not allowed is denied). It is a session of its own, so its reviewers count,
and its Stop gate checks its marker whenever its fixes change code.

</details>

<details>
<summary><strong>Uninstalling, and what stays behind</strong></summary>

<br>

`/plugin uninstall self-review@houssem-plugins` removes the hooks. These stay
until you delete them:

- your review log, `~/.claude/self-review/log.jsonl`
- the gate's decision log, `~/.claude/self-review/gate/` (one file a month,
  pruned after six)
- your config, `~/.claude/self-review/config.json`
- the `refs/self-review-reviewed/*` refs in any repository you opted into branch
  review

`SELF_REVIEW_GATE=off` turns the gate off for a session without uninstalling.

</details>

<details>
<summary><strong>What ships today, and what doesn't</strong></summary>

<br>

**Shipping:** the gate, the poll guard, the skill and its reviewer agents, the
scope, salvage and wait scripts, the cost cutters (`brief.mjs` builds a round's
briefs, `preflight.sh` runs the project's own checks first, `audit.mjs` reports
what a review cost), the context pair (`impact.mjs` computes the blast radius,
`tier.mjs` turns it into a tier and an angle plan), per-repository memory
(`findings.mjs` records every verdict and feeds the matching ones into the next
review's briefs), config with a per-repository layer, and its own test suite.

**Not yet:** the eval corpus and runner, and the measured numbers that come from
them.

**On `code-review-graph`:** the impact script uses it only when the repository
already has a `.code-review-graph/` index and the binary is on your `PATH`. It
never builds one for you, and its authors' own caveat applies: on small
repositories and single-file diffs the graph costs more than it returns. The
name search underneath always runs, so there is no language support to fall
outside of.

**On cost numbers:** the loop is budgeted — reviewer models and effort are
pinned, every agent has a call budget, and the session waits inside one bounded
call instead of polling. `scripts/audit.mjs` measures each review from the
transcripts, including how much the angles of one round overlapped. The numbers
stay out of this README until they come from more than one machine's sessions,
because one session's figures published as typical would be exactly the kind of
unverified claim this plugin exists to catch. Run it on your own sessions:
`node <plugin>/scripts/audit.mjs`.

</details>

## License

MIT — see [LICENSE](LICENSE).
