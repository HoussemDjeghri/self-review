# Convergence internals

`findings.mjs converge` decides and prints all of this. Read it here only to
argue with the verdict, or to understand a tree-guard line you have to quote.

## The `W` rule

It prints each round's `W = 3·blockers + 2·majors + 1·minors` over what that
round **fixed**, compares the two rounds over the angles they share, and says
`CONTINUE`, `ESCALATE` or `STOP` — `STOP` being the round backstop rather than a
reading of `W`, which is why it can arrive on a round whose `W` fell. The restriction is what "compare like with like"
means: angle S arrives by rule at round 3 (§2a) and files every non-`sound`
verdict as a `blocker` by construction, so an unrestricted `W` reads as an
increase and stops a loop that is converging — it did exactly that to this
tool's own review, 11 → 4 → 9. A round still fixes everything
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

## The tree-guard audit

SKILL.md §3 carries the rule itself — quote the line verbatim, tell the user,
it never changes the verdict. This is the background behind it.

`round.sh` opens an engagement log for the round; the
guard appends one row per subagent shell call saying whether it recognised
the agent as a reviewer; `converge` reports what the round proved. It exists
because the guard was inert for roughly ninety named finders while every
review round read the file and correctly found it correct — a mechanism whose
working and inert behaviours are identical. Nothing reads it to decide
anything, so it never changes `CONTINUE`/`ESCALATE`. What it can say, and what
each one asks of you:

**`tree-guard engaged: N/M` is the only wording that is a pass.** Any other —
a name it did not match, a name it does not cover, rows with no session id, a
log nothing reached, no log at all — is a defect in the plugin or in an agent's
tool list, and **a review in progress cannot fix its own installed guard**. That
is why the action is the same for every wording: there is nothing for you to
repair in this round, so the whole value is in the user seeing the exact line.

Nothing here blocks convergence, and the line is never absent: a round that
opened no log, or opened one nothing reached, says so in words. Silence would
read the same as a pass, which is the failure this instrument was built for.

