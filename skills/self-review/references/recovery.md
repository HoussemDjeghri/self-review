# Recovery — a dead, stalled or silent agent

`wait.mjs` classifies the agent and prints the next action; this file is the
reasoning behind what it printed, and the commands.

## A dead agent — salvage before you re-spawn

Sessions get killed mid-round — the usage-limit reset is the common case — and
the reflex of re-spawning every silent reviewer re-pays 90–150k of context per
agent for work that already happened: a subagent's transcript survives on disk
even when its delivery did not, and this session's own round 3 was recovered
exactly that way. So when a reviewer dies, goes idle without a report,
`wait.mjs` lists it as dead, or you resume after a reset:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" <session-id>            # each agent: finished/stalled/active/dead, calls, context
"${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" <session-id> <name>     # its last message (--all-text: every text block)
```

The session id is the UUID in your scratchpad path; the briefs in
`round-<r>/briefs/` say who was launched. Then:

- **finished** — its last message is the report. Use it as delivered; never
  re-spawn an agent whose report already exists. A reviewer `wait.mjs` listed
  as dead that reports afterwards is not collected twice: use whichever report
  exists.
- **dead** (or **active**, when you are salvaging one `wait.mjs` gave up on) —
  read its state file (`round-<r>/state/<name>.jsonl`): the
  findings it had confirmed before dying. Re-spawn the angle only when the
  state file and the transcript's salvaged text are both empty — an unfinished
  agent's informal notes count as salvage too — and paste whatever survived into the
  new brief marked "already found — verify, do not re-derive, continue from
  here", so the dead agent's tokens still bought something.

**An applier that dies is the other case, and the reflex above is wrong for
it.** A dead reviewer costs re-paid context; a dead applier leaves the working
tree in a state nobody has read, because its edits are already on disk and what
died was the report saying which directive reached which file. So look at the
tree first — `git diff`, and `git status` for files a directive told it to
create — and read that against the directives you dispatched. Then dispatch a
**rewritten** directives file covering only what is still undone. Never re-send
the original: an applier told again to make an edit that is already there comes
back `blocked` on a file that is in fact correct, and the round spends itself
arguing with its own fixes. Its state file and salvaged transcript say what it
believed it applied; the tree says what it did, and the tree wins.

## A stalled reviewer is resumed, never re-spawned

`wait.mjs` says **stalled** when a reviewer's transcript ends on the harness's
own API-error notice. That is a third thing, and both of the reflexes above are
wrong for it: it is not finished (there is no report) and it is not dead (its
context is live and every tool call it made is still paid for). Measured
2026-09-04 over 894 subagent transcripts: 93 ended this way and **not one ever
continued on its own**. Before the status existed each of those read `active`
until the 30-minute budget burned and was then treated as dead — the same idle
lead, arriving by a different door.

`wait.mjs` prints the error text and, from it, which of the two kinds it is:

- **resumable** (a dropped connection, a 5xx) — send the agent one message:
  `SendMessage` to its name with `resume`. Then call `wait.mjs` again as the
  very next call, exactly as after an exit 1. Do not re-spawn it and do not
  paste its brief again; it still has both.
- **a quota refusal** — the text carries the reset time. A nudge before then
  only spends another refusal. Wait for the reset and resume, or, if the round
  cannot wait, treat that angle as uncovered and say so in the report (§4) —
  never silently.

If a resumed reviewer stalls a second time on the same error, stop resuming it
and salvage it as §2f says; two identical stalls is an outage, not a blip.

