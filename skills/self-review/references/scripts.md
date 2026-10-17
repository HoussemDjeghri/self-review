# Scripts reference — what `round.sh` and its helpers decide

`SKILL.md` says what the orchestrator does, in order, and which script to call
for it. This file is what those scripts do underneath: read it to understand
a decision a script printed, to fall back when `round.sh` is missing, or to
change configuration — not mid-round.

## Config

Model and effort per agent type are rows of `config/agents.json` (shipped, not
user-overridable; see SKILL.md Models); the cap, the call budgets and the round
caps are `tier.finders` (SKILL.md, top section). What the plugin reads from
`${CLAUDE_PLUGIN_ROOT}/config/defaults.json` is the gate's business — the file
kinds it exempts, `exempt.paths` (absolute globs, user-only: a repository's
`.self-review.json` cannot set it), `gate.maxReminders`, `pollGuard.maxChecks` —
overridden per user in `~/.claude/self-review/config.json` (objects merge,
arrays replace).

## The work dir

`round.sh` refuses a second round 1 in one dir and a round whose predecessor is
missing, so two reviews cannot share a work dir by accident. A round 1 given
`--force` again is a **re-plan**, not a second round 1: it re-runs only
`tier.mjs` and `brief.mjs` over the scope round 1 captured, reuses the cold run,
and keeps the old plan as `tier.replaced-<n>.json` and `briefs.replaced-<n>/`.
It is refused (exit 2) once `round-2/` exists, once a finder has filed into
`round-1/state/`, or when paths or `--base` are given — re-scoping is a new
review. From round 2, a `STOP` or `UNRECORDED` verdict on the previous round
refuses the round (exit 5, nothing created) and prints the `next:` call. A
later round also refuses paths and `--base`, a review dir with no recorded
round-1 scope (`scope-args`, `scope-cwd`: one begun before rounds replayed it),
and a round-1 cwd that no longer exists. Finish such a review as not-converged,
or start it again with `--new-review`.

The `>` target is checked on its own as a file write (Claude Code's redirection
rule), which the session scratchpad passes — hence SKILL.md §0's advice when
one is refused.

Every `<…>` in SKILL.md is a placeholder you substitute before running the
command, and each one is a single token on purpose: unsubstituted, `<` and `>`
are redirections, so a placeholder containing a space would be read as two words
and the shell would consume the next flag as a filename instead of failing
loudly.

## Without round.sh

The scripts below are documented so you can read what each one decided, and to
fall back on if `round.sh` is missing; they are not the normal path. That
fallback does **not** run `coldrun.sh`, so angle X is unavailable on it: either
run `coldrun.sh` by hand and pass its transcript to `brief.mjs --cold`, or do
not spawn X. A grader with no transcript can only file "not exercised". Every
one of them carries its usage in its header comment and prints it on `--help`,
so falling back does not mean reconstructing flags from prose.

A hand-built round is recordable only if it writes what `record --work` reads.
`<w>` is a fresh `<reviews>/review-<k>/` you allocate by hand — outside the
repository (`scope.sh --work` refuses one inside it), and never reused, since the
review id is a hash of the path and a reused dir merges two reviews. Write the
INTENT block to `<w>/intent.md` first; then, for round `N`:

```bash
mkdir -p <w>/round-N
scope.sh --work <w> [--base <ref>] [paths…] > <w>/round-N/scope.diff
tier.mjs --scope <w>/round-N/scope.diff --out <w>/round-N/ --round N [--cap <round 1's tier>]
brief.mjs --round N --plan <w>/round-N/tier.json --intent <w>/intent.md --scope <w>/round-N/scope.diff --out <w>/round-N/briefs/
# spawn the printed Agent lines, wait, verify; write the verified candidates to <w>/round-N/findings.json
findings.mjs record --work <w> --round N --in <w>/round-N/findings.json
```

`record` refuses an empty batch (exit 3, no receipt) while `round-N/state/`
holds candidate objects in any `*.jsonl` file but a `self-review-verifier-*` one.

From round 2 on, give `scope.sh` round 1's `--base` and paths again — without
them it scopes the whole working tree — and give `tier.mjs` `--cap` (round.sh
also passes `--cap-markers` with round 1's non-empty markers; without it every
escalating marker round 1 already had counts as new and lifts the ceiling). A hand-built review stays hand-built:
`round.sh` refuses its round 2, because it replays `round-1/scope-args` and
`scope-cwd`, which only `round.sh` writes — do not write them by hand.
`brief.mjs --tier S|M|L` is the last resort for when `tier.mjs` itself cannot
run; it writes no plan, so that round cannot be recorded with `--work` and the
review ends not-converged.

## Plugin root

If `${CLAUDE_PLUGIN_ROOT}` reaches you unexpanded and the shell does not have it
either, resolve it once and reuse it for the turn:
`node "$(ls ~/.claude/plugins/cache/*/self-review/*/scripts/root.mjs | head -1)"` — any cached
copy prints the *installed* version's root from `installed_plugins.json`
(when the gate has blocked you, its message already prints the absolute path of
`converged.sh` — the plugin root is its grandparent).

## When a script fails

If `impact.mjs` fails, `round.sh` says so on stderr and carries on without the
blast radius — the tier records that it could not check the cross-file rules,
and tier S is lifted to M because its caller clause is one of them. A
`tier.mjs` or `brief.mjs` failure ends the round, because there is then no plan
and no brief to spawn anyone with: rerun it, and if it keeps failing run
`brief.mjs --tier S|M|L` (§2b) to build a default plan for the tier you pick by
hand, with no impact block in the briefs. Either way, say in the report which
script did not run.

## What round.sh computed

**Scope** (`scope.sh`). It prints the changed-file list, the diff, and — unlike
plain `git diff` — every new, untracked file as a full addition. Pass
`--base <sha>` when you committed during this turn, otherwise committed work is
invisible.

**Impact** (`impact.mjs`) reads the scope bundle (never git again — finders and
impact must see the same change), finds what still references the symbols the
diff moved, and writes `impact.md` (for the briefs) and `impact.json` (for
`tier.mjs`). Its first line is the summary; the row that earns it is **broken
references** — a symbol a hunk removed or renamed that something else still
names.

**Tier** (`tier.mjs`) classifies the paths, counts the lines, fires the risk
markers, and writes `tier.json`: the tier, the reasons that produced it, and the
round's finder rows. Both print a handful of lines and nothing else.

## Pre-flight

`preflight.sh` detects what the touched ecosystems actually have (package.json
scripts, ruff/mypy/pytest, go, cargo, Makefile targets, an executable
`./test.sh`), runs them, and writes one line per check with the tail of any
failure — `--out` keeps that tail out of your context. It exits 0 even when a
check fails: the report is the answer. Skip checks per project with
`preflight.skip` in the config.

`round.sh` runs it on a staged copy whose path holds a space, an en dash and
`ü` on purpose, and says so under the verdicts when a check fails there. The
three usual causes of a failure that the checkout does not reproduce: a
percent-encoded URL path — `new URL(import.meta.url).pathname` yields `%20` and
`%C3%BC`, `fileURLToPath` does not — an unquoted shell variable splitting on the
space, and code that assumes ASCII paths. It is the project's bug, and a
finding.

**`preflight.artifactRoot`** is the other pre-flight key, and it is off by
default. Name a subdirectory (`"plugin"`) and round 1 also copies it out and
runs its `*.test.mjs` files with that subdirectory as the root — the one shape
a project that ships a subdirectory never tests in, where a test that walks
upward leaves the artifact and a test naming a repo-root path finds nothing.
`PASS`/`FAIL` lines say what happened; `SKIP` means the directory held no node
tests, which is not a failure of the repository under review.

Know the blast radius before setting it: it is not a key a repository may set
(a repository cannot be trusted to widen what runs on the machine reviewing it),
so the only place it can be set is your own `~/.claude/self-review/config.json`,
which is global to you. Setting it for one project names that subdirectory in
**every** project you review afterwards.

`round.sh` runs pre-flight against a **copy** of the tree at
`<work>/round-1/cold run – ü/install`, not against the repository — same checks,
same cost, run from a path that is not the developer's, with an empty HOME.

## Briefs

`brief.mjs` writes one brief per finder row and prints the `Agent` line that
spawns it. Each brief carries the intent block, the scope pointer, that row's
angle text verbatim from the catalogue, the impact block at its depth, the ≤ 10
prior findings this repository recorded against these files, the dismissed
ledger, a state-file path the reviewer appends candidates to as it works (the
lifeboat §2f salvages), and the call budget — held to `brief.maxTokens`, saying
in its own header what it had to trim. Passing the brief as a path costs about
30 tokens of prompt instead of the ~1,300 an inlined brief costs, on every
finder of every round.

## Findings memory

The `record` call appends to a per-repository file under
`~/.claude/self-review/findings/` (keyed by the hashed `origin`, so clones share
one memory), never inside the repository — a memory file in the tree would be a
changed file the next review has to review. A record missing the finder's
`prior_id` still writes, and the memory is then measured on a guess.

## Files

Everything below lives under `${CLAUDE_PLUGIN_ROOT}`, the installed plugin directory.

- `scripts/round.sh` — **the entry point**: a whole round's setup in one call, the tier ceiling a later round inherits, the round-1 re-plan, the replay of round 1's scope for every later round, and the refusal after `STOP` (§0)
- `scripts/lib/path.sh` — `abs_path`, shared by `round.sh` and `scope.sh`
- `scripts/scope.sh` — scope bundle (diff + untracked files; each path diffed against its own repo, plain text only for paths in none)
- `scripts/impact.mjs` — blast radius: broken references, tests, callers, docs (§0); writes `impact.md` + `impact.json`
- `scripts/tier.mjs` — the tier, its reasons, and the round's finder rows (§0); writes `tier.json`
- `scripts/brief.mjs` — one brief per finder row, held to the token budget, and the `Agent` line for each (§2b); `--verify` does the same for a verifier batch (§2d)
- `scripts/findings.mjs` — `prior` for the briefs, `record` for the round's verdicts, `converge` for the W rule and the round cap; `record` and `converge` print the verdict and its `next:` call (§2b, §2e, §3)
- `scripts/preflight.sh` — the project's own checks for the touched ecosystems (§1)
- `scripts/wait.mjs` — the one-call wait on a round's agents (rule 1)
- `scripts/treecheck.sh` — says whether the working tree moved while reviewers ran (§2c); `--changed` lists what moved since a round's snapshot, which `round.sh` adds to a path-scoped later round
- `scripts/reviews-dir.sh` — the headless `<reviews>`: one private dir per `$CLAUDE_CODE_SESSION_ID`, refused rather than replaced (§0)
- `scripts/root.mjs` — prints the installed plugin root when `${CLAUDE_PLUGIN_ROOT}` is unexpanded (§0)
- `scripts/audit.mjs` — what a review cost, per review, from the session transcripts
- `scripts/converged.sh` — the script form of the marker (§4) + `~/.claude/self-review/log.jsonl`
- `scripts/branch-debt.mjs` — branch review: `--id` prints the id to opt a repository in under (`repos.<id>.branchDebt` in the user config), no flag prints its branch, baselines and debt; read-only
- `scripts/salvage.mjs` — read a finder's report from its transcript (§2c); the same path recovers a dead reviewer's work (§2f)
- `skills/self-review/references/angles.md` — the angle catalogue, per artifact kind
- `skills/self-review/references/briefs.md` — intent block, finder/verifier briefs, ledger, report
- `skills/self-review/references/recovery.md` — a dead, stalled or silent agent (§2f)
- `skills/self-review/references/converge.md` — the `W` arithmetic and the tree-guard audit (§3)
- `skills/self-review/references/marker.md` — the marker's record fields and where it counts (§4)
- `skills/self-review/references/scripts.md` — this file
- `agents/self-review-finder.md`, `agents/self-review-cold-grader.md`, `agents/self-review-verifier.md` — the reviewer agents
- `agents/self-review-applier.md` — the writing hand (§2e): one per round, no shell
- `scripts/coldrun.sh` — the contained cold run behind angle `X`; run by `round.sh`, never by a reviewer
- `hooks/self-review-gate.mjs` — the Stop gate that enforces all of this
- `hooks/poll-guard.mjs` — the PreToolUse hook that denies repeated status checks
- `hooks/tree-guard.mjs` — the PreToolUse hook that contains reviewers, matched on the name an agent runs under
- `hooks/lib/hook.mjs` — shared fail-open `runHook()` entry point of the hooks
- `config/defaults.json` — gate exemptions, the hook limits, and the `tier` / `impact` / `brief` / `preflight` rules; override per user in `~/.claude/self-review/config.json`, and per repository from that same user file (`repos.<id>`: the branch-review opt-in and a tier overlay). A repository's own `.self-review.json` is **default closed**: it may only *add* marker words to `tier.riskPaths` and `tier.riskContent`, so a repository can make its own review stricter and nothing else
