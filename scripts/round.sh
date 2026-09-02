#!/usr/bin/env bash
# round — everything a review round needs before it can spawn a reviewer, in
# ONE call.
#
# Usage: round.sh --work <dir> --round <n> --intent <file> [--base <ref>]
#                 [--force S|M|L --reason "…"] [--no-preflight] [path ...]
#
# It captures the scope, runs pre-flight (round 1 only), computes the blast
# radius and the plan, pulls the prior findings for these files, and writes the
# briefs — then prints the tier line, the pre-flight summary and the Agent-call
# table. Nothing else; every line it prints lands in the main session's context
# and is paid for again on every later turn.
#
# It exists because of a measurement, not a preference. In the 2026-08-29 loop
# smoke the session ran that setup as FIVE separate Bash calls in round 1 and
# three in round 2 — eight full-context turns, on a context growing 18k → 58k,
# for work with no decision in it. The skill already showed these commands
# `&&`-chained and the session split them anyway; an instruction that is
# already there and already ignored does not get better by being repeated. A
# script it can only call once is structural, and it costs one turn.
#
# The second thing it makes structural: from round 2 on it passes
# `--cap <round 1's tier>` to tier.mjs. The scope is captured against HEAD, so
# a round that reviews the previous round's fix sees the fix's lines ADDED to
# the original change's and the tier can only ratchet up — in that same smoke a
# 2-line tier-S change whose round-1 fix added a 24-line test file recomputed
# as M and spent two finders where round 1 had spent one. Fixing a finding well
# must not cost more than finding it. `--force` still overrides.
# Exit: 0; 2 usage (a bad flag, a missing intent file, a work dir inside the
# repo); 4 nothing to review (an empty scope, or a change that is all assets);
# 3 propagated from tier.mjs or brief.mjs when an input of theirs is unreadable,
# because those two are unguarded on purpose — without a plan or a brief there
# is no round, so the failure must reach the caller rather than degrade.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/path.sh
. "$here/lib/path.sh"

die() { echo "round.sh: $*" >&2; exit 2; }

work=""; round=""; intent=""; base=""; force=""; reason=""; preflight=1
# `paths` is expanded as ${paths[@]+"${paths[@]}"} everywhere below: under
# `set -u` in bash 3.2 — which is what macOS ships — "${empty[@]}" is an
# unbound variable, and the empty case is the common one (review the whole
# working tree).
paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --work)   [ $# -ge 2 ] || die "--work needs a directory";  work="$2"; shift 2 ;;
    --round)  [ $# -ge 2 ] || die "--round needs a number";    round="$2"; shift 2 ;;
    --intent) [ $# -ge 2 ] || die "--intent needs a file";     intent="$2"; shift 2 ;;
    --base)   [ $# -ge 2 ] || die "--base needs a ref";        base="$2"; shift 2 ;;
    --force)  [ $# -ge 2 ] || die "--force needs a tier";      force="$2"; shift 2 ;;
    --reason) [ $# -ge 2 ] || die "--reason needs text";       reason="$2"; shift 2 ;;
    --no-preflight) preflight=0; shift ;;
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;   # to the first non-comment line, never past it
    -*) die "unknown option: $1" ;;
    *)  paths+=("$1"); shift ;;
  esac
done

[ -n "$work" ]   || die "--work is required"
[ -n "$round" ]  || die "--round is required"
[ -n "$intent" ] || die "--intent is required"
case "$round" in ''|*[!0-9]*) die "--round needs a positive integer, got: $round" ;; esac
[ "$round" -ge 1 ] || die "--round needs a positive integer, got: $round"
[ -f "$intent" ] || die "no intent file at $intent — write it before the round: it is what keeps reviewers from reviewing the wrong thing"
[ -n "$force" ] || [ -z "$reason" ] || die "--reason belongs to --force"
# The mirror of it. Without this the pairing was still caught — by tier.mjs,
# after scope.sh and impact.mjs had already run and written files, and with a
# message naming a script the caller did not invoke.
[ -z "$force" ] || [ -n "$reason" ] || die "--force needs --reason \"…\": a tier set by hand has to be auditable"

# Checked here as well as inside scope.sh (lib/path.sh) so the round dies before
# it creates anything, and with round.sh's name on the message.
if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  refuse_if_inside_repo "$work" "round.sh"
fi

dir="$work/round-$round"
mkdir -p "$dir/state"   # reviewers append their lifeboat lines here

# Scope first: impact, tier and every finder read this same bundle, so none of
# them can be looking at a different change from the others.
scope="$dir/scope.diff"
"$here/scope.sh" --work "$work" ${base:+--base "$base"} ${paths[@]+"${paths[@]}"} > "$scope"

# An earlier review's work dir left inside the repository is scoped like any
# other untracked file. Measured 2026-08-30: 4,337 lines of one, tier L, six
# finders, ~3M tokens spent reviewing the review's own notes. Refused, not
# excluded silently — a silent exclusion is how a real change escapes review,
# and the signature (lib/paths.mjs isReviewPaperwork, matched on contents
# because users rename the directory) is specific enough that a false refusal
# costs the one line the message names.
if ! paperwork="$(node --input-type=module -e '
  const [here, file] = process.argv.slice(1);
  const { pathToFileURL } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const load = (rel) => import(pathToFileURL(`${here}/${rel}`).href);
  const { parseScope } = await load("impact.mjs");
  const { reviewPaperworkRoot } = await load("lib/paths.mjs");
  const { parseDiff, changedLineCounts } = await load("lib/diff.mjs");
  const found = new Map();
  for (const repo of parseScope(readFileSync(file, "utf8")).repos) {
    const perFile = changedLineCounts(parseDiff(repo.diff));
    for (const entry of repo.files) {
      const dir = reviewPaperworkRoot(repo.root, entry.path);
      if (!dir) continue;
      const seen = found.get(dir) ?? { files: 0, lines: 0 };
      found.set(dir, { files: seen.files + 1, lines: seen.lines + (perFile.get(entry.path) ?? 0) });
    }
  }
  const count = (value) => value.toLocaleString("en-US");
  for (const [dir, { files, lines }] of found) {
    process.stdout.write([
      `round.sh: the scope contains self-review paperwork — ${dir}/ (${count(files)} files, ${count(lines)} lines)`,
      "  it is the work dir of an earlier review, inside the repository; a round would review its own notes.",
      `  remove it (rm -r ${dir}/), or scope only the change: round.sh … <paths>`,
    ].join("\n") + "\n");
  }
' "$here" "$scope")"; then
  # A guard that cannot run must say so. Swallowed, this was a silent
  # fail-open: an unrelated broken sibling would disarm the refusal and the
  # round would spend its L tier on an old review's notes anyway.
  echo "round.sh: the paperwork check did not run — an earlier review's work dir in this scope will not be caught" >&2
elif [ -n "$paperwork" ]; then
  printf '%s\n' "$paperwork" >&2
  exit 2
fi

# Pre-flight belongs to round 1: a reviewer that reports a failing test is a
# wasted agent, and by round 2 the suite has already been run on the fix.
pf=""; pf_from=""
if [ "$round" -eq 1 ] && [ "$preflight" -eq 1 ]; then
  # From the install copy, not from the checkout. Eleven files in this plugin
  # resolved their own root with `new URL(import.meta.url).pathname`, which keeps
  # percent-encoding: any path with a space became `cold%20run` and everything
  # derived from it failed ENOENT. Nine releases and a 485-test suite could not
  # see it, because each of those files computes its root from its own location
  # and then reads under it — which passes exactly when the root is right, and in
  # the developer's checkout it always is. The suite validated itself against the
  # one path that cannot fail.
  #
  # Pre-flight is the instrument that already loads a project's libraries broadly
  # and already owns a suite-sized budget, so this is a replacement and not an
  # addition: the same checks, the same cost, run where a path bug can show. The
  # copy is a copy and not a symlink because Node realpaths `import.meta.url` —
  # through a link the suite would be right back at the checkout — and it is
  # staged whether or not the round has an executable surface, since a
  # library-only diff is exactly the case the cold run's entry-point filter
  # misses.
  #
  # HOME is the copy's own empty home: a suite that reads a file the developer
  # happens to have in theirs is a real install failure, and this is the cheapest
  # reproduction. Writable, unlike the sandbox's — a read-only HOME fails npm,
  # pip and cargo on their caches, and by the standard this fix is held to
  # (F8: no long paths, because they break tooling nobody here owns and produce
  # findings nobody can act on) that is noise, not hostility.
  #
  # A staging failure is reported, not fatal: pre-flight from the checkout is
  # what every release until now did, and it is worth more than no pre-flight.
  pf_from="${repo_root:-$(pwd)}"
  pf_home=""
  stage="$dir/cold run – ü"
  if ship="$("$here/coldrun.sh" --root "$pf_from" --stage-only --out "$stage" 2>"$dir/stage.err")" && [ -d "$ship" ]; then
    pf_from="$ship"; pf_home="$stage/home"
  else
    echo "round.sh: could not stage the install copy (${dir}/stage.err) — pre-flight runs from the checkout, where a path bug cannot show" >&2
  fi
  # The repo root, not the cwd: run from a subdirectory with no manifest of its
  # own, `--root "$(pwd)"` made preflight report "no checks detected" and a
  # broken suite reached the reviewers unannounced.
  # Reported, not swallowed. `>/dev/null 2>&1 || true` hid preflight.sh's own
  # exit-2 paths (a bad --root, an unwritable --out) completely: no message, no
  # preflight.txt, no section, exit 0 — and SKILL.md tells the session to say
  # which script did not run, which it then had no way to know.
  if ! HOME="${pf_home:-$HOME}" "$here/preflight.sh" --root "$pf_from" --out "$dir/preflight.txt" >/dev/null 2>"$dir/preflight.err"; then
    echo "round.sh: preflight.sh failed (${dir}/preflight.err) — the project's own checks did not run; say so in the report" >&2
  fi
  # The verdict lines only — preflight.txt keeps the failure tail, and --out
  # exists precisely so that tail stays out of the main session's context.
  # `no checks detected` is a verdict too: without it the caller cannot tell
  # "pre-flight ran and this project defines nothing to run" from "pre-flight
  # never ran", and those call for opposite reactions.
  pf="$(grep -E '^# [0-9]+ run|^# no checks detected|^(PASS|FAIL|SKIP) ' "$dir/preflight.txt" 2>/dev/null || true)"
fi

# Guarded like pre-flight, and unlike tier.mjs below: a missing impact.json is
# a case tier.mjs already handles (the cross-file rules are skipped, `reasons`
# says so, and tier S is lifted to M because its caller clause could not be
# checked), so an impact failure costs accuracy, not the round. Under
# `set -e` a bare call aborted with only scope.diff written — no plan, no
# briefs — while SKILL.md promised the loop keeps going without these scripts.
if ! "$here/impact.mjs" --scope "$scope" --out "$dir/" >/dev/null 2>"$dir/impact.err"; then
  echo "round.sh: impact.mjs failed (${dir}/impact.err) — continuing without the blast radius; the tier will say so" >&2
  rm -f "$dir/impact.json"
fi

impact_json=""; [ -f "$dir/impact.json" ] && impact_json=1
impact_md="";   [ -f "$dir/impact.md" ]   && impact_md=1

# From round 2 on, inherit round 1's tier as a ceiling — see the header.
cap=""; cap_markers=""
if [ "$round" -ge 2 ] && [ -f "$work/round-1/tier.json" ]; then
  cap="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tier??""))}catch{}' "$work/round-1/tier.json")"
  # The markers round 1 already had. Without them the ceiling would also hold
  # down a fix that has just become dangerous — a round-2 patch that first
  # touches auth/ or first adds a DROP TABLE — and drop the reviewer that
  # marker exists to force.
  cap_markers="$(node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).markers??{};process.stdout.write(Object.keys(m).filter((k)=>m[k].length).join(","))}catch{}' "$work/round-1/tier.json")"
fi

# Held, not printed: an empty scope must not put a tier line for a review that
# never runs into the caller's context. Moving the check below tier.mjs was not
# enough — tier.mjs logs from its own process.
plan_out="$("$here/tier.mjs" --scope "$scope" ${impact_json:+--impact "$dir/impact.json"} --out "$dir/" --round "$round" \
  ${cap:+--cap "$cap"} ${cap_markers:+--cap-markers "$cap_markers"} ${force:+--force "$force"} ${reason:+--reason "$reason"})"

# Nothing to review is a real answer, not a failure to be reported by brief.mjs
# after the tier line has already gone out. But zero finders has two causes and
# they are not the same news: an empty scope, and a change that is entirely
# assets — images and binaries, which tier.mjs lists and deliberately does not
# review. Saying "nothing changed" about a regenerated screenshot is false, and
# the caller reacts differently to the two.
# Three causes, not two: assets, and files tier.ignore excludes (lockfiles,
# dist/, vendor/, *.min.*, __generated__). Round 5 separated assets from empty
# and left `ignored` folded into "nothing changed", which is the same false
# claim about a different kind of file — a real change, deliberately not
# reviewed, is not an absence of change.
reviewable="$(node -e '
  const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const unreviewed = [["assets", plan.kinds.asset], ["ignored", plan.kinds.ignored]]
    .filter(([, files]) => files?.length)
    .map(([kind, files]) => `${kind}:${files.length}`);
  process.stdout.write(plan.finders.length ? "yes" : unreviewed.join(" ") || "empty");
' "$dir/tier.json")"
if [ "$reviewable" != "yes" ]; then
  if [ -n "${paths[0]+set}" ]; then where="those paths"; else where="this working tree"; fi
  case "$reviewable" in
    empty) echo "round.sh: the scope is empty — nothing changed in $where, so there is no round to run" >&2 ;;
    *)     echo "round.sh: the only changes in $where are files this loop never reviews ($reviewable — assets are listed, tier.ignore covers lockfiles and generated output), so there is no round to run" >&2 ;;
  esac
  exit 4
fi
printf '%s\n' "$plan_out"

# Written even when empty, so the chain does not break on a repo with no memory.
"$here/findings.mjs" prior --scope "$scope" --out "$dir/prior.md" --work "$work" >/dev/null

ledger="$work/ledger.md"
[ -f "$ledger" ] || echo "_No dismissals yet._" > "$ledger"

# The cold run happens HERE, not inside a reviewer. Angle X's grader has no
# shell on purpose: the code a reviewer would have to read to decide which
# invocation is safe to execute is exactly the code the review exists because
# it might be broken, and two review rounds running returned `wrong-layer` on
# every version of that bet. coldrun.sh runs a fixed set of invocations inside
# a sandbox that denies the network and confines writes, and the grader reads
# the transcript.
#
# The sandbox path carries a space because that is half of what a cold run
# tests, and it sits under the work dir, which is already required to be
# outside the repository.
cold=""; cold_skipped=""
# Keyed on the executable SURFACE, not on an X row: tier S and every compact
# round plan a single `["compact"]` finder, so a check for angle X skipped the
# cold run exactly there — and the compact brief went on telling a reviewer WITH
# a shell to run the changed script itself, uncontained. The surface is the
# question; who grades it is a separate one.
if node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).kinds.executable?.length?0:1)}catch{process.exit(1)}' "$dir/tier.json"; then
  # Reported, not swallowed, and never fatal: without a transcript angle X
  # files "could not be exercised", which is a true statement about the review.
  # Losing the round over it would not be.
  if "$here/coldrun.sh" --root "${repo_root:-$(pwd)}" --scope "$scope" --out "$dir/cold run" >"$dir/coldrun.txt" 2>"$dir/coldrun.err"; then
    cold="$dir/cold run/transcript.md"
    # A grader with no transcript is a spawn that can only file "not exercised":
    # measured 2026-08-30 at 237k tokens and four tool calls for that sentence.
    # An invocation records its exit line, so the count of those IS the answer —
    # a host with no containment executes nothing and still writes a transcript.
    invocations="$(grep -c '^- exit: ' "$cold" 2>/dev/null || true)"
    [ "${invocations:-0}" -gt 0 ] || cold_skipped="the cold run executed nothing — no invocation in $cold"
    # coldrun.sh keeps its stdout to a few lines precisely so they can land in
    # the session, and this redirected them into a file nothing reads. That hid
    # the one line the lead most needs — a host with no containment refuses to
    # execute, and the refusal's only other surface is a `minor` candidate from
    # the grader, which a round is entitled to treat as noise. A review that
    # ran nothing must say so where the person running it will see it.
    coldout="$(cat "$dir/coldrun.txt")"
  else
    cold_skipped="coldrun.sh failed — see ${dir}/coldrun.err"
    echo "round.sh: coldrun.sh failed (${dir}/coldrun.err) — angle X has no transcript to grade" >&2
  fi
fi

# No transcript, no grader. The decision belongs here and not in tier.mjs, which
# plans BEFORE the run happens: the plan says "X if there is a runnable surface",
# and the round says "and there was a transcript". Two questions, kept apart.
#
# The compact path is untouched: there the transcript goes to the single finder
# as a section, and an absent section already reads as "not exercised".
if [ -n "$cold_skipped" ]; then
  cold=""
  dropped="$(node -e '
    const fs = require("fs");
    const [file, reason] = process.argv.slice(1);
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = plan.finders.length;
    plan.finders = plan.finders.filter((row) => row.agent !== "self-review-cold-grader");
    plan.coldSkipped = reason;
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 1)}\n`);
    process.stdout.write(String(before - plan.finders.length));
  ' "$dir/tier.json" "$cold_skipped")" || dropped=""
  echo "cold run: nothing to grade — $cold_skipped${dropped:+ · angle X dropped from the plan (${dropped} finder)}"
fi

# The state the reviewers are about to be pointed at, recorded before they can
# touch it. treecheck.sh owns the format so the recorder and the comparer cannot
# drift into a false "unchanged"; SKILL.md runs the comparison when it collects
# the reports. Detection, not prevention: the prose in the agent files asks
# reviewers not to write, and one of them ran the writer under review against
# the real repository and then `git checkout` to undo it.
"$here/treecheck.sh" --work "$work" --round "$round" ${repo_root:+--root "$repo_root"} --record

"$here/brief.mjs" --round "$round" --plan "$dir/tier.json" --intent "$intent" \
  --scope "$scope" ${impact_md:+--impact "$dir/impact.md"} --prior "$dir/prior.md" --ledger "$ledger" \
  ${cold:+--cold "$cold"} --out "$dir/briefs/"

[ -z "${coldout:-}" ] || echo "$coldout"
# Where pre-flight ran is part of reading its verdict: a FAIL from the install
# copy that the checkout does not reproduce is the finding, not an artefact.
[ -z "$pf" ] || { echo "pre-flight (from ${pf_from}):"; echo "$pf"; }
