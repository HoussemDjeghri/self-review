---
name: self-review
description: Convergent multi-agent review of work you just produced — code, docs, configs, skills, plans, commit text, chat answers. Use after finishing any task that wrote or changed code, before reporting done (the Stop gate arms for code files only — prose, config, data and asset changes are reviewed on demand); whenever the Stop gate says "[self-review-gate]"; and whenever the user says "review your work", "check it", "self-review", "double-check", or "/self-review". Fresh reviewer subagents find candidates from distinct angles, each candidate is verified against the file, you fix what survives, then a fresh round re-reviews — until a round is clean or effectively converged (no real findings left), or the findings stop converging (a severity-weighted trend, not a fixed count) and it escalates to you. Budgeted: few finders, Sonnet by default, and waiting by ending the turn, never by polling. Ends by marking convergence — a CONVERGED.json write, or scripts/converged.sh — which is what lets the turn end.
argument-hint: "[what to review — defaults to everything changed this turn]"
---

# Self-review loop

You cannot review your own work with your own eyes: the mistakes you just made
are the ones you were blind to a minute ago, and re-reading with the same
context re-derives the same conclusions. What works is what engineering teams
do: hand the change to people who were not there, let them attack it from
different angles, check their claims, fix what is real, and look again —
because a fix is a new change that can itself be wrong.

This skill is that process, with subagents as the people. It runs at the end
of every turn that changed code (the Stop gate enforces it for code files;
prose, config, data and asset files are not gated — a 2026-08-22 audit of 17 reviews
found the loop earned its cost on code with tests and produced churn on docs,
settings and memory notes) and on demand for anything else. It is also **budgeted**: reviewers are only cheap when they are aimed, and
two measured things burn a usage window — the main session re-reading a 400k context once
per status check (2026-08-21), and reviewers that run on Opus or read without
a budget (2026-08-22: one Opus finder billed 7M input tokens over 100 tool
calls; the Sonnet docs finders ~1M over ~20). So the loop spends the main
session's turns sparingly and gives every reviewer a model, an effort, and a
call budget.

## What a review costs, and the two rules that keep it cheap

1. **Wait by ending the turn.** After spawning reviewers, write one line
   ("3 reviewers running — continuing when they report") and stop. The Stop
   gate lets a turn end while subagents are running, and each finisher wakes
   you — a `<task-notification>` for an unnamed agent, a teammate idle
   notification for a named one (it carries no report: read that with
   `salvage.mjs`, §2c). `ListAgents`, `TaskOutput(block=false)`, `Monitor`, `sleep` —
   every one is a full-context turn that tells you nothing; the `poll-guard`
   hook denies `ListAgents` and `TaskOutput(block=false)` from the third call
   on (Monitor and sleep are not guarded — do not use them to wait on agents).
   If the gate keeps blocking after a genuine attempt, it releases itself with
   a notice after two reminders; do not fight it.
2. **Act once per round, in one go.** When a notification wakes you and other
   reviewers are still out, reply with one line and end the turn again — do
   not start fixing from partial results (fixes move the tree under the
   reviewers still reading it). When the last one lands: verify, fix, ledger,
   next round or marker, in a single stretch with as few tool calls as it
   takes — except the marker, which gets a message of its own (§4). Read cited line ranges (`sed -n 'a,bp'`), not whole files.

Rough cost, in fresh-context agents: tier S ≈ 1, M ≈ 3–4 (a mixed change up
to 6), L ≈ 6 — **6 finders per round is the hard cap at every tier**. Extra
rounds taper: ≈2 finders at round 2, 1 per round from round 3 on, plus a
verifier per round at tier L. Tiers S and M stop after **2 rounds** at most
(a two-round M is ~5 agents) — plus one tier-S finder on round 2's own fix
lines when that round fixed a major or blocker (§3); only tier L may run to
the six-round backstop (§3), and that is a rare escape hatch — a change still adding ≈1 finder each
round to round 6 — not the budget you plan for. The 2026-08-22 audit found
rounds 3+ mostly ended `not-converged` with minors: they were paying for rounds
that did not close. If round 1 already needs more than the cap, the scope
is too big for one review — say so and split it.

Reviewers never run on the session's own model or effort. A subagent inherits
both unless its definition pins them, so a Fable session at max effort would
otherwise spend Fable-at-max on every finder. The split, from the 2026-08-22
measurements (a reviewer's billed input ≈ its tool calls × its context: 1–2.8M
tokens per Sonnet finder, 3.5–7M per Opus finder, at ~5× the price per token):

- **Finders: sonnet · high at every tier** (pinned in the agent file). Opus
  finders billed 2–3× more at 5× the price, and the one blocker this loop
  caught came from reproducing a bug by running the module — which does not
  need Opus. Tier L passes `model: "opus"` on the Agent call only for the
  risk-column angles, `G` security and `H` concurrency: at most two per round.
- **Verifier: opus · high** — one agent per batch of ≤ 8 candidates, ruling on
  the author's dismissals; it is the one place where judgment beats price.
- **Effort high — not max, not low.** A reviewer reads and probes across tens
  of tool steps and effort multiplies the thinking spent on each; Anthropic's
  guidance is to keep `high`, with `medium` as the cost step-down and `low`
  only for short, non-judgment tasks. Use `medium` when the window is short.
- **Haiku: not used.** A reviewer's cost is calls × context, which a cheaper
  model does not change, and review is judgment — it would trade what the
  loop pays for to save a third of the smallest line item.
- **Call budgets, in the agent prompts**: ~40 tool calls for a code finder,
  ~25 for docs or config, ~10 per candidate for the verifier. At the budget
  the agent writes what it has, with `omitted` when coverage was cut.

Do not pass `model: "fable"`; the env var `CLAUDE_CODE_SUBAGENT_MODEL`
overrides all of this if a session ever needs to.

These counts, models and call budgets are skill text today, not settings:
never tune one mid-review to fit a round. What the plugin reads from
`${CLAUDE_PLUGIN_ROOT}/config/defaults.json` is the gate's business — the file
kinds it exempts, `gate.maxReminders`, `pollGuard.maxChecks` — overridden per
user in `~/.claude/self-review/config.json` (objects merge, arrays replace).

## 0 · Establish the scope and the intent

Make a work dir: `<scratchpad>/self-review/` (use the session scratchpad from
your system prompt; else `mktemp -d`). Rounds go in `round-1/`, `round-2/`, …
Every `<…>` below is a placeholder you substitute before running the command,
and each one is a single token on purpose: unsubstituted, `<` and `>` are
redirections, so a placeholder containing a space would be read as two words and
the shell would consume the next flag as a filename instead of failing loudly.

Write the **INTENT block** first (the end of this section says what goes in it) to
`<work>/intent.md`, then set the round up in **one call**:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/round.sh" --work <work> --round 1 --intent <work>/intent.md \
  [--base <ref>] [--force S|M|L --reason "…"] [paths…]
```

That is scope, pre-flight, impact, tier, prior findings and every brief — one
turn, and it prints the tier line, the Agent-call table, and the pre-flight
verdicts last (they are what you act on before spawning anyone). **Do not run
those six scripts separately.** Measured in the 2026-08-29 loop smoke: the
session split this setup into five Bash calls in round 1 and
three in round 2 — eight full-context turns, on a context growing 18k → 58k, for
work with no judgment in it, on a two-line change. The scripts below are
documented so you can read what each one decided, and to fall back on if
`round.sh` is missing; they are not the normal path. That fallback does **not**
run `coldrun.sh`, so angle X is unavailable on it: either run `coldrun.sh` by
hand and pass its transcript to `brief.mjs --cold`, or do not spawn X. A grader
with no transcript can only file "not exercised", and it cost 237k tokens to do
that once. Every one of them carries
its usage in its header comment (the two shell scripts also print it on
`--help`; the four `.mjs` CLIs reject unknown flags instead), and
`docs/DESIGN.md` §4.1–§4.5 carries the full contract of each — so falling back
does not mean reconstructing flags from prose.

From round 2 on, `round.sh` passes round 1's tier to `tier.mjs` as a **ceiling**.
The scope is captured against HEAD, so a round reviewing the previous round's
fix sees the fix's lines *added* to the change's and the tier can only ratchet
up: in that same smoke a 2-line tier-S change whose round-1 fix added a 24-line
test file recomputed as M and spent two finders where round 1 had spent one.
Fixing a finding well must not cost more than finding it. `--force` still wins —
raising a round deliberately is a judgement the ceiling has no business
overriding, and it stays auditable in `tier.json`.

The work dir must live **outside** the repository under review (the session
scratchpad; else `mktemp -d`) — `round.sh` refuses otherwise, because scope.sh
would pick up the round's own `scope.diff`, `impact.json` and ledger as changed
files and the loop would review its own paperwork.

`${CLAUDE_PLUGIN_ROOT}` is the installed plugin directory; every path below is relative
to it. If it reaches you unexpanded and the shell does not have it either,
resolve it once and reuse it for the turn: `ls -dt ~/.claude/plugins/cache/*/self-review/*/ | head -1`
(when the gate has blocked you, its message already prints the absolute path of
`converged.sh` — the plugin root is its grandparent).

The `>` target is checked on its own as a file write (Claude Code's redirection
rule), which the session scratchpad passes. If a redirect is refused, add the
scratchpad path to your `Edit` allow rules rather than moving the work dir into
the repository.

It prints the changed-file list, the diff, and — unlike plain `git diff` —
every new, untracked file as a full addition. Pass `--base <sha>` when you
committed during this turn (the commit that was HEAD before your first one),
otherwise committed work is invisible. Outside git, pass the files you
produced: each is diffed against the repo it lives in when it has one (an installed
plugin's directory is not a checkout, so edits to the plugin itself come as full
text — review them in their repo instead) and printed in full otherwise. For a chat-only artifact (a plan, an analysis, an answer), write it to
`<work>/artifact.md` first and scope that. Exclude scratch and generated files.
A scope over ~2,500 lines is a signal to review the riskiest files now and
name the rest in the report, not to spawn more reviewers.

Read the scope yourself before spawning anyone — you are deciding the tier and
the angles, and you will be the one judging verdicts.

Write the **INTENT block** (template in `references/briefs.md`): what the user
asked in their words, the constraints, the **invariant** (the property that must
hold when this is done, written so it can be falsified — write it *before* the
code, since a change built to suppress a symptom rather than hold a property has
none, and that absence is itself the finding), what "done" means, the premise
(why the change has to exist — what already does the job, checked), what was cut
on purpose. Every brief carries it; it is what keeps reviewers from reviewing the
wrong thing or flagging deliberate cuts.

`round.sh` has already computed the blast radius and the plan — read what they
decided rather than re-running them:

`impact.mjs` reads the scope bundle (never git again — finders and impact must
see the same change), finds what still references the symbols the diff moved,
and writes `impact.md` (for the briefs) and `impact.json` (for `tier.mjs`). Its
first line is the summary; the row that earns it is **broken references** — a
symbol a hunk removed or renamed that something else still names. `tier.mjs`
classifies the paths, counts the lines, fires the risk markers, and writes
`tier.json`: the tier, the reasons that produced it, and the round's finder
rows. Both print a handful of lines and nothing else.

Read the reasons, not just the verdict, and keep the two judgments that stay
yours:

- **Raise** the tier when you see what line counts cannot — a flipped default,
  a semantic contract change inside 15 lines, a premise you already doubt.
- **Lower** only when you can say why the rule over-read the change.
- Either way it is `--force S|M|L --reason "…"`, and the reason lands in
  `tier.json` next to the tier the rules computed, in the marker summary and in
  the report. Raising is cheap to justify; forcing *down* is the one the numbers
  are watching.
- `split: true` means the scope is too big for one review: pick the riskiest
  paths, review those now, and name the rest in the report.

What each tier buys, so the finder table reads as costs:

| Tier | Finders (round 1) | Model | Verification |
|---|---|---|---|
| **S** trivial | 1, compact all-angles brief | sonnet · high | you, against the file |
| **M** standard | code 3 (+1 security) · docs 2 · config 1 — cap 6 | sonnet · high | you, against the file; a verifier only in the cases §2d names |
| **L** large / risky | code 4–6 · docs 3–4 · config 2 — cap 6 | sonnet · high; opus · high for the `G`/`H` finders | 1 verifier per batch of ≤ 8 candidates (opus · high) |

Tier S exists so a one-word fix costs one agent, not four — but it is still an
independent reader, never you re-reading.

If `impact.mjs` fails, `round.sh` says so on stderr and carries on without the
blast radius — the tier records that it could not check the cross-file rules,
and tier S is lifted to M because its caller clause is one of them. A
`tier.mjs` or `brief.mjs` failure ends the round, because there is then no plan
and no brief to spawn anyone with: rerun it, and if it keeps failing run
`brief.mjs --tier S|M|L` (§2b) to build a default plan for the tier you pick by
hand, with no impact block in the briefs. Either way, say in the report which
script did not run.

## 1 · Pre-flight: let machines catch what machines catch

`round.sh --round 1` already ran it and printed its verdict lines; the failure
tails are in `<work>/round-1/preflight.txt`, kept out of your context on purpose.
Run it directly only when re-checking a fix:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh" --root <repo> --out <work>/round-1/preflight.txt
```

It detects what the touched ecosystems actually have (package.json scripts,
ruff/mypy/pytest, go, cargo, Makefile targets, an executable `./test.sh`), runs
them, and writes one line per check with the tail of any failure — `--out`
keeps that tail out of your context. It exits 0 even when a check fails: the
report is the answer. Skip checks per project with `preflight.skip` in the
config.

`round.sh` runs it against a **copy** of the tree at
`<work>/round-1/cold run – ü/install`, not against the repository — same checks,
same cost, run from a path that is not the developer's, with an empty HOME. That
is why its header says `pre-flight (from …)`. A check that fails there and
passes in the checkout is the finding, not an artefact: something resolved a
path against where the code happens to live. Say so in the report, with both
results. Run by hand as above and you are back to the checkout, which is fine
for re-checking a fix — the fix is what you are testing, not the path.

Fix what fails before spending reviewers: formatter, linter, type-checker, the
relevant tests; for
configs, parse or dry-run (`jq`, `yq`, the tool's `validate`/`--dry-run`); for
docs, run the commands you documented and check the paths you cited. A
reviewer that reports a failing test is a wasted agent, and a reviewer reading
code that does not compile reviews the wrong thing. Record the commands and
real results — they go in the final report.

## 2 · A round

### 2a · The angle plan (`references/angles.md`)

`tier.json`'s `finders[]` is the round's plan: one row per finder, with its
angles, agent type, model, call budget and impact depth. Use it as written — it
encodes the groups below. When the round exceeded the cap of 6, `merged[]` says
which group was folded into which; name those in the final report, because a
merged angle got less attention than a whole finder.

The groups it encodes, for tier M — one finder each, launched in the same message:

- **code**: `A+B+D` (line scan, removed behaviour, pitfalls) · `C+E+F` (cross-file, intent fidelity, verification audit; add `H` if async/IO/shared state) · `Q+V` (quality + conventions). Add `G` security as a fourth finder when the change touches input, auth, files, network, shell, secrets, or HTML, and `X` as its own finder when the change touches something a user runs.
- **docs/prose**: `P1+P3` (accuracy + consistency) · `P2+V` (completeness, reader fit, conventions). Add `P4` for skills, prompts, agent files, CLAUDE.md, runbooks.
- **config/infra**: `K1+K2` in one finder.
- **shape**: `S`, added automatically from round 3 (and by hand whenever one unit takes findings in two rounds running). It is the only angle that may answer "delete it", so give it the ledger — its input is the fix history, not the diff alone.
- **cold run**: `X` is always its own finder and is never merged into another. Its reviewer is `self-review-cold-grader`, whose tool list has **no Bash**: `round.sh` runs `coldrun.sh` before the round, inside a sandbox that denies the network and confines writes, and the grader reads the transcript. That costs a whole finder wherever the change ships something runnable — including a third one in round 2 — and the alternative was a reviewer deciding for itself which invocation of possibly-broken code was safe to execute, which two shape reviewers running rejected as wrong-layer.
- **mixed**: take the union, but the cap (6 per round, at every tier) is per round, not per kind — merge groups within a kind to fit (e.g. code `A+B+D` · `C+E+F+H` · `G+Q+V`, docs `P1+P3` · `P2+P4+V`, config `K1+K2`), never drop a kind, and name in the report any angle that did not get its own finder. A finder still reviews one kind. `tier.mjs` applies this merge order itself and records it in `merged[]`.

Tier L splits the groups: code `A+B` · `C+D` · `E+F` · `Q+V` · `X` · `G` · `H`
(the last three only when applicable — `X` when the change touches an entry
point); docs `P1` · `P2+V` · `P3` · `P4` (P4 only for
skills, prompts, agent files, CLAUDE.md, runbooks); config `K1` · `K2`. Tier S
uses the compact brief.

### 2b · Spawn finders — fresh agents, in parallel, then stop

Use the Agent tool with the `subagent_type` each `finders[]` row names — normally
`self-review-finder` (read-only by instruction — its prompt forbids writes, and
it keeps Bash only to run tests and reproductions; its system prompt holds the
evidence standard, the output format, and the sonnet · high default), and
`self-review-cold-grader` for the angle-`X` row, which is the same reviewer with
**no Bash at all**. Spawn what the row says: substituting the finder there hands
a shell to the one angle whose whole design is that it does not have one. If a
type is missing, use `general-purpose` and paste the contents of that agent file
(`${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`) at the top of the brief. Write the briefs with one call rather than by hand — assembling them costs 4–6
calls per round and gets a section wrong sooner or later:

`round.sh` wrote them; the Agent-call table it printed is the round's plan.

`findings.mjs prior` writes the ≤ 10 findings past reviews of this repository
recorded against the files this change touches (same file, then same directory,
then the same class of finding), one line each. `--work <work>` is this review's
work dir — the same one every other command in this skill gets; the review's
identity is derived from it, so *this* review's own records stay out of its own
briefs with nothing to retype. That is the same rule as the ledger: a finder is
never told what was just fixed. The file is written even when it is empty, so
the `&&` chain does not break on a repository with no memory yet.

It writes one brief per `finders[]` row from the template in
`references/briefs.md`: the angle text verbatim from the catalogue, the intent
block, the scope pointer, the impact block at that row's depth, the dismissed
ledger, the call budget, and a state file path
(`<work>/round-<r>/state/<name>.jsonl`) the reviewer appends its findings to as
it works — the lifeboat §2f salvages (the `state/` dir is made during scope
capture, §0). Each brief is held to the token budget (`brief.maxTokens`) and
says in its own header what it had to trim. Then it prints the Agent-call
table: one line per finder with its name, agent type, model and brief path.
Without `tier.json`, `--tier S|M|L` builds that tier's default plan.

**Pass the brief as a path, not as text**: the Agent prompt is
`Read <brief path> and follow it.` — about 30 tokens instead of the ~1,300 an
inlined brief costs, on every finder of every round. Launch all finders of the
round in **one message**, then end the turn with the one-line status (rule 1
above). Finders run in the background: in current builds the
main session's Agent tool always launches them that way and wakes you as each
one completes (pass `run_in_background: true` where a build exposes it). If
your Agent tool says only synchronous subagents are supported, you are inside
a subagent — the results come back in the same call and there is nothing to
wait for. While they read, do not edit, commit, or rebase the
files in scope — a finder reviewing a tree that moved returns line numbers
that point nowhere.

Never use a fork for a reviewer and never review inline "to save time": a fork
inherits the exact context that produced the mistake, and inline review is the
thing this skill exists to replace. If the Agent tool is unavailable in your
context, work through every angle yourself, sequentially, and say so in the
report — an honest single-pass is fine; a single-pass described as the loop is
not.

A finder that comes back `failed` or `stopped` gets salvaged first (§2f),
then re-spawned once at most; if that fails too, its angle is uncovered — say
so in the report rather than waiting.

### 2c · Collect and deduplicate

A finder's report is its last message, which the wake-up does not carry. Read
every report in one call: `scripts/salvage.mjs <session-id> <name> <name>…`
prints each named agent's report (no names: lists the agents; the session id
is the UUID in your scratchpad path). In the same call, run
`scripts/treecheck.sh --work <work> --round <n>`: it is silent unless the
working tree moved while the reviewers ran, and the one line it prints goes
into your report **verbatim** — a reviewer that wrote into the repository, or
undid something to clean up after itself, has taken uncommitted work with it.
Then parse each finder's JSON. Give every candidate an id (`r1-1`, `r1-2`, …). An
`omitted` count on a sixth candidate means that finder cut real findings: its
angle is not covered — re-run it on a narrower scope or say so in the report.
Merge candidates that point at the same line and mechanism, keeping the one
with the most concrete failure scenario. Drop nothing else — a finder's
low-confidence candidate is still a candidate; verification decides.

### 2d · Verify

Verification is cheap when it is concrete: a candidate says *line 46 claims X;
line 80 contradicts it*, and reading those lines settles it. So by default
**you** verify, with the rubric in `${CLAUDE_PLUGIN_ROOT}/agents/self-review-verifier.md`:
open the cited range, quote the proof or the counter-proof into the ledger,
give the verdict. The rule that keeps this honest: **a dismissal without a
quoted counter-proof is not a dismissal** — it is an unverified candidate, and
it gets a verifier.

Spawn `self-review-verifier` agents (one per batch of ≤ 8 candidates, in one
message, then end the turn) when:

- the tier is L;
- dismissals in the round reach three in total — counted across every
  verification pass, not per batch — that is the author's bias the loop exists
  to counter, so an outsider rules on all of them, the earlier ones included;
- a candidate's fix would change behaviour, a contract, or a stated decision,
  and you are not certain.

Decide per verdict:

| Verdict | `fix_risk` | Action |
|---|---|---|
| CONFIRMED | any | fix now |
| PLAUSIBLE | low | fix now (a guard, a test, a corrected sentence is cheaper than the argument) |
| PLAUSIBLE | design | **open** — report to the user as a question with your recommendation |
| REFUTED | — | **dismissed** — ledger entry with the refuting proof |

Read the proofs, do not just count verdicts. A verifier that refutes with "the
caller always passes a non-empty list" while you can see a caller that does not
is wrong; override it, and note why in the ledger.

### 2e · Fix

**Name the root cause before you write anything.** Every finding is one of two
kinds, and they take opposite fixes:

- *Local defect* — the shape is right, this line is wrong. Patch it.
- *The shape* — the code is doing what it was designed to do, and the design is
  wrong. **Do not patch it.** A patch here produces working bad code, and the
  next round finds the same defect through the door beside the one you locked.
  Replace, move, or delete the mechanism, or stop and run angle S if you cannot
  see which.

Say which kind it is in the ledger entry, and for a fix, **name the invariant it
restores** — not the exploit it blocks. "Blocks `../secret.json`" is the arms-race
signature; "the tool only opens files inside the repo under review" is a
property. A fix you can only describe as blocking a specific input is a fix that
has not found the root cause: escalate it to angle S rather than committing it.
Two rounds of findings in the same unit ends the choice — the next round runs
angle S, and that unit gets no further patch until its invariant is written.

Then apply the fixes yourself — you hold the task context that makes a fix
correct rather than merely local. Smallest change that resolves the finding; no
opportunistic refactors, which would widen the next round's scope for no
reason. Batch the edits; load `clean-code` (and `react-patterns` /
`frontend-craft` when the rules call for them) as for any edit. Bug fixes get
the failing test first when the project has tests. Re-run the pre-flight
checks that the fixes could have broken.

Update the ledger (`references/briefs.md` → ledger format): fixed, dismissed,
open. Then record the round's verdicts — one call, batched with the fixes:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/findings.mjs" record --work <work> --round 1 <<'JSON'
[{"verdict":"fixed","file":"src/x.ts","line":41,"severity":"major","class":"correctness",
  "angle":"A","summary":"null deref on empty list","mechanism":"local defect",
  "proof":"x.ts:41 returns undefined for []"}]
JSON
```

One object per finding you acted on, `verdict` `fixed`/`dismissed`/`open`,
`class` from the finder's `category` vocabulary. When the finder's candidate
carried a `prior_id` — the id of the `prior.md` line it was re-raising, the eight
characters that line shows in brackets
— copy it onto the record unchanged. It is the finder's own answer to a question
nothing downstream can reconstruct as well, and dropping it is silent: the
record still writes, and the memory is then measured on a guess (DESIGN §4.4).

The `record` call appends to a per-repository
file under `~/.claude/self-review/findings/` (keyed by the hashed `origin`, so
clones share one memory), never inside the repository — a memory file in the
tree would be a changed file the next review has to review. It validates every
record before it writes any, so a rejected call costs a retry, not half a
round.

### 2f · If a reviewer dies, salvage before you re-spawn

Sessions get killed mid-round — the usage-limit reset is the common case — and
the reflex of re-spawning every silent reviewer re-pays 90–150k of context per
agent for work that already happened: a subagent's transcript survives on disk
even when its delivery did not, and this session's own round 3 was recovered
exactly that way. So when a reviewer dies, goes idle without a report, or you
resume after a reset:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" <session-id>            # each agent: finished/partial, calls, context
"${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" <session-id> <name>     # its last message (--all-text: every text block)
```

The session id is the UUID in your scratchpad path; the briefs in
`round-<r>/briefs/` say who was launched. Then:

- **finished** — its last message is the report. Use it as delivered; never
  re-spawn an agent whose report already exists.
- **partial** — read its state file (`round-<r>/state/<name>.jsonl`): the
  findings it had confirmed before dying. Re-spawn the angle only when the
  state file and the transcript's salvaged text are both empty — a partial's
  informal notes count as salvage too — and paste whatever survived into the
  new brief marked "already found — verify, do not re-derive, continue from
  here", so the dead agent's tokens still bought something.

## 3 · Converge or go again

A round is **clean** when it produced zero findings to fix — zero CONFIRMED
and zero PLAUSIBLE/low-risk (open design items and dismissed items do not
count). A round ends the loop **as done** in exactly two ways: it is clean, or
it is *effectively converged* — its only findings are manufactured or dismissed
(the rule below). Nothing else ends it as done: not a round that merely found
less, not a counter running out. Everything else either goes again or escalates.

**A fix to a trust boundary does not converge on generic finders.** When a
round's fix changes what untrusted input may do — a permission, an exemption, a
path the tool opens on someone else's say-so, anything the reviewed repository
itself can set — the next round must carry one finder briefed on that boundary
alone, told what the earlier attempts were and that each of them failed. The
loop may not report converged while the newest bound has only ever been read by
finders that were looking at something else. This plugin's own
`tier.markerDeclaring` cost eight defects over six rounds — a glob that blinded
every scan, then any config-kind file (`Dockerfile`, `docker-compose.yml`),
then `../secret.json` walking out of the repo, then `package.json`, which npm
executes, then the shipped default path itself, which any reviewed repo could
fill with a 28-byte file — and every one after the first came from a finder
pointed straight at it. Note what that fifth one was: the *fix* that removed
the setting from the untrusted layer introduced it. Changing the shape of a
bound is still a change to a bound, so it earns the same adversary as the patch
it replaced. And note how it ended: round 7 asked §2e's question — is this the
right solution, or a working version of the wrong one? — and deleted the
mechanism. Six rounds of hardening bought less than one round of asking whether
the thing needed to exist. When a bound keeps taking findings, that is evidence
about the design, not just about the patch.

The number of rounds is an **outcome, not a setting**: you stop when the work
has converged or has provably stopped converging, not when a counter runs out.
A fixed cap has a specific failure — a round that fixes ten findings and then
stops leaves those ten fixes unreviewed, which is exactly the state this loop
exists to prevent (a fix is a new change that can be wrong). So decide from the
trend:

- **Clean round → converged.** Go to §4.
- **The round fixed something → another round is mandatory** unless a check
  below stops the loop first. Its fixes are themselves unreviewed. Re-capture
  the full scope (so it includes the fixes) and run fresh finders — taper the
  count as the change is mostly already reviewed and only the fixes are new (≈2
  at round 2, 1 from round 3 on, angle groups merged, never an angle dropped,
  and tell them to weight the changed lines while staying free to flag ripple
  elsewhere). They get the dismissed ledger and nothing about what you fixed, so
  each fix must pass as correct on its own. **You therefore never declare done
  right after fixing** — the last thing the loop does is confirm a clean round,
  judge a round effectively converged, or hand a stalled state to the user.
- **Before running that mandatory round, check the loop is still converging.**
  `record` (§2e) has already written this round's verdicts, so this is a
  command, not arithmetic you carry in your head:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/findings.mjs" converge --work <work> --round <N> --budget <budget>
```

  It prints each round's `W = 3·blockers + 2·majors + 1·minors` over what that
  round **fixed**, compares the two rounds over the angles they share, and says
  `CONTINUE` or `ESCALATE`. The restriction is what "compare like with like"
  means: angle S arrives by rule at round 3 (§0) and files every non-`sound`
  verdict as a `blocker` by construction, so an unrestricted `W` reads as an
  increase and stops a loop that is converging — it did exactly that to this
  tool's own review, 11 → 4 → 9 (DESIGN §7.7). A round still fixes everything
  it finds; a newly-arrived angle's findings are the baseline the *next* round
  is compared against. A finder that merged angles (`A+B+D`) counts as having
  run every one of them, and its weight joins the comparison only when all of
  them are shared — without that, the taper in §2a would make consecutive rounds
  permanently incomparable and leave the round cap as the only thing that can
  stop the loop. `converge` decides the `W` rule and nothing else — the round
  cap and the oscillation check below are yours. If it writes `N records did not
  match the record schema` on stderr, the findings file holds corrupted rows:
  they are dropped where the file is read, so nothing in them reaches `W`, the
  angle sets or the verdict — but a dropped row is a finding this loop has
  forgotten, so read them before trusting a `CONTINUE`.

  **Stop and escalate to the user** — surface the state, do not declare done —
  when any of:
  - `converge` says `ESCALATE` — `W` over the angles the round shares with its
    predecessor did not drop (a plateau, or an increase: the fixes are not
    shrinking the problem, or one spawned another);
  - **oscillation** — a round flags a previous round's fix as wrong; do not
    flip it back, surface both positions;
  - the **round budget** — **2 rounds at tiers S and M, 6 at tier L** — which
    is `--budget` above, so `converge` answers `STOP` itself instead of leaving
    a ceiling in prose that cannot see the signal it is overriding. A spent
    budget is a bound on cost, never a finding of health: report that round's
    fixes as unreviewed, and never write a `STOP` up as clean.
    **One extension, at any tier**: a round that **fixed a blocker or a major**
    buys exactly one more round — that fix is the kind a cap must not leave
    unread — run as a single tier-S finder (compact brief) scoped to that
    round's changed lines only. A round that fixed only minors, or only
    dismissed findings, buys nothing: nothing changed that a reader has not
    already seen (measured 2026-08-22: rounds 3+ rarely closed). The extension
    is single-shot — the round it buys cannot buy another — and `converge`
    enforces both halves, so the budget you pass is the budget you get.
    The trust-boundary rule above outranks it: a fix that moved a trust
    boundary gets its dedicated finder even when that round is one the budget
    did not buy. A tier-L change still unclean after six rounds is too big for
    the loop; split it and involve the user.

  `W` is a non-negative integer that must strictly drop to continue, so once
  two consecutive rounds share an angle the loop terminates on its own: it
  reaches a clean round, an effectively-converged round, or a stall it hands to
  you. That condition is load-bearing, not a formality — angles are compared as
  the *sets* a finder covered exactly so the taper above cannot make
  consecutive rounds incomparable, and for as long as it could, the budget was
  the only thing that ever stopped this loop (DESIGN §7.9). A shrinking tail of
  minors now runs to completion inside the budget instead of being cut off at
  an arbitrary number — which is not the same as buying more budget, and does
  not; a blocker that keeps coming back forces the user in instead of being
  left fixed-but-unreviewed. Escalation is not failure — it is the honest
  output when the change needs a decision the loop cannot make.
- **A round of only manufactured findings is effectively converged — stop, do
  not lap.** Reviewers are asked to find things, so a tired loop keeps producing
  things: taste, a speculative "could maybe", a guard against a state no caller
  reaches, a reword with no reader or machine effect. Those are not findings —
  the finder and verifier rubrics already say so — and they must not keep the
  loop alive. When you verify a round, hold every survivor to the same bar a
  dismissal uses (a concrete failure scenario, or a stated rule it breaks) and
  record why any that fail it fail, exactly like a dismissal — a judgment
  without a written reason is not one. A round whose findings are **all**
  dismissed or manufactured is effectively converged: mark it done. Never apply
  a change whose only purpose is to make a finding disappear — a cosmetic "fix"
  is a new, unreviewed change that manufactures the next round's work, which is
  how a review runs eleven times on already-correct code. If you cannot tell
  whether the survivors are real, that uncertainty is the signal to stop and put
  them to the user as open items, not to fix-and-spin.
- If the user interrupts, stop immediately; do not run `converged.sh`.

## 4 · Mark convergence, then report

When `tier.json` carries `coldSkipped`, say so in the report: the cold run
either failed or executed nothing, so angle X was dropped and nothing in the
change was exercised. It is a note, not a finding.

The marker has two forms and the gate treats them the same. Both carry the
**typed record** — you name the fields, the tool writes the string. You do not
compose a summary any more: 14 of the first 112 markers were prose with no
counts in them, and nine more carried counts that were not numbers, so the loop
could not measure itself.

**`converged` needs a reviewer completion behind it, and the gate checks.** It
is refused unless a `self-review-finder` or `self-review-cold-grader` finished
**after your last change and before the marker** — so the order is: last fix,
then a finder that completes, then the marker, with nothing edited in between.
That is §3's "you never declare done right after fixing" made mechanical, and
it is the same order the loop already runs in; you only trip it by editing
after the final round or by marking a review you did not spawn. A verifier does
not count — it presupposes findings, and if you generated them you reviewed
your own work. One finder is the floor, because tier S *is* one finder. The
other two outcomes are honest claims that need no reader and are never gated:
if the round did not close, that is `--not-converged` with real counts; if the
loop did not apply, `--not-applicable` with its reason.

**Write the file** — the default, because a scratch write needs no permission
rule anywhere:

```
Write  <work>/CONVERGED.json          # i.e. <scratchpad>/self-review/CONVERGED.json
{"outcome": "converged", "rounds": 2, "fixed": 3, "dismissed": 1, "open": 1, "tier": "M", "adapter": "grep"}
```

**Or run the script**, which logs itself and works when the work dir is not
scratch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/converged.sh" --converged --rounds 2 --fixed 3 --dismissed 1 --open 1 --tier M --adapter grep
```

### The record

| field | when | what |
|---|---|---|
| `outcome` | always | `converged`, `not-converged`, or `not-applicable` |
| `rounds` `fixed` `dismissed` `open` | `converged` / `not-converged` | non-negative integers, and `rounds` is at least 1 — a review that ran no round is `not-applicable`; all four are **refused** for `not-applicable` |
| `reason` | `not-applicable` only | `no-code-changed`, `user-declined`, `scratch-only`, `other` |
| `note` | optional; required for `reason=other` | free text — the only free text there is, and it never enters the summary |
| `tier` `adapter` | always | `tier` is `S`, `M` or `L` from `tier.json`; `adapter` from `impact.json` (`adapter=none` when impact.mjs wrote nothing) |
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

If the loop stopped short of a clean round — a stall, oscillation, or the round
backstop (§3) — that is `--not-converged` with its real counts, and report the
open state.

### Where it counts

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

Either way: the marker is what the Stop gate looks for — not a sentence saying
you reviewed, not a clean round that was never marked. Mark only after the
final round, and edit nothing after it (an edit after the marker re-arms the
gate, correctly, because that edit was never reviewed). Give the marker a
message of its own — the one step that must not be batched: the gate orders by
transcript entry, so a write in the same command or a parallel tool call in the
same message shares the marker's position, and the gate never clears
(scratch-only writes are exempt, so deleting this loop's own scratch files
beside it is fine).

Then the final report (format in `references/briefs.md`): outcome first —
rounds, fixed, dismissed, open — then one line per fix, the open questions
with recommendations, and the checks you ran with their real results.

## Things that break the loop (and what to do instead)

- **Polling.** "I'll wait for the notification" followed by `ListAgents` is
  the failure this skill is budgeted against. End the turn.
- **Reviewing with your own eyes and calling it a round.** Spawn the agent;
  tier S is one agent, not zero.
- **Spawning a panel.** Fourteen finders on one change is not thoroughness,
  it is the budget. The tier table is the ceiling.
- **Editing while a round is in flight.** Wait for the last finder; then act.
- **Finders that self-censor.** The brief and the agent prompt both say pass
  half-believed candidates through. If a finder returns `[]` on a large,
  logic-heavy change, check its transcript before trusting it.
- **Dismissing without a counter-proof**, or "fixing" a REFUTED finding to be
  safe — the first ships bugs, the second adds them. The ledger carries the
  proof either way.
- **Telling the next round what you fixed.** It biases them into confirming.
  They get the dismissed list only.
- **Re-spawning a dead reviewer without salvaging.** Its transcript and state
  file (§2f) hold what it already found; a fresh spawn re-pays that context
  from zero.
- **Scope drift.** Fixes are minimal; a refactor you noticed goes in the report
  as a suggestion, not into this turn.
- **Declaring clean on a round that merely found less.** Clean is zero (§3). A
  round that found *only manufactured* findings is a different, deliberate
  judgment — "effectively converged", each survivor refuted with a written
  reason (§3) — not "I found less real stuff and I'm tired". If you can't tell
  which it is, escalate; don't declare.
- **Reviewing scratch, generated, or vendored files.** Exclude them from scope.
- **Batching the marker with a real change.** A write in the same command or
  a tool call in the same message shares its position, and the gate cannot
  tell which came first, so it never clears. A message of its own (scratch
  cleanup beside it is fine).
- **Skipping the marker** or running it before the last fix. The gate will
  send you back; do it in order.

## On demand and beyond files

`/self-review <target>` reviews whatever is named — a path, "the plan above",
"my last answer", a PR branch (`--base` does the rest). For chat-only
artifacts, write the artifact to `<work>/artifact.md`, scope it, and use the
docs angles plus this question in the intent block: *does it answer what was
asked, with evidence, and are its assumptions stated?*

## Files

Everything below lives under `${CLAUDE_PLUGIN_ROOT}`, the installed plugin directory.

- `scripts/round.sh` — **the entry point**: a whole round's setup in one call, and the tier ceiling a later round inherits (§0)
- `scripts/lib/path.sh` — `abs_path`, shared by `round.sh` and `scope.sh`
- `scripts/scope.sh` — scope bundle (diff + untracked files; each path diffed against its own repo, plain text only for paths in none)
- `scripts/impact.mjs` — blast radius: broken references, tests, callers, docs (§0); writes `impact.md` + `impact.json`
- `scripts/tier.mjs` — the tier, its reasons, and the round's finder rows (§0); writes `tier.json`
- `scripts/brief.mjs` — one brief per finder row, held to the token budget (§2b)
- `scripts/findings.mjs` — `prior` for the briefs, `record` for the round's verdicts, `converge` for the W rule (§2b, §2e, §3)
- `scripts/preflight.sh` — the project's own checks for the touched ecosystems (§1)
- `scripts/audit.mjs` — what a review cost, per review, from the session transcripts
- `scripts/converged.sh` — the script form of the marker (§4) + `~/.claude/self-review/log.jsonl`
- `scripts/salvage.mjs` — read a finder's report from its transcript (§2c); the same path recovers a dead reviewer's work (§2f)
- `skills/self-review/references/angles.md` — the angle catalogue, per artifact kind
- `skills/self-review/references/briefs.md` — intent block, finder/verifier briefs, ledger, report
- `agents/self-review-finder.md`, `agents/self-review-cold-grader.md`, `agents/self-review-verifier.md` — the reviewer agents
- `scripts/coldrun.sh` — the contained cold run behind angle `X`; run by `round.sh`, never by a reviewer
- `hooks/self-review-gate.mjs` — the Stop gate that enforces all of this
- `hooks/poll-guard.mjs` — the PreToolUse hook that denies repeated status checks
- `hooks/lib/hook.mjs` — shared fail-open `runHook()` entry point of both hooks
- `config/defaults.json` — gate exemptions, the hook limits, and the `tier` / `impact` / `brief` / `preflight` rules; override per user in `~/.claude/self-review/config.json`. A repository's own `.self-review.json` is **default closed**: it may only *add* marker words to `tier.riskPaths` and `tier.riskContent`, so a repository can make its own review stricter and nothing else
