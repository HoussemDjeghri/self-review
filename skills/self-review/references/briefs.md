# Briefs, ledger, and report formats

Copy these templates; fill every `<…>`. A brief is the *whole* world of the
agent that receives it — it has none of your context, which is the point (it
cannot inherit your blind spots), so anything it needs must be in the brief.

## The intent statement (written once per review, reused in every brief)

```
INTENT
User asked (quote the load-bearing phrases): "<…>"
Constraints / conventions that apply: <CLAUDE.md rules, framework, perf/security constraints, "no new deps", …>
Invariant: <the property that must hold when this is done, stated so it can be falsified — "a reviewed repository cannot make its own review weaker", not "the config is validated">
Done means: <the observable outcome — what works, what the reader can do>
Premise: <why this has to exist — what already does this job (framework, platform, existing code) and why it is not enough; "checked X, it does not cover Y">
Out of scope on purpose: <anything deliberately not done, with the reason>
```

Keep it to 6–9 lines. **Write the invariant before the code, not after** — it is
the one line that turns a review from "is this wrong?" into "can this be right?".
A change built to suppress a symptom rather than to hold a property has no
invariant to write, and that is the finding: this plugin spent six review rounds
and eight defects on one config setting whose invariant — "a reviewed repository
cannot make its own review weaker" — was never written down, so every round
measured the fix against the last exploit instead of against the property, and
every fix left a neighbouring door open. If you cannot state the invariant, say
so in that line; angle S is told to start there.

 It is the reviewer's only defence against reviewing the
wrong thing; the "out of scope" line is what stops intent-fidelity reviewers
from flagging a cut you made on purpose. The "premise" line is the one the
intent-fidelity finder (angle E, or the compact brief) is told to attack: the
2026-08-22 allowlist-guard review ran six rounds hardening a hook against
bypasses the platform already blocked, because every reviewer took the change's
reason to exist as given. Write the premise as a checked fact, not a belief — if
you have not checked, say so, and the finder will.

## Finder brief

Send one per angle group with `subagent_type: "self-review-finder"` (fallback:
`general-purpose`, then prepend the finder agent's system prompt text from
`${CLAUDE_PLUGIN_ROOT}/agents/self-review-finder.md`). Launch all finders of a round in one
message so they run in parallel.

```
You are reviewer <n> of <total> in round <r> of a self-review.

<INTENT block>

SCOPE
Read <absolute path to round-r/scope.diff> first — changed-file list, diff, and
new files rendered as additions. The live files are at <cwd or repo root>; read
enclosing code/sections there. Scratch and generated files are not in scope.

YOUR ANGLE
<angle paragraph(s) pasted verbatim from references/angles.md>

IMPACT (line numbers as of generation — re-read before asserting)
<impact.md at this row's depth: full, docs, or the two-line summary>

PRIOR FINDINGS IN THIS REPO (context, not a checklist)
<prior.md from findings.mjs prior: [id] file:line · class · summary · verdict>   (omitted when there are none)
If one of these lines is the defect you are filing, put the eight characters its
brackets hold in your finding's `prior_id` — "prior_id": "1a2b3c4d". A wrong id
is worse than none.

ALREADY DISMISSED (do not re-report without new evidence)
<ledger "dismissed" entries: id — summary — why refuted>   (or "none")

STATE FILE (crash insurance)
<absolute path to round-r/state/<finder-name>.jsonl> — append each candidate
there as one JSON line the moment it firms up, batched into the same Bash call
as your next read. If your session dies, this file is what survives.

CALL BUDGET
<n> tool calls. Spend them on reading the enclosing code and proving
findings, not on breadth for its own sake.

OUTPUT
The JSON array described in your instructions. Up to 6 candidates, most severe
first, `[]` if nothing qualifies. Nothing after the JSON.
```

`brief.mjs` writes exactly this, in this order — the sections that depend on a
file (IMPACT, PRIOR FINDINGS) are dropped when that file is empty.

## Verifier brief

Spawned only in the cases SKILL.md §2d names (tier L; about to dismiss three or
more; an uncertain behaviour-changing fix). One verifier per batch of up to 8
candidates, `subagent_type: "self-review-verifier"` (fallback: `general-purpose`
+ the verifier system prompt text). Otherwise you verify, with the same rubric,
and the ledger carries your quoted proof.

```
Verify these <k> candidate findings from round <r> of a self-review.

<INTENT block>

SCOPE
Read <absolute path to round-r/scope.diff>; live files are at <cwd>.

CANDIDATES
<JSON array of candidates, each with an "id" you assigned (e.g. r1-3)>

STATE FILE (crash insurance)
<absolute path to round-r/state/<verifier-name>.jsonl> — append each verdict
there as one JSON line as you reach it, batched with your next read.

OUTPUT
The JSON array described in your instructions — one verdict per candidate id,
with quoted proof and fix_risk. Nothing after the JSON.
```

## Applier directives (`<work>/round-<r>/directives.md`; the Agent prompt is `Read <path> and follow it.`)

One `self-review-applier` per round, never one per finding — concurrent edits in
one tree collide. A directive missing its invariant or its concrete change is
not dispatchable; the applier returns it `blocked` unopened.

```
DIRECTIVES — round <r>
Repository root: <abs path>
Project has tests: yes (<runner>) | no

D1 · <file>:<line> · <finding id> · <severity>
Invariant: <the property the fix restores, stated so it can be falsified>
Change: <the concrete edit — old text → new text, or the unit to add — exact enough to apply without deciding anything>
Test first: <file and assertion of the failing test to add> | none
Do not touch: <the neighbouring thing that looks wrong and is out of scope>

D2 · …
```

## The ledger (keep it in `<scratch>/self-review/ledger.md`, update every round)

```
# self-review ledger — <one-line task>

## fixed
- r1-2 [major] · src/x.ts:41 · null deref on empty list · fixed in round 1 (guard + test)

## dismissed   ← passed to every later finder
- r1-4 · src/y.ts:12 · "lock not released" · REFUTED: released in finally (y.ts:19)

## open   ← reported to the user, does not block convergence
- r2-1 · docs/api.md:30 · retry semantics undocumented · PLAUSIBLE, fix_risk=design
```

Rules that keep the loop honest:
- Each fixed entry records its severity (`[blocker]`/`[major]`/`[minor]`).
  §3's convergence check recomputes `W = 3·blockers + 2·majors + 1·minors` per
  round, and after a crash the ledger is the only record of past rounds that
  survives — so `W` must be reconstructable from it alone, not from a transcript
  that may be gone.
- Finders get the *dismissed* list, never the *fixed* list — a fix must be
  re-discovered as correct by a cold reader, not taken on faith.
- A dismissed entry needs the refuting proof; "seems fine" does not dismiss.
- An open entry is a decision for the user, stated as a question with your
  recommendation, not a bug you chose to ignore.
- The ledger is this review's working memory; `findings.mjs record` (SKILL.md
  §2e) is the repository's. Record the same entries there in the same step —
  the ledger dies with the scratch dir, and what the next review of these files
  gets handed is the recorded version.

## Final report (your last message, after the marker)

Lead with the outcome; the detail is for whoever wants it.

```
Self-review: converged in <r> rounds — <f> fixed, <d> dismissed, <o> open.
Fixed: <file:line — what> (…one line each, most important first)
Open for you: <file:line — the question + your recommendation>
Checks: <command → real result, e.g. `npm test` 42 passed · `tsc` clean>
```

Say **"converged"** for a clean final round; say **"converged (last round's
findings were all manufactured — nothing real left to fix)"** when the loop
ended on the effectively-converged path (§3), so the reader knows the loop
stopped on judgement, not on a round that happened to find nothing.

If the loop did **not** converge (W plateau, oscillation, round backstop,
interrupted):

```
Self-review: NOT converged after <r> rounds — <why>. Still outstanding: <…>.
```

Never describe a non-converged review as clean; the user decides what to do with
the remainder.
