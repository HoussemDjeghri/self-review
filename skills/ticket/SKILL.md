---
name: ticket
description: Grooms the ticket before the code exists. The session writes the INTENT block the self-review loop later reviews against, and one fresh self-review-ticket-validator reads it — request fidelity, premise, invariant, scope — while the code can still change; the session then builds against the verdict. Use at the start of any task that will write or change code, before the first edit, and whenever the user says "/ticket" or "groom the ticket". The self-review loop runs at the end of the task and finds the ticket already written. Skipping is allowed and is recorded in the convergence marker.
---

# Ticket

The self-review loop reviews a change faithfully against its INTENT block, and
every finder is told that the block's "out of scope on purpose" line is
deliberate and not to be flagged — so the author's own scoping is exempt from
review by construction, and the premise is questioned only after the author is
invested. The 2026-08-22 allowlist-guard review ran six rounds hardening a hook
against bypasses the platform already blocked: a correct implementation of a
wrong ticket, reviewed correctly, six times. A team's ticket is independent
because someone else groomed it. This skill is that someone: one fresh reader,
before the first edit, who may question exactly that line. It costs one Sonnet
agent reading a nine-line block and the request — not a diff — and three tool
calls here: write the block, spawn the reader, wait.

## When, and the skip

Before the first edit of a task that will write code. After the code exists a
validator is reading a ticket the code has already answered, and the Stop gate
counts that as no validation at all (§4).

Skipping is your call, never refused, and always written down: every counted
convergence marker must say `--intent validated`, `author` or `skipped`, so
there is no silent default. Skip when the request is its own ticket — a fix
whose premise you have checked rather than assumed. Two things audit the call
afterwards: the record says `skipped`, and the loop's round 1 computes a tier —
a skipped ticket that tiers M or L is a mismatch you name in the final report,
the same way a forced tier is named. A skip you cannot state there in one
clause was not a decision.

## 1 · Write the ticket

The ticket **is** the INTENT block, at `<work>/intent.md` — the file the
self-review skill's §0 otherwise writes, and every brief carries. There is no
second file on purpose: two would drift, and the finders would review against
whichever one got copied.

`<work>` is `<scratchpad>/self-review/` — the session scratchpad from your
system prompt, else `mktemp -d` — outside the repository, for the loop's own
reason (§0). Fill the template from
`${CLAUDE_PLUGIN_ROOT}/skills/self-review/references/briefs.md`, "The intent
statement": six to nine lines, the premise a checked fact or marked unchecked,
the invariant written so a test could fail it. You are writing what the reader
will attack, not a summary of what you are about to do.

## 2 · Spawn the reader, then wait in one call

One Agent call, `subagent_type: "self-review-ticket-validator"`, named
`self-review-ticket-validator-<suffix>` with a suffix no earlier validator in
this session used (a short slug of the task). The type is what the Stop gate
recognises, the name is what `wait.mjs` finds the transcript by, and both
spellings keep it under tree-guard. Its prompt carries three things and
nothing else:

- the absolute path to `<work>/intent.md`
- the user's request, verbatim — the thing the ticket claims to serve
- the repository root, so it can grep the premise

Then, as the very next call with nothing in between, Bash `timeout` `600000`:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/wait.mjs" --work <work>/ticket --round 1 <name> \
  && "${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" <session-id> <name>
```

`wait.mjs` blocks on the validator's own transcript and exits 0 once it is no
longer active; `salvage.mjs` then prints its last message, which is the report
— nothing else carries it (2026-09-03: three reviewers reported through
SendMessage with `success:true` and nothing arrived for 2h49m). The session id
is the UUID in your scratchpad path; a `<work>` outside the scratchpad needs
`--session <id>` on `wait.mjs`. The ticket waits in a directory of its own
because `wait.mjs` keeps its state under `round-<n>/` and numbers from 1, and
the ticket is not round 1 of anything. Exit 1 means call it again, now; exit 3
means it went dead — salvage by hand, and re-spawn once under a new suffix only
if the transcript holds no verdict (self-review §2f); a row marked stalled is
resumed, not re-spawned (§2g). Do not end the turn to wait, and do not check on
it any other way (self-review rule 1).

If the type is not offered, a `general-purpose` agent with the agent file
(`${CLAUDE_PLUGIN_ROOT}/agents/self-review-ticket-validator.md`) pasted at the
top of its prompt and the same prefixed name still reads the ticket and is
still guarded — but the gate reads the launched type, so its reading is
recorded as `author` with a `--note` saying who read it.

## 3 · Act on the verdict

- **`sound`** — build it.
- **`revise`** — overwrite `<work>/intent.md` with the `intent` block the
  validator returned, in full, and build against that. The finders review the
  file `round.sh` is given, so the corrected block has to be that file; your
  version is not lost — it sits in the validator's transcript beside its
  reasons — and a second file is what "no second file" forbids. Read the
  failed checks before building: a `revise` that moved the premise or the
  scope is what this skill exists for, and one that only moved wording is the
  signal it should not.
- **`do-not-build`** — do not make the first edit. Report the validator's
  `reason`, quoted, with what already does the job: that is the deliverable,
  and a turn that changed no code needs no marker. If the user then says to
  build anyway, or told you in advance not to check in, rewrite the Premise
  line to carry the objection and the override, build, and say in the report
  that the verdict was overridden. An objection carried in the ticket is one
  the finders can attack; an objection you dropped is a ticket nobody groomed.

## 4 · At the end of the task

The self-review skill's §0 finds `<work>/intent.md` already written and runs
`round.sh --intent <work>/intent.md` against it — do not write a second block.
The marker then says who read the ticket, in either form the self-review skill's §4 gives:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/converged.sh" --converged --rounds 2 --fixed 3 --dismissed 1 --open 0 --intent validated --tier M
```

or `"intent": "validated"` in `CONVERGED.json`. The field is required on every
`converged` and `not-converged` marker, because an absent field and "nobody
read it" would otherwise be the same state, and it takes exactly `validated`,
`author` or `skipped`.

**`validated` is checked, and only its order.** The Stop gate refuses it unless
an agent launched as `self-review-ticket-validator` completed — its idle notice
in the transcript — before this task's first code change, counting your own
edits, any applier's, and a shell command whose write target the gate cannot
name — an unnamed write is still a write, and it is ordered like any other. It never reads the verdict: a `revise` you acted on
counts exactly as a `sound` does. It is scoped to this task: back to the last accepted marker, or further when a
human prompt interrupted a still-running agent. A validator from an earlier,
already-marked task does not count — only one that finished after that boundary
and before your first edit. Refused, write
`author` or `skipped`, whichever is true, in a message of its own — never spawn
a validator at that point, because it would read a ticket the code has already
answered, which is the one thing the field exists to make visible. If it
refuses although the validator finished before your first edit, the idle notice
landed late: `author` with a `--note` saying so is the truthful record, since
the note is the only free text the marker has. It refuses twice by default
(`gate.maxReminders`); a third attempt is released with a log line saying the
intent may never have been read, and that line is then the record.

The final report's outcome line carries the answer: `Intent: validated before
coding (sound)` — or `(revise: premise, scope)` naming the failed checks, or
`(do-not-build, overridden)` — `Intent: author-written, unvalidated`, or
`Intent: validation skipped`, with the tier beside it when you skipped. That
line is the measurement, and its limit: convergence is a claim about the code
against the stated intent, never that the intent was right. This skill records
whether anyone independent read it, which is a smaller thing.
