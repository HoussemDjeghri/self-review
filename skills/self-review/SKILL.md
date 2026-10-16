---
name: self-review
description: Convergent multi-agent review of work you just produced. Use after any task that wrote or changed code, before reporting done; when the Stop gate says "[self-review-gate]"; or when the user says "review your work", "check it", "self-review", "double-check" or "/self-review".
argument-hint: "[what to review — defaults to everything changed this turn]"
---

# Self-review loop

You cannot review your own work with your own eyes: the context that made a
mistake re-derives it on a re-read. So hand the change to fresh subagents, let
them attack it from different angles, check their claims, fix what is real, and
look again — because a fix is a new change that can itself be wrong. Anything
can be reviewed: code, docs, configs, skills, plans, commit text, chat answers.

It runs at the end of every turn that changed code (the Stop gate arms for code
files only) and on demand for anything else — prose, config, data, assets.
Rounds of finders, verification and fixes repeat until a round is clean or
effectively converged, or the findings stop converging (a severity-weighted
trend, not a fixed count) and you escalate to the user. It ends by marking
convergence (§4), which is what lets the turn end. It is **budgeted**, as
follows.

## What a review costs, and the two rules that keep it cheap

1. **Wait inside one call, never across turns.** After launching reviewers, the
   next call is `"${CLAUDE_PLUGIN_ROOT}/scripts/wait.mjs" --work <work> --round <n> [names…]`
   with the Bash `timeout` at `600000`. It blocks until every named reviewer has
   a finished report or has been silent past the stale limit, prints a line per
   reviewer, and exits `0` — all settled, collect (§2c); `1` — some still active
   within the round's 30-minute budget: call it again as the very next tool
   call; `3` — budget spent, treat the active ones as dead (§2f); `2` with a row
   `unknown — did you mean …?` — a wrong name, not a slow agent: call it again
   with the name the launch result shows. **Stalled** is neither: §2f. Do not end the turn to wait, and do not check on a reviewer any
   other way (`ListAgents`, `TaskOutput(block=false)`, `Monitor`, `sleep`): each
   is a full-context turn that tells you nothing the wait did not, and
   `poll-guard` denies the first two from the third call on. Wake-ups (idle
   notifications, `<task-notification>`s) are not the signal — they carry no
   report, and a report sent to your inbox may never arrive — so if one wakes
   you between calls, go back to the same call. The Stop gate releasing a turn
   while subagents run is the fallback for a `wait.mjs` that cannot run (exit 2
   "no subagent transcripts"; an exit 2 naming a bad flag you fix and re-run),
   never the way to wait.
2. **Act once per round, in one go.** When `wait.mjs` exits 0: verify, write the
   directives, dispatch the applier, wait on its name, then pre-flight, ledger,
   record, next round or marker — each stretch in as few calls as it takes,
   except the marker, which gets a message of its own (§4). Never fix from
   partial results while reviewers are out: fixes move the tree under them. Read
   cited line ranges (`sed -n 'a,bp'`), not whole files.

**Agents per review:** tier S ≈ 1, M ≈ 3–4 (a mixed change up to 6), L ≈ 6 —
**6 finders per round is the hard cap at every tier**; if round 1 needs more,
the scope is too big for one review: say so and split it. Later rounds taper:
≈2 finders at round 2, then one compact all-angles finder (§2a) plus angle S —
one only at tier S — plus a verifier per round at tier L. Tiers S and M stop
after **2 rounds** (a two-round M is ~5 agents), plus one tier-S finder on round
2's fix lines when it fixed a major or blocker (§3). Only tier L may run to the
six-round backstop, a rare escape hatch rather than a plan, because rounds 3+
rarely close.

**Models:** reviewers never run on the session's model or effort, because a
subagent inherits both unless pinned. Every agent type's model and effort is
one row of `config/agents.json`, the only place to edit them: the calls `brief.mjs` prints
carry both, so spawn them as printed and never restate a value. The agent files'
frontmatter mirrors the table — it is what decides for the applier and ticket validator,
which skill prose spawns with no parameters — and a test fails until the two agree.
Per-call `effort` needs Claude Code 2.1.292 or later. The finder's
row covers every angle but two kinds: `X` runs as the `cold-grader` row, and
`G` and `H` at tier L run as the `risk-finder` row — at most two per round; the
verifier is a stronger model
than the finders because ruling on the author's dismissals is where judgment
beats price. Haiku is not used yet: at about a twentieth of Sonnet's price per
token it would cut a finder's cost, but its recall on the finder corpus is
unmeasured (`evals/run.mjs --level finders --model …`). Do
not pass `model: "fable"`; a session that must force one model sets
`CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (the
variable alone loses to the pins), and `CLAUDE_CODE_EFFORT_LEVEL` outranks every
effort here. Call budgets are in the agent prompts (~40 calls for a code
finder, ~25 for docs or config, ~10 per candidate for the verifier); at the
budget the agent writes what it has, with `omitted` when coverage was cut. The
cap, the budgets and the round caps are `tier.finders` in `config/defaults.json`
(recorded in `tier.json`): never tune one mid-review to fit a round. Other
config: `references/scripts.md` → **Config**.

## 0 · Establish the scope and the intent

**One work dir per review.** `round.sh --new-review` allocates
`<reviews>/review-<k>/` under `<reviews>` = `<scratchpad>/self-review/` and
prints `work: <path>` first; **`<work>` is that path from then on** — every
round (`<work>/round-<n>/`), the ledger, the marker. Without a scratchpad
(headless), `<reviews>` is what `"${CLAUDE_PLUGIN_ROOT}/scripts/reviews-dir.sh"` prints — the same
private path on every call in one session (with the same `$TMPDIR`), ticket
included, so there is nothing to remember. A new change
is a new review even in the same session; never reuse an earlier `<work>`,
because a shared dir compares W against another review's rounds and takes its
tier ceiling. What `round.sh` refuses, and why a refused `>` is fixed in allow rules:
`references/scripts.md` → **The work dir**. The work dir must be **outside** the repository (`round.sh`
refuses otherwise), or the loop reviews its own paperwork; if a `>` redirect
into the scratchpad is refused, add the scratchpad to your `Edit` allow rules
rather than moving the work dir. Every `<…>` is a one-token placeholder you
substitute: unsubstituted, `<` and `>` are redirections.

Write the **INTENT block** (template: `references/briefs.md`) to
`<reviews>/intent.md`; `--new-review` moves it, and the ticket's `ticket/`, into
the review dir so the next review cannot brief against this one's ticket. It
holds the user's ask in their words, the constraints, the **invariant** (the
property that must hold when done, falsifiable, written *before* the code — a
change built to suppress a symptom has none, and that absence is the finding),
what "done" means, the premise (why the change must exist — what already does
the job, checked), and what was cut on purpose. Every brief carries it, so
reviewers neither review the wrong thing nor flag deliberate cuts.

`--intent` turns on **who read the intent**, not which skill ran: `validated` —
a validator read it before the code existed (the `ticket` skill; `intent.md` is
then already there: use it as it stands, do not write a second); `author` —
only you read it, the normal case without `ticket`, so write it now; `skipped` —
nothing was written before the code, and the block is written now purely to
brief reviewers. All three are honest; only `validated` is checked, for order.
Then set the round up in **one call**:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/round.sh" --new-review --work <reviews> --intent <reviews>/intent.md \
  [--base <ref>] [--force S|M|L --reason "…"] [paths…]
```

Round `N` ≥ 2 is `round.sh --work <work> --round <N> --intent <work>/intent.md`;
it replays round 1's scope (paths and `--base` are refused: a new scope is a
new review), prints `findings.mjs converge`'s verdict on round `N−1` above the plan (§3),
and when that verdict is `STOP` or `UNRECORDED` it refuses the round (exit 5,
nothing created) and prints the `next:` call to run instead.
That one call is scope, pre-flight, impact, tier, prior findings and every
brief; it prints the tier line, one `Agent {…}` line per finder, and the
pre-flight verdicts last (act on those before spawning). **Do not run those
scripts separately** — each extra call is a full-context turn with no judgment
in it. Without `round.sh`: `references/scripts.md` → **Without round.sh**.

From round 2, round 1's tier is a **ceiling**: the scope is captured against
HEAD, so the previous round's fix lines would otherwise ratchet the tier up, and
fixing a finding well must not cost more than finding it. `--force` still wins,
auditable in `tier.json`.

**Scope.** Pass `--base <sha>` if you committed this turn (HEAD before your
first commit), or committed work is invisible. Outside git, pass the files you
produced: each is diffed against its own repo, or printed in full when it has
none (an installed plugin's directory is not a checkout — review plugin edits
in its repo). A chat-only artifact (plan, analysis, answer) goes to
`<work>/artifact.md` first, scoped as a file. Exclude scratch and generated
files. Over ~2,500 lines, review the riskiest files now and name the rest in
the report rather than spawning more reviewers.

`${CLAUDE_PLUGIN_ROOT}` is the installed plugin directory; `scripts/`, `agents/`
and `config/` paths are relative to it, and `references/…` is relative to this
skill's own directory (`${CLAUDE_PLUGIN_ROOT}/skills/self-review/references/`). Unexpanded: `references/scripts.md` → **Plugin root**.

Read the scope yourself before spawning anyone — you decide the tier and angles
and judge the verdicts. Read what `round.sh` decided rather than re-running it:
`impact.md` (the row that matters is **broken references**) and `tier.json`
(tier, reasons, finder rows; details in `references/scripts.md` → **What
round.sh computed**). Read the reasons, not just the verdict; two judgments
stay yours:

- **Raise** the tier for what line counts cannot see — a flipped default, a
  contract change inside 15 lines, a premise you already doubt.
- **Lower** only when you can say why the rule over-read the change.
- Either, before launching anyone, re-plans round 1 in place:
  `round.sh --work <work> --round 1 --intent <work>/intent.md --force S|M|L --reason "…"`
  — never a second `--new-review` for the same change. The reason lands in
  `tier.json` beside the computed tier, the marker summary and the report.
  Raising is cheap to justify; forcing *down* is the one the numbers watch.
- `split: true`: the scope is too big — review the riskiest paths now and name
  the rest in the report.

| Tier | Finders (round 1) | Settings row | Verification |
|---|---|---|---|
| **S** trivial | 1, compact all-angles brief | `finder`; `cold-grader` for `X` | you, against the file |
| **M** standard | code 3 (+1 security) · docs 2 · config 1 — cap 6 | `finder`; `cold-grader` for `X` | you; a verifier only in §2d's cases |
| **L** large / risky | code 4–6 · docs 3–4 · config 2 — cap 6 | `finder`; `risk-finder` for `G`/`H`; `cold-grader` for `X` | 1 verifier per ≤ 8 candidates (`verifier`) |

Tier S makes a one-word fix cost one agent, but it is still an independent
reader, never you re-reading.

If a setup script fails: `references/scripts.md` → **When a script fails** —
and say in the report which one did not run.

## 1 · Pre-flight: let machines catch what machines catch

Round 1's `round.sh` already ran it and printed the verdicts; failure tails are
in `<work>/round-1/preflight.txt`, out of your context on purpose. Run it
directly only to re-check a fix:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh" --root <repo> --out <work>/round-1/preflight.txt
```

It exits 0 even when a check fails: the report is the answer. What it detects,
`preflight.skip`, and `preflight.artifactRoot` (off by default; user-global, so
it applies to every project) are in `references/scripts.md` → **Pre-flight**; an
artifact-root `SKIP` (no node tests there) is not a failure of the reviewed
repository. `round.sh` runs pre-flight on a **copy** of the tree with an empty
HOME (`pre-flight (from …)`): a check that fails there and passes in the
checkout is a finding — something resolved a path against where the code
lives — so report both results. By hand you are back in the checkout, which is
fine for re-checking a fix.

Fix what fails before spending reviewers — formatter, linter, type-checker,
relevant tests; parse or dry-run configs (`jq`, `yq`, `validate`/`--dry-run`);
for docs, run the commands and check the paths you cited — because a reviewer
reporting a failing test is wasted, and one reading code that does not compile
reviews the wrong thing. Record the commands and real results for the report.

## 2 · A round

### 2a · The angle plan (`references/angles.md`)

`tier.json`'s `finders[]` is the plan — one row per finder with its angles,
agent type, model, call budget and impact depth, encoding the groups in
`references/angles.md` → **Angle groups per tier** (read those only to override
it). Use it as written. When the round exceeded the cap, `merged[]` names what
was folded into what; name those in the report, because a merged angle got less
attention than a whole finder.

### 2b · Spawn finders — fresh agents, in parallel, then wait in one call

Spawn the `Agent` lines `brief.mjs` printed, **all in one message, as
printed**, then call `wait.mjs` as the next call, nothing in between. Do not
rename, retype or inline them: the name is what the guards match and how
`wait.mjs` finds the state file, and angle `X`'s `self-review-cold-grader` has
**no Bash**, so a finder in its place hands a shell to the one angle designed
without one. Without `tier.json`, `brief.mjs --tier S|M|L` prints a default
plan's lines — but writes no plan, so that round cannot be recorded with
`--work` (the recordable hand-built sequence: `references/scripts.md` →
**Without round.sh**). What a brief carries: `references/scripts.md` → **Briefs**.

The loop runs from a session that can spawn this plugin's agents — in an agent
team, the lead; a teammate cannot spawn them. A teammate either hands its
change to the lead (message it the scope) and ends with
`converged.sh --not-applicable other --note "handed to lead: <scope>"`, or
reviews it in one honest single pass (below) and ends `--not-converged` with
its real counts — never `converged`, which the gate refuses without reviewers.

If a *reviewer* type is missing, use `general-purpose` with that agent file
(`${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`) pasted at the top of the brief, under
the printed `self-review-…` name: no guard recognises its registered type, so
the name is all that contains it. **Never substitute for `self-review-applier`**:
the Stop gate arms on that exact type, so a substitute is invisible to it and
carries `Bash`; without the applier type, apply fixes yourself (§2e) and say so.

Finders run in the background (`run_in_background: true` where exposed); their
notifications are not the signal, `wait.mjs` is — also when you are yourself a
subagent. While they read, do not edit, commit or rebase files in scope: a
finder on a moved tree returns line numbers that point nowhere. Never use a fork
for a reviewer and never review inline: a fork inherits the context that made
the mistake, and inline review is what this skill replaces. Without the Agent
tool, or as a teammate that cannot spawn this plugin's agents, work through
every angle yourself, sequentially, and say so — an honest single pass is fine;
one described as the loop is not. A finder that returns
`failed` or `stopped` is salvaged (§2f), then re-spawned once at most; if that
fails, report its angle as uncovered rather than waiting.

### 2c · Collect and deduplicate

`wait.mjs`'s table says who finished, died or stalled; the last two go to §2f
first. A report is the finder's last message, which a wake-up does not carry.
In one call, read every finished report —
`scripts/salvage.mjs <session-id> <name> <name>…` (no names lists the agents; the session id is the UUID in your
scratchpad path, or `$CLAUDE_CODE_SESSION_ID` without one) — and run `scripts/treecheck.sh --work <work> --round <n>`,
which is silent unless the tree moved while reviewers ran; its line goes into
the report **verbatim**, because a reviewer that wrote into the repository, or
undid something to clean up, took uncommitted work with it.

Give every candidate an id (`r1-1`, `r1-2`, …). An `omitted` count means that
finder cut real findings: re-run its angle on a narrower scope or report it
uncovered. An empty `[]` on a large, logic-heavy change is suspect — finders
are told to pass half-believed candidates through — so read that transcript
before trusting it. Merge candidates at the same line and mechanism, keeping the
most concrete failure scenario; drop nothing else — verification decides.

### 2d · Verify

By default **you** verify, with the rubric in
`${CLAUDE_PLUGIN_ROOT}/agents/self-review-verifier.md`: open the cited range,
quote the proof or counter-proof into the ledger, give the verdict. **A
dismissal without a quoted counter-proof is not a dismissal** — it is an
unverified candidate and gets a verifier; `findings.mjs record` refuses a
`dismissed` record with an empty `proof`, so an unquotable dismissal is an open
finding. Spawn verifiers (one per ≤ 8 candidates) when:

- **you dismissed anything at all** — one is enough, and the gate refuses a
  `converged` marker with `dismissed >= 1` and no verifier completion, because a
  wrong fix shows in the diff but a wrong dismissal is invisible and enters the
  ledger that tells every later finder, in this loop and later ones over the
  same files, not to refile it. Verify at least the dismissed candidates, plus
  earlier dismissals;
- **the loop's candidates exceed four** — `fixed + dismissed + open` on the
  marker, loop totals, because that is the only count the gate can read; it
  counts candidates, not verdicts, so fixing what you would have dismissed
  cannot dodge it;
- the tier is L;
- a fix would change behaviour, a contract or a stated decision and you are not
  certain.

Write the candidates to one JSON file, run

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/brief.mjs" --verify <candidates.json> --work <work> --round <n> [--batch <b>] [--live <repo>]
```

and spawn every line it prints, in one message, as printed — it splits more
than eight candidates into batches itself, numbered on from `--batch` — then
`wait.mjs` on their names. Keep the printed `self-review-verifier-…` name:
tree-guard matches the name an agent runs under, not its type, so a renamed
verifier has an unguarded shell in the author's tree.

| Verdict | `fix_risk` | Action |
|---|---|---|
| CONFIRMED | low | fix now |
| CONFIRMED | design | ask the user if they are in the session; otherwise **unfixed** — the review ends not-converged |
| PLAUSIBLE | low | fix now (a guard, a test, a corrected sentence is cheaper than the argument) |
| PLAUSIBLE | design | **open** — ask the user, with your recommendation |
| REFUTED | — | **dismissed** — ledger entry with the refuting proof |

Read the proofs, not the count: a verifier that refutes with "the caller always
passes a non-empty list" while you can see one that does not is wrong — override
it and note why in the ledger.

### 2e · Fix

**Name the root cause first.** A *local defect* (right shape, wrong line) gets a
patch. A wrong *shape* (the code does what it was designed to, and the design is
wrong) gets **no patch** — a patch yields working bad code and the next round
finds the defect through the next door — so replace, move or delete the
mechanism, or run angle S if you cannot see which. Say which in the ledger, and
for a fix **name the invariant it restores**, not the exploit it blocks
("the tool only opens files inside the repo", not "blocks `../secret.json`"); a
fix you can only describe as blocking an input has not found the root cause —
escalate it to angle S. Two rounds of findings in one unit: the next round runs
angle S, and the unit gets no patch until its invariant is written.

Dispatch fixes; do not apply them. You hold the context that makes a fix correct
rather than local, so it goes into a **directive** per finding
(`references/briefs.md` → Applier directives) in
`<work>/round-<r>/directives.md`: the invariant, the concrete change, the
failing test to add first when the project has tests, what nearby not to touch.
Without the invariant or the change it is not dispatchable. Launch **one**
`self-review-applier` per round, named `self-review-applier-k<k>-r<r>` (`<k>`
from your `review-<k>` work dir, `<r>` the round) so `wait.mjs` and
`salvage.mjs` find it (prompt `Read <path> and follow it.`), then
`wait.mjs` on that name — never one per finding, since concurrent edits collide,
never beside a finder, and **no edits while it runs**. It reports `applied` /
`deviated` / `blocked` per directive. Every later round replays round 1's scope and
adds any file changed since round 1 outside its paths (`scope +:`); scope
outside git cannot be widened, and a repository round 1 took no snapshot of says
so (`scope +: not widened`); there a fix in another file is yours to read
against the finding.

If it never reports (killed, a usage-limit reset), do not re-dispatch the same
file: its edits are already in the tree (§2f). When it reports: re-run the
pre-flight checks the fixes could break (§1), rule on each `deviated` (accept,
or a directive next round) and each `blocked` (a rewritten directive for a
fresh applier, or that one edit yourself — after it reported, never during).
A `blocked` still not fixed after that retry is recorded **`unfixed`**, never
`open`: CONFIRMED never maps to `open`, and `converge` ends the review on it.
The gate arms on the applier's launch and treats its completion as your last
change, so the next
round's finders must complete after it, which this order guarantees. Without
the applier type, fix it yourself: the smallest change, no opportunistic
refactors (they widen the next round's scope), `clean-code` (and
`react-patterns` / `frontend-craft` when called for) loaded, the failing test
first, then pre-flight again.

Then update the ledger (`references/briefs.md` → ledger format: fixed,
dismissed, open) and record the round, in one call — never before the applier
reports, or a `fixed` goes into cross-session memory for an edit that may have
come back `blocked`:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/findings.mjs" record --work <work> --round 1 <<'JSON'
[{"verdict":"fixed","file":"src/x.ts","line":41,"severity":"major","class":"correctness",
  "angle":"A","summary":"null deref on empty list","mechanism":"local defect",
  "proof":"x.ts:41 returns undefined for []"}]
JSON
```

One object per finding acted on; `class` from the finder's `category`
vocabulary. Copy a candidate's `prior_id` (the eight bracketed characters of the
`prior.md` line it re-raised) onto the record unchanged — nothing downstream can
reconstruct it, and dropping it is silent. It validates every record before
writing any, so a rejection costs a retry; `record --help` prints the schema.
Record **every** round — `[]` when it had nothing to record, or `converge` calls
the round `UNRECORDED`. With `--work` it then prints the round's verdict and a
`next:` line, the exact call that acts on it (§3). Where the memory lives:
`references/scripts.md` → **Findings memory**.

### 2f · A dead, stalled or silent agent — recovery is in `references/recovery.md`

`wait.mjs` names which you have and prints the next action with the name
filled in; follow it, and open `references/recovery.md` for the reasoning and
salvage commands. Three rules to hold without opening it: **never re-spawn an
agent whose report exists**; salvage a dead agent's state file into the
replacement's brief rather than re-deriving it; **a dead *applier* is the
opposite case — read the tree first and dispatch a rewritten directives file,
never the original.**

## 3 · Converge or go again

A round is **clean** with zero findings to fix — zero CONFIRMED, zero
PLAUSIBLE/low (open and dismissed items do not count). Only two things end the
loop **as done**: a clean round, or an *effectively converged* one (only
manufactured or dismissed findings, below) — not a round that merely found less,
not a counter running out. Anything else goes again or escalates.

**A fix to a trust boundary does not converge on generic finders.** When a fix
changes what untrusted input may do — a permission, an exemption, a path opened
on someone else's say-so, anything the reviewed repository can set — the next
round carries one finder briefed on that boundary alone, told the earlier
attempts and that each failed; name it in the report. No converged while the
newest bound was read only by finders looking at something else. Reshaping a
bound is changing it. A bound that keeps taking findings is evidence against the
design: ask §2e's question, and consider deleting it.

Rounds are an **outcome, not a setting**, because a round that fixes ten
findings and stops leaves ten fixes unreviewed. Decide from the trend:

- **Clean round → converged** (`converge` says `CLEAN`). Go to §4.
- **The round fixed something → another round is mandatory** unless a check
  below stops it, because its fixes are unreviewed. Re-capture the full scope
  and run fresh, tapered finders (≈2 at round 2, compact + S from round 3,
  groups merged, never an angle dropped), weighting the changed lines while free
  to flag ripple. They get the dismissed ledger and nothing about your fixes, so
  each fix must stand on its own. **Never declare done right after fixing.**
- **First check the loop is still converging** — `record` already wrote the
  verdicts, so this is a command, not arithmetic:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/findings.mjs" converge --work <work> --round <N>
```

  It prints each round's `W`, compares rounds over shared angles, says
  `CLEAN`, `CONTINUE`, `ESCALATE`, `STOP` or `UNRECORDED`, and prints a `next:`
  line, the exact call that acts on it; act on the `next:` line
  (`references/converge.md` has the arithmetic, needed only to argue). **Its last line is the tree-guard audit,
  about the plugin, not your change**: only `tree-guard engaged: N/M` is a pass;
  copy any other wording into the report **verbatim** and tell the user — do not
  restate it or read silence as all-clear. It never changes the verdict.

  **Stop and escalate** — surface the state, do not declare done — on any of:
  - `ESCALATE` — `W` over shared angles did not drop (the fixes are not
    shrinking the problem, or one spawned another);
  - **oscillation** — a round flags an earlier fix as wrong: do not flip it
    back; surface both positions;
  - the **round budget** — **2 at tiers S and M, 6 at L** — which `converge`
    reads from `tier.json` (`roundsCap`) and answers `STOP` itself (`--budget
    <n>` overrides; you should not need it). A spent budget bounds cost and is
    never health: report that round's fixes as unreviewed, never a `STOP` as
    clean. After a `STOP` act on the `next:` line — `--not-converged` with your
    counts, not another finder; `round.sh` refuses the next round (exit 5).
    **One extension, any tier:** a round that **fixed a blocker or
    major** buys exactly one more, because such a fix must not ship unread —
    `next:` prints it, with `--force S --reason "extension round: round <N>
    fixed a <severity>"`: one compact finder on that round's changed lines
    (without the force the ceiling holds and `round.sh` plans compact + S like
    any round 3). Minors or dismissals buy
    nothing: no reader has not seen them. Single-shot, both halves enforced by
    `converge`. The trust-boundary rule outranks the budget. A tier-L change
    unclean after six rounds is too big for the loop: split it, involve the user.

  `W` is a non-negative integer that must strictly drop, so once consecutive
  rounds share an angle the loop ends on its own — clean, effectively
  converged, or a stall handed to you. Angles compare as the *sets* a finder
  covered, so the taper cannot make rounds incomparable. Escalation is not
  failure; it is the honest output when the change needs a decision the loop
  cannot make.
- **A round of only manufactured findings is effectively converged — stop.**
  Reviewers asked to find things keep producing them: taste, a speculative
  "could maybe", a guard for a state no caller reaches, a reword with no reader
  or machine effect. Hold every survivor to a dismissal's bar (a concrete
  failure, or a stated rule broken) and record why any fail it — a judgment
  without a written reason is not one. All dismissed or manufactured: mark it
  done. Never apply a change only to make a finding disappear: a cosmetic fix is
  a new unreviewed change that manufactures the next round's work. Unsure
  whether survivors are real? Put them to the user as open items; do not
  fix-and-spin.
- If the user interrupts, stop immediately; do not run `converged.sh`.

## 4 · Mark convergence, then report

`coldSkipped` in `tier.json` goes in the report as a note, not a finding: angle
X was dropped and nothing in the change was exercised.

The marker is a **typed record** — you name the fields and the tool writes the
string; never compose a summary, because a prose marker carries no counts the
loop can measure. Two forms, treated alike by the gate. **`converged` needs a
reviewer completion behind it**: a `self-review-finder` or
`self-review-cold-grader` that finished **after your last change and before the
marker** — last fix, a finder completes, marker, nothing edited between. An
applier's completion counts as your change. A verifier does not count: it
presupposes findings, and if you generated them you reviewed your own work. One
finder is the floor, because tier S *is* one finder. `--not-converged` (with
real counts) and `--not-applicable` (with a reason) need no reader and are never
gated.

**Write the file** — the default; a scratch write needs no permission rule:

```
Write  <work>/CONVERGED.json          # i.e. <reviews>/review-<k>/CONVERGED.json
{"outcome": "converged", "rounds": 2, "fixed": 3, "dismissed": 1, "open": 1, "tier": "M", "adapter": "grep", "intent": "author"}
```

**Or run the script**, which logs itself and works when `<work>` is not scratch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/converged.sh" --converged --rounds 2 --fixed 3 --dismissed 1 --open 1 --tier M --adapter grep --intent author
```

Anything invalid is **refused** with every defect named, so fix what it names
and write again; fields, the `not-applicable` form and where each form counts are
in `references/marker.md`. In short: the file lives under a scratch prefix,
never in the project; the script's *output* is what counts, never a quote or
`cat` of it; if your permission mode refuses the command, use the file. A loop
that stopped short (stall, oscillation, backstop) is `--not-converged` with real
counts and the open state reported — after `STOP` or `ESCALATE`, act on the
`next:` line, which is that call; a turn the loop does not fit is
`--not-applicable`, never a review that did not happen. `open` counts the
questions put to the user in the report; an unfixed CONFIRMED is not open, it
is recorded `unfixed` and the review ends `--not-converged`.

The marker, not a sentence saying you reviewed, is what the gate looks for.
Mark only after the final round and edit nothing after it (an edit re-arms the
gate, correctly). Give it a **message of its own**: the gate orders by
transcript entry, so a write in the same command or a parallel call shares its
position and the gate never clears (scratch-only writes beside it are exempt).

Then the final report (`references/briefs.md`): outcome first — rounds, fixed,
dismissed, open — then a line per fix (five at most, then the ledger's path), the open questions with
recommendations, and the checks you ran with their real results.

## On demand and beyond files

`/self-review <target>` reviews whatever is named — a path, "the plan above",
"my last answer", a PR branch (`--base` does the rest). For chat-only
artifacts, write it to `<work>/artifact.md`, scope it, and use the docs angles
plus, in the intent block: *does it answer what was asked, with evidence, and
are its assumptions stated?*

## Files

Every script, reference, agent, hook and config file, one line each:
`references/scripts.md` → **Files**.
