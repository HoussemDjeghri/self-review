# Review angles

Each angle below is a self-contained paragraph meant to be pasted verbatim into a
finder brief (see `briefs.md`). An angle tells one reviewer what to hunt for and
what evidence the finding must carry. Angles are deliberately narrow: a reviewer
looking for everything finds the obvious things and stops; a reviewer looking for
one class of defect keeps going until that class is exhausted.

Pick angles by artifact kind and tier — `tier.mjs` plans them, SKILL.md → "The angle plan" says how to read that plan. Angles
marked *conditional* apply only when the change has that surface.

---

## Code — correctness

### A · Line-by-line diff scan
Read every hunk line by line, then Read the whole enclosing function for each
hunk — bugs in unchanged lines of a touched function are in scope, because the
change re-exposes or fails to fix them. For every line ask: what input, state,
timing, or platform makes this line wrong? Hunt for inverted or incomplete
conditions, off-by-one at boundaries, null/undefined dereference where nearby
code shows the value can be absent, a missing `await` or unhandled promise,
falsy-zero / empty-string treated as missing, wrong-variable copy-paste, an
error caught and swallowed where it should propagate, unescaped regex
metacharacters, unit or encoding mismatches.

### B · Removed-behaviour audit
For every line the change deletes or replaces, name the invariant or behaviour it
used to enforce, then search the new code for where that invariant is
re-established. If you cannot find it, that is a candidate: a dropped guard, a
narrowed validation, an error path that now falls through, a deleted or weakened
test that covered a real case, a default that silently flipped.

### C · Cross-file tracer
For each function, type, export, or schema the change touches, Grep for its
callers and check every call site against the new contract: a new precondition,
a changed return shape or nullability, a new exception, an ordering or timing
dependency, a renamed field the caller still reads. Then check callees: does a
parallel change in the same diff make an existing call unsafe? Include tests,
fixtures, configs, and docs that reference the symbol by name.

Then the couplings that have no symbol. A route, a queue topic, an env var, a
CLI flag, an HTTP header name and a feature-flag key are joined by a **string
over a wire**: nothing
imports anything, so no grep for a symbol and no call graph can see the edge —
a frontend that still fetches the path the backend just renamed compiles,
type-checks and ships. `impact.md`'s **Wire contracts** section lists each
contract the diff removed or renamed with the consumers that still name it;
open every one and rule on it, because the script only reports the string, it
cannot know whether the caller is now broken. Two of those rulings are yours
alone:

- **Resolve the indirection before you believe a consumer is missing.** A
  consumer writing `` `${API_BASE}/orders/${id}` `` matched only a weak anchor,
  and one behind `axios.create({ baseURL })`, a router `.use()` mount prefix, a
  `NEXT_PUBLIC_*`/`VITE_*` base, or an OpenAPI-generated client may not have
  matched at all. Find the base, rebuild the full path, and search again.
- **Zero consumers is "consumers unknown", not "safe".** A public API, a mobile
  client, a webhook subscriber, a monitoring rule, or another repository lives
  outside this tree. Report it as PLAUSIBLE and ask the versioning question:
  who is served the old value, and what deprecates it? When the section says
  nothing names the *new* value either, ask who serves it — a rename done on
  one side only is the same bug in the other direction.

A contract marked **too many matches** is the opposite of noise. The admission
gates have already rejected the generic strings, so a token that still collects
hundreds of signature-verified hits is a foundational endpoint — the widest
blast radius in the change, and the row most worth your time. Its listed
consumers are a floor, not the count.

A hit under `generated/`, `__generated__/`, `*.gen.*` or `*.generated.*` is
tagged and does not count: the fix there is to regenerate, and the real callers reach it through
symbols this angle already traces.

### D · Language and framework pitfalls
Scan for the classic traps of the diff's language and framework and flag any the
change introduces. Examples: JS/TS `==` coercion, closure-captured loop
variables, `Array.sort` without comparator, forgotten `return` in `.map`;
Python mutable default arguments, late-binding closures, `is` vs `==`, bare
`except`; Go nil-map write, range-variable capture, unchecked error; SQL built by
string formatting; Bash unquoted expansions, `set -e` defeated by pipelines;
React stale closures, missing effect deps, state derived from props without
sync; timezone/DST arithmetic, float equality, locale-dependent parsing. If the
framework's idiom for this task differs from what was written, say which.

### E · Intent and scope fidelity
Re-read the user's request in the brief, then the change. Does it do everything
that was asked — every acceptance criterion, every state the request implies
(loading, empty, error, permission-denied, concurrent edit)? Does it do anything
that was *not* asked — speculative options, refactors of untouched code, a
behaviour change smuggled in? Was a hard part quietly narrowed ("TODO later",
a stub, a happy-path-only implementation)? Then attack the brief's *premise*
line: does this change need to exist at all — does the framework, the
platform, or existing code already do the job it claims to do? Check, don't
assume: read the thing the premise names, run it when cheap. A change that
duplicates what already works is the costliest kind of correct code, and no
other angle will ask. A reviewer with this angle is the only one guarding the
gap between what was built and what was wanted; be literal about the request
and concrete about the gap.

### F · Verification audit
Establish what proves this change works and whether that proof exists. Are
there tests for the new behaviour, and do they test behaviour (inputs →
observable outcome) rather than mirror the implementation? Do they cover the
edges the change introduces? Run the project's relevant checks yourself —
tests for the touched modules, the type-checker, the linter — and report the
real result; a claim of "tests pass" in the transcript is not evidence. Flag:
behaviour with no test, a test that passes for the wrong reason, a skipped or
`.only` test left behind, a check that cannot run because of the change.

### G · Security *(conditional: input handling, auth, files, network, secrets, shell, HTML)*
Trace every piece of untrusted data the change touches from entry to use:
injection (SQL, shell, path, template, header, log), missing or bypassable
authorization, secrets or tokens in code, logs, or URLs, unsafe
deserialization, SSRF/open redirect, path traversal, weak randomness for
security purposes, missing rate or size limits, HTML rendered without escaping,
permissions broader than the task needs. Name the entry point, the sink, and the
payload that gets through.

### H · Concurrency, state, and resources *(conditional: async, shared state, I/O, retries)*
Look for state that can be observed half-updated, operations that assume
ordering the code does not enforce, check-then-act races, retries that are not
idempotent, handles/connections/listeners/timers that are opened and not closed
on every path (including the error path), unbounded growth (caches, queues,
logs), work done on a hot path or at startup that should be lazy or batched.

### X · Cold run *(conditional: the change touches something a user runs — a CLI, a script, a hook, a plugin, an installed entry point)*
Every other angle reads the artifact. This one grades what the artifact **did**
when it was run the way a user gets it, and its evidence is a transcript rather
than a line number.

The run has already happened when you receive this. `scripts/coldrun.sh` copied
the working tree out of the repository into a directory whose path **contains a
space** — where unquoted `$0`, `dirname` and glob expansion fail — reached it
through a symlink, gave it a working directory that is neither the copy nor the
source, and invoked each entry point inside a sandbox that **denies the network
and confines every write to that directory**. Your brief names the transcript.

**You do not run the artifact, and you have no shell.** That is the mechanism,
not an oversight. This angle used to hand a reviewer a shell and a rule about
which invocations were safe — `--help`, `--version`, `--dry-run` — and the rule
was circular: the code you would read to decide that a `--dry-run` flag is
honoured is exactly the code under review because it might be broken. One
mis-parse and a `deploy` reaches the real network with the real credentials,
and there is no undo. Safety is held by containment now; **which** invocation
runs is a coverage question, and coverage questions are allowed to be wrong.

Read the transcript's header first. It names the containment tier:

* **contained** — network denied, writes confined. Grade what ran.
* **network-denied** — network denied, writes and reads not confined. Only reachable when the host's owner opted in with `coldRun.uncontained: true`; otherwise this tier refuses to execute. Grade what ran, and say so if a finding turns on a file the artifact wrote or read.
* **uncontained** — the host offered no sandbox, so **nothing ran**. The entry points are UNVERIFIED, not verified-clean. File one `minor` candidate saying angle X could not be exercised and what the transcript says would fix it. Never report a pass.

The failure this angle exists for is **silent success**: a tool that resolves a
path against `$PWD`, needs a sibling that only exists in the source tree, or
breaks on the space, and does nothing at all without saying so. So:

* **exit 0 with empty stdout is a FINDING, not a pass**;
* a documented flag the artifact does not recognise;
* an error naming a path inside the source tree — it only works next to its repository;
* `command not found`, an unresolved shebang, a missing dependency;
* `KILLED at the … timeout` — an entry point that blocks on nothing;
* output contradicting what the artifact declares: the README's usage line, the `--help` text, the docs this change edited.

What is **not** a finding: the coverage line at the end of the transcript. A
bare invocation, `--help` and `--version` fire before argument parsing, so they
catch the preamble class and not the artifact doing its job. Reporting that gap
on every entry point every round is how an angle gets switched off. Raise it
only when the artifact's real invocation is the one place a defect in *this*
change could show — and then as one candidate naming the argv you would want
run, for a person to decide on and run by hand. There is no config key that
takes it today; a per-entry-point argv map is deliberately not built yet. A
belief that something more should be run is an input to someone else's
decision, never an execution decision of your own.

### Q · Reuse, simplification, efficiency, altitude
*Reuse*: flag new code that re-implements something the codebase or its
dependencies already provide — Grep shared/utility modules and files adjacent
to the change, and name the existing helper to call instead. *Simplification*:
flag unnecessary complexity the change adds — redundant or derivable state,
copy-paste with small variations, deep nesting, dead code or debug leftovers,
abstractions with one caller — and name the simpler form. *Efficiency*: flag
wasted work — repeated I/O or computation, sequential independent operations,
blocking work added to hot paths, closures that keep large scopes alive — and
name the cheaper alternative. *Altitude*: flag fixes applied at the wrong depth
— a special case layered onto shared infrastructure where the underlying
mechanism should have been generalized, or a symptom patched where the cause is
one call up. Correctness findings outrank these when a cap forces a cut.

### V · Conventions (CLAUDE.md and the project's stated rules)
Find the rules that govern the changed files: `~/.claude/CLAUDE.md`, the
repo-root `CLAUDE.md`, any `CLAUDE.md`/`CLAUDE.local.md` in an ancestor
directory of a changed file, `.claude/rules/*.md`, and any skill the rules
require (a rules file that says "always load `clean-code`", or a
framework-specific skill for the files in scope). Read them, then check the change for clear
violations. Flag only when you can quote the rule and the line that breaks it —
no "spirit of the doc" inferences, no style preferences. The clean-code
bottom line is a rule: names say what things are, dead code removed, tests run
and quoted, each touched unit has one job, touched mess tidied.

---

## Documentation and prose *(READMEs, guides, comments, reports, plans, commit/PR text, skills, prompts)*

### P1 · Accuracy against reality
Every claim the text makes about the system is checkable — check it. File
paths exist; commands run and produce what the text says (run them when
cheap and side-effect free); flags, option names, defaults, versions, function
signatures, and config keys match the code; numbers and limits match their
source; links resolve. A doc that is wrong is worse than no doc because readers
trust it. Quote the sentence and the contradicting fact.

### P2 · Completeness and reader fit
Name the intended reader and what they need to do after reading. Can they do it
without asking a question? Check for missing prerequisites, missing failure
modes ("what if X isn't installed"), missing "how to undo", missing the one
example that makes it concrete, and for anything the user's request asked to
cover that is absent. Then check shape: the outcome or answer comes first,
sections earn their place, no filler or boilerplate, length matches the need
(the writing rules in `~/.claude/CLAUDE.md`, when there are any). Flag a section a reader
would skip and a question a reader would still have.

### P3 · Consistency and staleness
Terms, names, and identifiers match the code and the rest of the docs (the same
thing is not called two names; a renamed symbol is not still referenced by its
old name). Other documents that the change makes wrong — an index, a table of
contents, a README that describes the old behaviour, a changelog — are updated
or flagged. Examples agree with the prose around them. Version numbers, dates,
and counts agree across the document.

### P4 · Instruction quality *(conditional: skills, agent definitions, prompts, CLAUDE.md, runbooks)*
Read it as the cold model or operator who will follow it. Is the trigger
condition (description) precise enough to fire when it should and not
otherwise? Does each instruction explain *why*, so it generalizes, instead of
stacking MUSTs that will be pattern-matched and mis-applied? Are there
contradictions between sections, or between this file and the files it points
to? Is anything required that the follower cannot actually do with the tools
they have? Is heavyweight material pushed to references so the main file stays
readable? Trace one realistic scenario end to end and report where the reader
would get stuck or take the wrong branch.

---

## Configuration and infrastructure *(settings, CI, Dockerfiles, IaC, hooks, env files)*

### K1 · Validity and semantics
Parse it (`jq`, `yq`, the tool's own `--dry-run`/`validate`/`plan`). Then check
meaning, not just syntax: matchers and globs match what they are meant to,
merge and precedence rules produce the intended effective config (a later file
overriding an earlier one, arrays replaced vs merged), defaults that changed
when a key was added or removed, quoting and escaping inside strings that will
be re-parsed by a shell or template engine. Quote the key and the effect.

### K2 · Security, blast radius, reversibility
Least privilege (permissions, tokens, network, mounts) no broader than the
task; no secrets in plain text; what happens on first run, on re-run
(idempotence), and on rollback; which other systems or people are affected if
this is wrong; whether a failure is loud or silent. Name the worst realistic
outcome and whether the change guards against it.

---

## Shape *(from round 3, and whenever a unit takes findings in two rounds running)*

### S · Is this the right solution, or a working version of the wrong one?

Every other angle asks whether the code is wrong. You ask whether it should
exist in this form at all, and you are the only reviewer with the standing to
answer **delete it**. Two rounds of fixes have already failed to settle this
change; a third defect in the same place is evidence about the design, not about
the lines.

Start from the INTENT block's **Invariant** — the property that must hold when
this is done. Then ask, in order:

1. **Does the design make the invariant achievable at all?** Not "does the code
   uphold it today" — can this shape uphold it against every input it will see?
   If the answer is "yes, provided nobody does X", the invariant is not held; it
   is being hoped for.
2. **Is this the layer where the problem should be solved?** A guard added at
   the symptom site, a check repeated at every call site, a setting hardened
   against one abuse at a time — each is a sign the decision belongs one layer
   up, where the wrong thing becomes impossible rather than caught.
3. **Read the fix history in the ledger.** If each fix names an *exploit it
   blocks* rather than a *property it restores*, that is an arms race, and the
   next patch will lose too. Say so, and name the property.
4. **What would a senior engineer say to the approach, not the diff?** Would
   they accept this mechanism in review, or ask why it exists? If the feature
   suppresses a symptom (a false positive, a warning, a flaky failure), ask what
   it costs to simply accept the symptom instead — that is often the cheaper,
   correct answer, and no defect-hunting angle can propose it.
5. **Is it earning its complexity?** Count what the mechanism buys against what
   it costs to keep right. Report the ratio plainly.

Your verdict is one of: `sound` (the shape holds; defects here are local),
`wrong-layer` (move it, and say where), `unachievable` (this design cannot hold
the invariant; say what shape can), or `delete` (the thing it buys is not worth
what it costs; say what happens if it simply goes away). A verdict other than
`sound` is a finding at blocker severity even when every line in the diff is
correct — because the fix for it is never a patch.

Do not propose a patch. If you can see the better shape, describe it in two or
three sentences and stop; the author decides. What you must not do is help the
current approach work — a fix that makes a wrong design pass its tests is how a
codebase ends up correct in the small and unmaintainable in the large.

---

## Compact all-angles brief *(trivial tier — one reviewer)*

Review this small change through every lens at once, spending effort where the
change actually has surface: whether the change needs to exist (does something
already do this — check the brief's premise line); correctness of each changed
line in its enclosing context; anything removed that enforced a behaviour; callers and references of
anything renamed or re-typed; whether the change does exactly what was asked,
no less and no more; what proves it works (run the relevant check if one
exists); for prose, whether every claim is true and the reader can act on it;
for config, whether it parses and means what was intended. If the change
touches something a user runs, your brief carries a COLD RUN section with the
transcript of it already having been run in a sandbox — grade that against what
the artifact claims to do (exit 0 with no output is a finding) and do not
invoke the artifact yourself: you have a shell, the sandbox is what makes that
safe, and you are not in it. Report only what you can evidence.
