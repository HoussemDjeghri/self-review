<div align="center">

<img src="assets/logo.png" width="132" alt="self-review logo: a terminal window circled by a review loop, with a check mark where the loop closes">

<h1>self-review</h1>

<p>A Claude Code plugin that won't let Claude end a turn until fresh subagents have reviewed the code it changed.</p>

<p>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-D97757">
  <img alt="version 0.11.2" src="https://img.shields.io/badge/version-0.11.2-191919">
  <img alt="dependencies: node and bash" src="https://img.shields.io/badge/deps-node%20%2B%20bash-D4A27F">
  <img alt="no daemon" src="https://img.shields.io/badge/no-daemon-555">
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#what-it-looks-like">What it looks like</a> ·
  <a href="#how-a-review-runs">How a review runs</a> ·
  <a href="#design-choices">Design choices</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#reference">Reference</a>
</p>

<img src="https://github.com/HoussemDjeghri/self-review/releases/download/v0.10.2/self-review-demo.gif" alt="Animated loop: Claude says Done, self-review answers &quot;not so fast.&quot;, four reviewers check correctness, security, intent and docs, the loop runs until clean, and only then is it Done">

</div>

---

Asking Claude to review its own work before it finishes doesn't work well. When
it's focused on wrapping up a task it often skips the step, and when it does
re-read the diff, it reads it with the same assumptions that produced the code.

This plugin adds a `Stop` hook. If a turn changed code and no review has
finished since the last edit, the hook stops the turn from ending and tells
Claude to run the review skill. The skill hands the diff to several new
subagents that didn't write it, checks what they report against the files,
fixes what holds up, and then reviews the fixes. The turn can end once a round
comes back clean, or once the loop stops making progress and reports what is
still open.

Compared with the usual ways of getting a review:

| approach | if Claude doesn't review |
|---|---|
| a review skill | nothing happens; the skill runs only when the model decides to |
| "review your work" in CLAUDE.md | nothing happens; it's the same instruction |
| linters and CI | they catch mechanical problems, after the turn is over |
| **self-review** | the Stop hook sees changed code with no review recorded and blocks the turn |

## Install

```
/plugin marketplace add HoussemDjeghri/plugins
/plugin install self-review@houssem-plugins
```

Restart your Claude Code sessions so the hooks load. The next turn that changes
code will be reviewed.

Turn on auto-update as well. Claude Code leaves it off for third-party
marketplaces, so without it you won't get fixes. In `/plugin`, open the
**Marketplaces** tab, select `houssem-plugins` and choose **Enable
auto-update**. Updates then install in the background at startup, and Claude
Code shows `Plugin updated: self-review · Run /reload-plugins to apply`.

You need Claude Code 2.1.292 or later (reviewer calls set a per-call `effort`),
Node 18 or later (CI tests Node 20 on Linux and macOS), and bash.

There is no daemon or service. The hooks and scripts read your transcript, your
files and `git`, and make no network calls: `hooks/no-network.test.mjs` fails
the build if one of them calls `fetch`, imports a network module or shells out
to `curl`. The reviewers are ordinary Claude Code subagents with the same
network access as your session, and some of them get `WebFetch` and
`WebSearch` so they can check URLs and API docs that a change relies on.

## What it looks like

When a turn that changed code tries to stop without a review, Claude gets this
back:

```
[self-review-gate] Files changed this turn but the self-review loop has not
converged, so the turn cannot end yet.
Changed: src/queue.ts, src/queue.test.ts

Now: invoke the Skill tool with skill "self-review:self-review" …
```

It runs the review, and the turn ends with a summary like this one:

```
Self-review: converged in 2 rounds — 3 fixed, 1 dismissed, 1 open.
Fixed: src/queue.ts:88 — retry loop swallowed the abort signal
Fixed: src/queue.ts:141 — off-by-one drops the last batch when size % n == 0
Fixed: src/queue.test.ts:12 — test asserted the mock, not the behaviour
Open for you: src/queue.ts:60 — backoff cap is 30s; the API docs say 60s. Raise it?
Checks: `npm test` 214 passed · `tsc --noEmit` clean
```

If the loop doesn't converge, the summary says `not-converged`, lists what is
still open, and leaves the decision to you.

Commands you'll use:

| to | run |
|---|---|
| review a doc, config file or plan | `/self-review <path>` |
| write the ticket before the code and have it checked | `/ticket` |
| send the maintainer a report on how the plugin behaved | `/self-review:retro` (see [Sending feedback](#sending-feedback)) |
| turn the gate off for one session | start Claude with `SELF_REVIEW_GATE=off claude` |
| see what your reviews cost | `node <plugin>/scripts/audit.mjs` |

`<plugin>` is the installed plugin directory, `${CLAUDE_PLUGIN_ROOT}` inside
Claude Code.

## How a review runs

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

1. A turn counts as changed when Claude writes a file outside the exempt paths.
   That includes `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, shell commands
   that write files (redirects, `sed -i`, `cp`, `tee`, `git apply` and so on),
   and launching a `self-review-applier`, the one agent type whose job is to
   edit. Writes to scratch locations don't count: `/tmp`, the session
   scratchpad, and Claude's own state folders such as `~/.claude/projects`,
   `plans`, `todos` and `sessions`. The rest of `~/.claude` does count, so
   changes to your own hooks and skills are reviewed like any other code.
2. Scripts collect the diff (untracked files included, and files outside git),
   look for code that still refers to symbols the change moved or renamed, and
   decide how big the review should be. A trivial change gets one reviewer, a
   normal one three or four, and a large or risky one up to six. Six is the cap
   at every size. Changes touching auth, payments, migrations, destructive
   operations, infrastructure or public contracts get a bigger review. Claude
   can raise the size further when line counts miss something, and can lower it
   only by recording a reason.
3. The reviewers, called finders, all start at once, each looking from a
   different angle: line-level correctness, removed behaviour, effects in other
   files, whether the change does what was asked, security, quality and project
   conventions. Each has a limit on tool calls. The session waits for all of
   them in one bounded call to `scripts/wait.mjs`, which returns when every
   finder has reported or gone quiet.
4. Each reported problem is checked against the file before anything is done
   about it. Confirmed problems are fixed by an applier agent that has no shell,
   so it can't run git and lose your work. If a round fixed anything, another
   round runs, because fixes can be wrong too. The next round's finders get the
   list of dismissed findings but not the list of fixes, so a fix has to look
   right to someone who doesn't know it was one.
5. When the loop ends, Claude writes a convergence marker and the turn can end.

Verdicts are saved per repository. When a later review touches the same files,
the earlier findings for those files go into its finders' briefs.

## Design choices

### Reviewers start fresh

They are new subagents given the stated intent and the diff, never a fork of the
session that wrote the code. They are told not to edit anything and keep Bash
only to run tests and reproduce bugs.

### Findings need evidence

A finder has to describe a concrete way the code fails, and dismissing a finding
takes a quoted line that shows it is wrong. Large or risky changes always get a
separate verifier agent. On smaller ones Claude checks findings against the file
itself, but if it dismisses any, or if there are more than four, a verifier is
brought in, and the gate won't accept a `converged` marker without one.

### The loop stops on a score

It runs another round only while a severity-weighted score of the findings keeps
falling. If the score stalls, if a round says an earlier fix was wrong, or if
the round limit is reached, it stops and hands you the current state. Hitting
the round limit is never reported as clean.

### Reviews check the code against the intent

If the ticket deliberately leaves something out and that only narrows what was
asked, finders don't flag it. If it contradicts the request or a document the
intent cites, they do. A correct implementation of a wrong ticket will still
converge. The marker's `intent` field records who read the ticket before the
code was written: `validated` means a `/ticket` validator did and the gate
checked the order, `author` means only Claude did, and `skipped` means nobody
did. Only `validated` is checked.

### Docs and config don't trigger the gate

By default Markdown, JSON, YAML, data files and images don't arm it, because
running the loop on a README costs tokens and rarely finds anything. You can
still review them with `/self-review <path>`.

### Waiting happens inside one call

`scripts/wait.mjs` waits for all the finders and returns even when a
notification never arrives. A second hook, the poll guard, denies `ListAgents`
and `TaskOutput` after two status checks, because each check makes Claude
re-read its whole context and learn nothing new. A third, the idle guard,
catches a subagent that tries to end its turn while a background job it started
is still running. A subagent isn't woken when that job finishes, so the hook
sends it back, once per job, with a bounded wait to run instead. `IDLE_GUARD=off` disables
it.

## Configuration

Defaults are in `config/defaults.json`. Override them in
`~/.claude/self-review/config.json`, or in the file `$SELF_REVIEW_CONFIG` names.
Objects are merged and arrays are replaced, so you can shorten an exemption
list as well as extend it.

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

- `exempt.paths` only accepts absolute globs, starting with `/` or `~/`. Others
  are dropped with a warning on the hook's stderr (visible with
  `claude --debug`), because a relative glob in a global config would exempt
  that path in every repository. `*` and `?` match within one path segment and
  `**` matches across segments: `~/code/app/prototypes/**` covers everything
  under `prototypes/`, and `~/code/app/prototypes/*` only its direct children.
  An exempt path only keeps the gate from arming. If a review's scope includes
  it, the finders still read it.
- `gate.maxReminders` is the way out if the gate gets in your way: after that
  many blocks in a row it lets the turn end and shows a notice.
- Bad config falls back to the safe side. An override with the wrong type is
  ignored with a warning, and an override file that can't be read or isn't a
  JSON object is ignored entirely. If the shipped `config/defaults.json` is
  missing or broken, the gate treats every file as code, so a broken install
  costs you extra reviews and never skips one.

<details>
<summary><strong>A repository's own <code>.self-review.json</code> can only add risk words</strong></summary>

<br>

A repository can include `.self-review.json` at its root. It is merged over your
config when changes in that repository are reviewed, but it can only add. The
one thing a repository can contribute is extra words for the risk markers
(`tier.riskPaths`, `tier.riskContent`), which are appended to your lists: its
own word for "payments", for example, but never a shorter list. Every other
setting stays yours. The Stop gate reads only your config, so a repository's
file can change how big a round is but never when the gate arms or what lets a
turn end. The one exception can only add blocks: in a repository you have
opted into branch review, its `riskPaths` words count toward the tier-L path
check that holds a branch.

It is this narrow because anyone who clones a repository runs its review, which
makes the repository the thing to defend against. The plugin's own review loop
found eight ways a repository's config could weaken its own review, including
hiding files from the scan, emptying a marker list, raising the tier-L
threshold out of reach and cutting the finders' budget. Each fix left a similar
hole next to it, so repository settings are now an allow-list, and a new
setting stays closed to repositories until someone confirms it can only add
work. The added words are matched as plain text rather than regexes, because a
checked-in `(a+)+$` could hang the machine running the review. Regexes in your
own config still work.

</details>

<details>
<summary><strong>Branch review: review a long branch in bigger pieces (opt-in, per repository)</strong></summary>

<br>

By default every turn that writes code has to converge before it ends. For a
repository where you'd rather review a branch in bigger pieces, opt it in from
your own config (a repository's file can't do this):

```json
{ "repos": { "<id>": { "branchDebt": { "maxLines": 500 }, "tier": { "riskPaths": { "protected": ["^src/core/"] } } } } }
```

`<plugin>/scripts/branch-debt.mjs --id` prints the id, a hash of the
repository's `origin` URL, so its clones and worktrees share it. Without
arguments, `<plugin>/scripts/branch-debt.mjs` prints the branch, its last
reviewed point and how much code is unreviewed.

In an opted-in repository, on a branch, a turn that changed code can end
without a review as long as the branch's unreviewed code stays within
`maxLines` and touches no tier-L path. Unreviewed code is the `git diff` from
the last reviewed tree to the worktree, prose not counted. Tier-L paths are
your `riskPaths` entries, including the `protected` category, which makes even
a one-line edit count. Past either limit the gate blocks and tells you which
commit to review from. A converged marker that carries the review's `review`
id records the tree its last round read as reviewed, in
`refs/self-review-reviewed/<branch>`. Clone, fetch and push don't carry those
refs.

- Nothing is deferred on main. If main's committed tree isn't covered by a
  review, for example after an unreviewed merge or a push from elsewhere, a
  Stop on main is blocked.
- Only writes inside the repository can be deferred. A turn that also wrote
  somewhere else, or whose subagent or shell writes the gate can't attribute,
  is gated as usual. Untracked files hidden by your `.gitignore` aren't
  measured.
- `branchDebt.main` names main when it isn't `origin/HEAD`. The first Stop
  after opting in records main's tip as reviewed, so older history doesn't
  count as debt.
- To opt out, delete the `repos.<id>` entry. To reset the baselines, delete the
  refs with
  `git for-each-ref --format='%(refname)' refs/self-review-reviewed/ | xargs -n1 git update-ref -d`.
  The next Stop takes main's tip again.

A known gap, like `SELF_REVIEW_GATE=off`: a repository's checked-in
`.claude/settings.json` can set `env`, so it could point `SELF_REVIEW_CONFIG`
at a file that opts the repository in. The gate removes `GIT_*` variables from
its own git calls for the same reason, so the gap can't also be used to forge
the review refs.

</details>

## Sending feedback

`/self-review:retro [days]` drafts a field report on how the plugin behaved in
your sessions. It is about the plugin, never your code, and it runs only when
you type it.

It reads the plugin's logs in `~/.claude/self-review/` and up to 8 short
excerpts from your transcripts in `~/.claude/projects/`. A local script scans
the transcripts to count events, learn your project names and pick the
excerpts. Only the picked excerpts and the counts reach the model, which reads
them in your session like any other file. The excerpts are copied unredacted to
a private temp folder whose path the command prints; delete it when you're
done.

The draft goes to `~/.claude/self-review/retro/<date>.md`. The command checks it
for your paths, project names, session ids, email addresses and token-like
strings, then stops. Nothing is sent. If you want to share it, edit it and paste
it into the **Field report** issue form yourself. The check only knows the names
that appear in your logs, so a client's name that appears nowhere else will
only be caught by you reading the draft.

## Reference

<details>
<summary><strong>The convergence marker</strong></summary>

<br>

The gate accepts a marker in either of two forms, written after the last change
in a message of its own. The file form is the default, because writing to
scratch needs no permission rule and so works on any machine and in any
permission mode:

```
Write <scratchpad>/self-review/CONVERGED.json   {"outcome": "converged", "rounds": 2, "fixed": 3, "dismissed": 1, "open": 1, "tier": "M", "intent": "author"}
```

It only counts under a scratch path, so a `CONVERGED.json` committed to your
project isn't a marker. The script form is for people, and for review folders
outside scratch:

```
<plugin>/scripts/converged.sh --converged --rounds 2 --fixed 3 --dismissed 1 --open 1 --tier M --intent author
```

The gate matches the script's output, so quoting the command or `cat`-ing it
doesn't count, and the command has to resolve to this plugin's own copy.

Both forms reject a record that doesn't fit its types:

- `outcome` is `converged`, `not-converged` or `not-applicable`, and the counts
  are integers.
- `intent` (`validated`, `author` or `skipped`) is required whenever there are
  counts.
- A turn the loop doesn't apply to is marked `--not-applicable <reason>` with no
  counts. It is never reported as a review with `rounds=0`.
- The summary is a list of `key=value` tokens: `outcome=` first, then the
  counts, then `reason=`, then the `tier`, `adapter` and `intent` labels, with
  `forced=` and `computed=` added when the tier was overridden.
  `--not-converged` requires `--reason`, which goes after the counts. A
  not-applicable marker has no counts, so its `reason=` follows `outcome=`.
  This lets `scripts/audit.mjs` count reviews by tier and adapter without
  parsing prose. The free-text `note` field never goes into the summary.

Both forms add a line to `~/.claude/self-review/log.jsonl`, and `not-converged`
runs are logged the same way as clean ones.

</details>

<details>
<summary><strong>Running a review in another session</strong></summary>

<br>

The loop runs in the session that changed the code. A subagent can't run it for
its lead: the reviewers it starts don't appear in the lead's transcript, so the
lead's gate rejects the marker. To review finished work elsewhere, run
`claude -p "/self-review <paths>"` in the repository with the permission flags
you give headless sessions. A `-p` session can't answer prompts, so any tool it
isn't allowed is denied. It is a separate session, so its reviewers count, and
its own Stop gate checks its marker if its fixes changed code.

</details>

<details>
<summary><strong>Uninstalling</strong></summary>

<br>

`/plugin uninstall self-review@houssem-plugins` removes the hooks. These stay
until you delete them:

- your review log, `~/.claude/self-review/log.jsonl`
- the gate's decision log, `~/.claude/self-review/gate/` (one file a month,
  pruned after six)
- your config, `~/.claude/self-review/config.json`
- the `refs/self-review-reviewed/*` refs in any repository you opted into
  branch review

To turn the gate off for one session without uninstalling, use
`SELF_REVIEW_GATE=off`.

</details>

<details>
<summary><strong>What ships today and what doesn't</strong></summary>

<br>

**Shipping:** the gate, the poll guard, the idle guard, the skill and its reviewer agents, and
the scope, salvage and wait scripts. Also the scripts that keep reviews cheap
(`brief.mjs` writes each round's briefs, `preflight.sh` runs the project's own
checks first, `audit.mjs` reports what a review cost), the context scripts
(`impact.mjs` finds what a change affects, `tier.mjs` turns that into a review
size and a plan of angles), per-repository memory (`findings.mjs` records every
verdict and passes the relevant ones to the next review), config with a
per-repository layer, and the plugin's own test suite.

**Not yet:** the eval corpus and runner, and the measured results that will
come from them.

**`code-review-graph`:** the impact script uses it only when the repository
already has a `.code-review-graph/` index and the binary is on your `PATH`. It
never builds an index for you. Its authors point out that on small repositories
and single-file diffs the graph costs more than it returns. A plain name search
always runs underneath, so every language is covered.

**Cost:** reviewer models and effort levels are pinned, every agent has a
tool-call limit, and the session waits in one bounded call instead of polling.
`scripts/audit.mjs` measures each review from the transcripts, including how
much the finders in a round overlapped. This README has no cost figures yet,
because so far they come from one machine, and publishing them as typical would
be an unchecked claim. Run `node <plugin>/scripts/audit.mjs` to see your own.

</details>

## License

MIT. See [LICENSE](LICENSE).
