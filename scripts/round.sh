#!/usr/bin/env bash
# round — everything a review round needs before it can spawn a reviewer, in
# ONE call.
#
# Usage: round.sh --new-review --work <base> --intent <file> [--base <ref>] [options] [path ...]
#        round.sh --work <review dir> --round <n> [--intent <file>] [--force S|M|L --reason "…"] [--no-preflight]
#        round.sh --work <review dir> --round 1 --intent <file> --force S|M|L --reason "…"
#   options: [--force S|M|L --reason "…"] [--no-preflight]; --base and paths belong to --new-review only — a later round replays round 1's scope
#
# `--new-review` starts a review: it allocates `<base>/review-<k>/` (the first
# k whose plain `mkdir` succeeds), runs its round 1, and prints `work: <path>`
# as its first line — that path is `--work` for every later round. The intent
# is copied in; when it is `<base>/intent.md` it is MOVED, with `<base>/ticket/`,
# once the round exists, so the next review cannot brief against this ticket.
# One dir per review is what keeps the review's identity (findings.mjs), its
# tier ceiling and its round budget from leaking between reviews of a session:
# measured before it, one session's dir held round-1 … round-25 across six
# reviews, and review 3 opened at "round 7" with a stranger's ceiling and a
# converge that said STOP from its first look (review-identity-answer.md).
#
# It captures the scope, runs pre-flight (round 1 only), computes the blast
# radius and the plan, pulls the prior findings for these files, and writes the
# briefs — then prints the tier line, the Agent-call table, and the pre-flight
# summary last, because the pre-flight verdicts are what the caller acts on
# before spawning anyone. Nothing else; every line it prints lands in the main session's context
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
# From round 2 on it also runs `findings.mjs converge` for the round just
# finished and prints its verdict above the plan: the stopping rule ran in 7 of
# 46 measured reviews while it was a step the lead had to remember. A STOP, or
# a round whose record step never ran, refuses the round instead (exit 5).
#
# The third form re-plans round 1 in place: `--force` given to a round 1 that
# already has briefs re-runs only tier.mjs and brief.mjs over the scope round 1
# captured, and keeps the plan it replaces as `tier.replaced-<n>.json` and
# `briefs.replaced-<n>/`. It is refused once round 2 exists or a finder has
# filed against the old plan.
#
# Exit: 0; 2 usage (a bad flag, a missing intent file, a work dir inside the
# repo, a round number the work dir does not support); 4 nothing to review (an empty scope, or a change that is all assets);
# 5 the review is over or unrecorded — round N-1 said STOP, was never
# recorded, or its verdict could not be computed; the verdict (or the failing
# converge call) is printed, nothing created;
# 3 propagated from tier.mjs or brief.mjs when an input of theirs is unreadable,
# because those two are unguarded on purpose — without a plan or a brief there
# is no round, so the failure must reach the caller rather than degrade.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/path.sh
. "$here/lib/path.sh"

die() { echo "round.sh: $*" >&2; exit 2; }

# No failure is silent. Under `set -e` a step that dies ends the round with its
# own exit code and nothing on stderr: 30 field failures were a bare exit 141
# (scope.sh's SIGPIPE), each costing three to five turns of `bash -x` to find
# which step it was. The code is kept; the step and line are added.
on_err() {
  local rc=$? line=$1 step=${BASH_COMMAND%%$'\n'*}
  local why=""; [ "$rc" -le 128 ] || why=", killed by signal $((rc - 128))"
  echo "round.sh: stopped at line $line (exit $rc$why): ${step:0:200}" >&2
  exit "$rc"
}
trap 'on_err $LINENO' ERR

work=""; round=""; intent=""; base=""; force=""; reason=""; preflight=1; new_review=0
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
    --new-review) new_review=1; shift ;;
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;   # to the first non-comment line, never past it
    -*) die "unknown option: $1" ;;
    *)  paths+=("$1"); shift ;;
  esac
done

[ -n "$work" ]   || die "--work is required"
if [ "$new_review" -eq 1 ]; then
  [ -z "$round" ] || die "--new-review is round 1 of a new review; drop --round"
  round=1
fi
[ -n "$round" ]  || die "--round is required (or --new-review to start a review)"
case "$round" in ''|*[!0-9]*) die "--round needs a positive integer, got: $round" ;; esac
[ "$round" -ge 1 ] || die "--round needs a positive integer, got: $round"
# From round 2 the review's own intent is the default, as its scope is below.
[ -n "$intent" ] || [ "$round" -lt 2 ] || intent="$work/intent.md"
[ -n "$intent" ] || die "--intent is required"
# Refused before anything is created; the replay itself is with the scope below.
if [ "$round" -ge 2 ]; then
  [ -z "$base" ] && [ -z "${paths[0]+set}" ] || die "round $round reuses round 1's scope; paths and --base re-scope the change, which is a new review: round.sh --new-review --work <base> --intent <file>"
  [ -f "$work/round-1/scope-args" ] && [ -f "$work/round-1/scope-cwd" ] || die "no recorded scope for round 1 ($work/round-1/scope-args, scope-cwd) — either --work is not the work: path --new-review printed, or this review dir predates rounds replaying it. Finish it as not-converged or start it again with --new-review; a later round never falls back to the cwd"
  # The snapshot refs are keyed by the work path's spelling, which round 1
  # recorded absolute; a relative or trailing-slash --work must match it.
  work="$(abs_path "$work")"
  [ -d "$(cat "$work/round-1/scope-cwd")" ] || die "round 1 ran in $(cat "$work/round-1/scope-cwd"), which no longer exists — its scope cannot be replayed"
fi
[ -f "$intent" ] || die "no intent file at $intent — write it before the round: it is what keeps reviewers from reviewing the wrong thing"
[ -n "$force" ] || [ -z "$reason" ] || die "--reason belongs to --force"
# The mirror of it. Without this the pairing was still caught — by tier.mjs,
# after scope.sh and impact.mjs had already run and written files, and with a
# message naming a script the caller did not invoke.
[ -z "$force" ] || [ -n "$reason" ] || die "--force needs --reason \"…\": a tier set by hand has to be auditable"
# Before anything moves: a re-plan moves round 1's plan aside first, so a bad
# tier caught by tier.mjs would leave the round with no plan at all.
case "$force" in ''|S|M|L) ;; *) die "--force needs S, M or L, got: $force" ;; esac

# Checked here as well as inside scope.sh (lib/path.sh) so the round dies before
# it creates anything, and with round.sh's name on the message. This is the
# cwd's repository; the one under review is read from the scope below.
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  refuse_if_inside_repo "$work" "round.sh"
fi

# Round numbers belong to the review, and the review to its dir. A round 1
# that already produced briefs is an earlier review: running another here is
# the reuse this layout exists to end. A round 1 that died before its briefs
# (a paperwork refusal, an empty scope) never reached a reviewer, so running it
# again is a retry, not a second review — and those refusals name a retry.
#
# With `--force` it is a re-plan, which is how a tier is raised or lowered
# before anyone is launched: 36% of reviews forced their tier, and doing it
# with a second `--new-review` cost an orphaned review dir, a second scope and
# a second pre-flight. A re-plan gives the lead no power `--force` on any round
# does not already give, because the gate never reads tier.json; what round.sh
# can see is a finder that has already FILED against the old plan, and that is
# where it stops. Paths and `--base` re-scope the change, which is a new review.
replan=0
if [ "$new_review" -eq 0 ]; then
  if [ "$round" -eq 1 ] && [ -d "$work/round-1/briefs" ]; then
    [ -n "$force" ] || die "$work already holds a review's round 1 — to change its tier before anyone is launched, re-plan it: round.sh --work $work --round 1 --intent $work/intent.md --force S|M|L --reason \"…\"; to review another change, round.sh --new-review --work <base> --intent <file>. Never a reused round-1"
    [ ! -d "$work/round-2" ] || die "round-2/ exists, so round 1's tier is already the ceiling — re-planning round 1 changes nothing; use --force on the current round instead"
    [ ! -e "$work/round-1/recorded.json" ] || die "round 1 is already recorded ($work/round-1/recorded.json) — a re-plan is for before anyone is launched; use --force on round 2, or --new-review for another change"
    if [ -n "$(find "$work/round-1/state" -name '*.jsonl' -size +0 -print 2>/dev/null || true)" ]; then
      die "a finder has filed against round 1's plan ($work/round-1/state/) — a re-plan would brief the rest against a plan the filed findings were not made under"
    fi
    [ -z "$base" ] && [ -z "${paths[0]+set}" ] || die "a re-plan reuses round 1's scope; paths and --base re-scope the change, which is a new review: round.sh --new-review --work <base> --intent <file>"
    replan=1
  fi
  if [ "$round" -ge 2 ] && [ ! -f "$work/round-$((round - 1))/tier.json" ]; then
    die "round $round needs round $((round - 1)) first: there is no $work/round-$((round - 1))/tier.json — --work is the review dir --new-review printed (work: …)"
  fi
fi

# The stopping rule's verdict on the round just finished, before this round
# creates anything. It used to be printed at the top of the next round, after
# that round had started, so a spent budget read as advice and 20 reviews
# marked `converged` after a STOP. A STOP ends the review: the cap is a cost
# bound, so there is no flag past it — more review after a STOP is a new review
# (`--new-review --force S --reason …`), which re-scopes and leaves a trail. An
# unrecorded round is refused too, because W cannot be weighed on findings
# nobody wrote down. ESCALATE only prints: W has known false positives, and a
# user's "run round 3" must work without a flag.
#
# The repository is the review's, which findings.mjs reads from round 1's scope.
converged=""; prev_verdict=""
if [ "$round" -ge 2 ]; then
  prev=$((round - 1))
  if converged="$("$here/findings.mjs" converge --work "$work" --round "$prev" 2>"$work/round-$prev/converge.err")"; then
    prev_verdict="$(grep -E '^(CLEAN|CONTINUE|ESCALATE|STOP|UNRECORDED) — ' <<<"$converged" || true)"
    case "$prev_verdict" in
      "STOP — "*|"UNRECORDED — "*)
        printf '%s\n' "$prev_verdict"
        # `next:` and the lines indented under it — the call, and what to read before running it.
        awk '/^next: /{p=1; print; next} p && /^  /{print; next} {p=0}' <<<"$converged"
        exit 5 ;;
    esac
  else
    # Fail closed: an unknown verdict could be the STOP this block exists to honour.
    echo "round.sh: findings.mjs converge failed ($work/round-$prev/converge.err) — round $prev's verdict is unknown, so round $round is not planned past it. Run: $here/findings.mjs converge --work $work --round $prev" >&2
    exit 5
  fi
fi

consume_base_intent=0
if [ "$new_review" -eq 1 ]; then
  review_base="$work"
  mkdir -p "$review_base"
  # Plain mkdir, never -p: its failure on an existing dir IS the allocation.
  # The existence check turns an unwritable base into a message instead of a
  # loop that never ends.
  k=1
  until mkdir "$review_base/review-$k" 2>/dev/null; do
    [ -e "$review_base/review-$k" ] || die "cannot create $review_base/review-$k"
    k=$((k + 1))
  done
  work="$(abs_path "$review_base/review-$k")"
  echo "work: $work"
  # The id treecheck.sh keys this review's snapshots by. The marker carries it
  # (`review`), which is how the Stop gate finds the tree the last round read.
  echo "review: $(printf '%s' "$work" | git hash-object --stdin | cut -c1-8)"
  # By inode, not by spelling: /var and /private/var are one file on macOS.
  if [ "$intent" -ef "$review_base/intent.md" ]; then consume_base_intent=1; fi
  cp "$intent" "$work/intent.md"
  intent="$work/intent.md"
fi

dir="$work/round-$round"
mkdir -p "$dir/state"   # reviewers append their lifeboat lines here

# Scope first: impact, tier and every finder read this same bundle, so none of
# them can be looking at a different change from the others.
scope="$dir/scope.diff"
# A re-plan reviews the change round 1 captured, so nothing upstream of the plan
# runs again: not scope, paperwork, pre-flight, impact, the cold run or the
# tree record. None of their inputs changed, and forcing a tier is not one.
#
# Rounds 2 and later REPLAY round 1's scope rather than taking one: a review is
# one change, and the same rule the re-plan already enforces. Taken per round,
# it re-scoped silently — `round.sh --round 2` with no paths reads the cwd's
# whole working tree, so a review begun with `--base` or a path list, or run
# from another directory, reviewed a different change from round 2 on and
# nothing said so (handoff-same-scope-answer.md). Round 1 records its arguments
# and the directory they are relative to; a later round runs scope.sh there,
# and refuses rather than guessing when the record is missing.
if [ "$replan" -eq 0 ]; then
  if [ "$round" -eq 1 ]; then
    scope_cwd="$PWD"
    # NUL-separated, so a path may hold any byte but NUL and the replay never evaluates it.
    for a in ${base:+--base "$base"} ${paths[@]+"${paths[@]}"}; do printf '%s\0' "$a"; done > "$dir/scope-args"
    printf '%s\n' "$scope_cwd" > "$dir/scope-cwd"
  else
    scope_cwd="$(cat "$work/round-1/scope-cwd")"
    replay=(); while IFS= read -r -d '' a; do replay+=("$a"); done < "$work/round-1/scope-args"
    if [ "${replay[0]:-}" = "--base" ]; then base="${replay[1]}"; replay=("${replay[@]:2}"); fi
    paths=(${replay[@]+"${replay[@]}"})
    # A fix can land outside round 1's paths (a test beside the module, say),
    # and a pure replay would never review it again. So a path-scoped round
    # adds every file changed since round 1's snapshot that its paths do not
    # already cover (replay-widen-answer.md). Unscoped and --base-only reviews
    # already see those files.
    r1_roots=(); while IFS= read -r r; do [ -n "$r" ] && r1_roots+=("$r"); done < <(LC_ALL=C sed -n '/^# self-review scope (not a git repo/q; s/^# repo: //p' "$work/round-1/scope.diff" 2>/dev/null | awk '!seen[$0]++')
    if [ -n "${paths[0]+set}" ] && [ -n "${r1_roots[0]+set}" ]; then
      covered=(); for p in "${paths[@]}"; do covered+=("$(cd "$scope_cwd" && abs_path "$p")"); done
      widened=(); changed="$(mktemp)"
      for r1_root in "${r1_roots[@]}"; do
        tc=0; "$here/treecheck.sh" --work "$work" --round 1 --root "$r1_root" --changed >> "$changed" 2> "$changed.err" || tc=$?
        case "$tc" in
          0) ;;
          3) echo "scope +: not widened in $r1_root — round 1 has no tree snapshot of it, so a fix there outside its paths is not in this round's scope; read any such fix yourself" ;;
          *) err="$(cat "$changed.err")"; rm -f "$changed" "$changed.err"; die "treecheck.sh --changed failed in $r1_root (${err:-exit $tc}), so the files a fix changed outside round 1's paths are unknown — a pure replay would review less than it says" ;;
        esac
      done
      while IFS= read -r -d '' f; do
        inside=0; for c in "${covered[@]}"; do case "$f" in "$c"|"$c"/*) inside=1; break ;; esac; done
        [ "$inside" -eq 1 ] || widened+=("$f")
      done < "$changed"
      rm -f "$changed" "$changed.err"
      if [ -n "${widened[0]+set}" ]; then
        paths+=("${widened[@]}")
        echo "scope +: ${widened[*]} (changed since round 1, outside its paths)"
      fi
    fi
  fi
  # In this shell, not a subshell: the ERR trap names a step that dies only here.
  # Absolute first, because the work dir may be given relative to the cwd we leave.
  scope_abs="$(abs_path "$scope")"; work_abs="$(abs_path "$work")"
  cd "$scope_cwd"
  "$here/scope.sh" --work "$work_abs" ${base:+--base "$base"} ${paths[@]+"${paths[@]}"} > "$scope_abs"
  cd "$OLDPWD"
fi

# The repository under review is the scope's, never the cwd's: given paths are
# resolved to the repo each lives in, so a round run from anywhere else used to
# stage, pre-flight and cold-run the cwd — which refused ("--out is inside the
# repository") or was simply the wrong tree. The first `# repo:` is the one
# tier.mjs and impact.mjs analyse. None means every path is in no repository:
# there is no project to pre-flight and no tree to stage, and the round says so.
# The plain section is printed last and holds raw file text, so reading stops at
# its header — a scoped file containing a `# repo: ` line must not name the repository.
# sed quits on the first match itself: `| head -1` closed the pipe on a scope
# with a second repo below, and pipefail made sed's SIGPIPE the round's exit.
repo_root="$(LC_ALL=C sed -n '/^# self-review scope (not a git repo/q; /^# repo: /{s/^# repo: //p;q;}' "$scope")"
if [ -n "$repo_root" ]; then
  ( cd "$repo_root" && refuse_if_inside_repo "$work" "round.sh" ) || exit 2
fi

# An earlier review's work dir left inside the repository is scoped like any
# other untracked file. Measured 2026-08-30: 4,337 lines of one, tier L, six
# finders, ~3M tokens spent reviewing the review's own notes. Refused, not
# excluded silently — a silent exclusion is how a real change escapes review,
# and the signature (lib/paths.mjs isReviewPaperwork, matched on contents
# because users rename the directory) is specific enough that a false refusal
# costs the one line the message names.
if [ "$replan" -eq 1 ]; then
  :   # round 1 already passed it, over this same scope
elif ! paperwork="$(node --input-type=module -e '
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
      `  remove it (rm -r ${dir}/), or scope only the change: round.sh --new-review … <paths> (a later round replays the scope of round 1)`,
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
[ "$replan" -eq 0 ] || preflight=0
if [ "$round" -eq 1 ] && [ "$preflight" -eq 1 ] && [ -z "$repo_root" ]; then
  pf_from="no repository"
  pf="# no checks run — every path in the scope is outside a repository, so there is no project to pre-flight"
elif [ "$round" -eq 1 ] && [ "$preflight" -eq 1 ]; then
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
  # HOME is the DEVELOPER'S, deliberately, and the copy's own `home` directory is
  # left for the contained tier that coldrun.sh runs later. An empty HOME here was
  # the original design — "a suite that reads a file the developer happens to have
  # in theirs is a real install failure" — and it cost more than it ever caught.
  #
  # Every toolchain keeps its locator state in HOME: pnpm's store, rustup's
  # toolchains, Go's module cache, Yarn's global cache, Deno's cache. Emptying it
  # tells each of them to repair itself, and the repair is a WRITE — through the
  # `node_modules` symlink below, into the author's real checkout. Measured
  # 2026-09-07 on pnpm: `node_modules/.modules.yaml` records an absolute
  # `storeDir`, a moved HOME moves the default store, `checkCompatibility()`
  # throws `UnexpectedStoreError`, and pnpm purges and reinstalls — rewriting the
  # real repository's `storeDir` to a temp directory this script then deletes, so
  # the developer's next `pnpm install` offers to wipe their node_modules. Where
  # it did not write it aborted instead: eight of eight round-1 pre-flights in one
  # three-day field report reported `FAIL types` and `FAIL test`, all eight
  # carrying `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, and the operator
  # learned by the third loop to ignore preflight.txt entirely. A signal that is
  # wrong every time is worse than no signal.
  #
  # `CI=1`, the obvious fix, is the worse one: it only stops pnpm ASKING before it
  # purges. The empty HOME also silently changed which pnpm ran (corepack has no
  # cache there, so it fetches the newest) — a different toolchain than the
  # developer's, over the network, every round.
  #
  # The property that empty HOME was reaching for belongs to the contained cold
  # run, where writes are confined and the network is denied. This stage is
  # uncontained by construction (`--stage-only` stops before the tiers), and an
  # empty HOME is only safe where a write cannot escape. Ruled 2026-09-07.
  #
  # A staging failure is reported, not fatal: pre-flight from the checkout is
  # what every release until now did, and it is worth more than no pre-flight.
  pf_from="$repo_root"
  stage="$dir/cold run – ü"
  if ship="$("$here/coldrun.sh" --root "$pf_from" --stage-only --out "$stage" 2>"$dir/stage.err")" && [ -d "$ship" ]; then
    pf_from="$ship"
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
  #
  # The tripwire. `coldrun.sh --stage-only` LINKS the dependency trees rather than
  # copying them, so every check pre-flight runs has a live path into the author's
  # real checkout. Inheriting HOME removes the cause we know about; it does not
  # prove there is no other, and the invariant "a review never writes the author's
  # tree" is the one this plugin cannot get wrong quietly. So it is measured, once
  # per round, with one traversal per linked tree and no per-tool knowledge in it.
  #
  # Reported, never fatal: a dependency tree that a check legitimately touched is
  # not a reason to withhold a suite verdict the reviewers need, and the operator
  # is the one who decides what a write into their node_modules means. It is also
  # the signal that flips this design — if it fires with the developer's own HOME,
  # linking that tree is unsafe at any HOME and the answer is to stop linking that
  # one directory and report its checks as INFRA.
  sentinel="$dir/.deps-sentinel"
  : >"$sentinel"

  # pnpm 11 runs `pnpm install` before any script whose dependencies look stale,
  # and the stage always looks stale: `.pnpm-workspace-state-v1.json` records the
  # checkout's absolute project paths. That install decides to purge the linked
  # modules directory and, with no TTY, aborts — `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`,
  # exit 1, a FAIL on code nobody broke. Off for pre-flight wherever it runs: a
  # review has no business installing anything. The `pnpm_config_` spelling is
  # the one pnpm reads; `npm_config_…` is ignored (field report 2026-09-18).
  if ! pnpm_config_verify_deps_before_run=false "$here/preflight.sh" --root "$pf_from" --out "$dir/preflight.txt" >/dev/null 2>"$dir/preflight.err"; then
    echo "round.sh: preflight.sh failed (${dir}/preflight.err) — the project's own checks did not run; say so in the report" >&2
  fi

  # Only the STAGE has links to cross. On the staging-failure path above,
  # `pf_from` is the checkout itself and pre-flight is simply running the
  # project's own checks in the project's own tree — a suite touching its own
  # `node_modules/.cache` there is ordinary, and reporting it as a breach would
  # put a false alarm in the one message this block reserves for a defect in the
  # review rather than in the code.
  #
  # The linked trees are ENUMERATED, not listed: `coldrun.sh` decides what to
  # link, and a second copy of its list here would fail open — an ecosystem
  # added there would silently stop being watched. So every symlink in the stage
  # is a candidate — at any depth, since a workspace package's `node_modules` is
  # linked too — and the ones watched are those whose physical target is inside
  # the checkout: the copy also keeps links the repository itself commits, and a
  # relative one lands pointing back into the stage, where a write is the copy's
  # own business. A link to a file is never one coldrun made. `find` does not follow
  # links, so the enumeration never walks into a dependency tree; the trailing
  # slash below is what makes the second `find` descend into one. Sorted, so
  # "first:" names the same tree on every filesystem (APFS and ext4 list differently).
  tripped=""; trips=""; trip_count=0
  if [ "$pf_from" != "$repo_root" ]; then
    checkout="$(cd -P "$repo_root" && pwd)"
    while IFS= read -r link; do
      [ -n "$link" ] || continue
      target="$(cd -P "$link" 2>/dev/null && pwd || true)"
      case "$target" in "$checkout"|"$checkout"/*) ;; *) continue ;; esac
      hit="$(find "$link/" -newer "$sentinel" -print -quit 2>/dev/null || true)"
      # `if`, not `[ … ] && …`: under `set -e` a false `&&` list is a failing
      # command and would end the round on the ordinary case where nothing wrote.
      if [ -n "$hit" ]; then
        trips="${trips}TRIP  ${link#"$pf_from"/}    pre-flight wrote into the checkout through the staged link: $hit
"
        trip_count=$((trip_count + 1))
      fi
    done <<EOF
$({ find "$pf_from" -type l 2>/dev/null || true; } | LC_ALL=C sort)
EOF
  fi
  # One line however many links tripped, and every one of them in a file. A
  # monorepo's suite writes the same cache into each package's node_modules
  # (vite's `.vite-temp`, measured: ~85 TRIP lines over nine sessions), and a
  # line per package taught the lead to `grep -v TRIP` the whole block. The
  # writes are real, so they are still reported — not filtered by tool or by
  # path, since a per-tool ignore list is the blind spot this wire exists for.
  if [ "$trip_count" -eq 1 ]; then
    tripped="
${trips%$'\n'}"
  elif [ "$trip_count" -gt 1 ]; then
    printf '%s' "$trips" >"$dir/tripwire.txt"
    first="${trips%%$'\n'*}"; first="${first#TRIP  }"
    tripped="
TRIP  $trip_count linked trees    pre-flight wrote into the checkout through the staged links — first: ${first%%    *}: ${first##*staged link: }; all $trip_count in $dir/tripwire.txt"
  fi
  rm -f "$sentinel"
  # The verdict lines only — preflight.txt keeps the failure tail, and --out
  # exists precisely so that tail stays out of the main session's context.
  # `no checks detected` is a verdict too: without it the caller cannot tell
  # "pre-flight ran and this project defines nothing to run" from "pre-flight
  # never ran", and those call for opposite reactions.
  # Every check failing to START is the staging failure above, discovered one
  # step later: the reviewers still need a real verdict on the code, and the
  # checkout is where the checks are known to run. So it falls back exactly as a
  # failed stage does — and says which of the two happened, because "your suite
  # is red" and "a tool could not be run" call for different reactions.
  #
  # It does not call the stage a plugin defect, because 127 does not say that:
  # it says a tool was not found. Worded that way, it was printed ~55 times over
  # venv projects whose tools were not on PATH in the checkout either. Which of
  # the two trees lacks the tool is measured by the re-run, and said below.
  if [ "$pf_from" != "$repo_root" ] && grep -q '^# EVERY check failed to start' "$dir/preflight.txt" 2>/dev/null; then
    echo "round.sh: no check could start in the install copy — a tool not found or not executable there (exit 127/126). Re-running pre-flight from the checkout." >&2
    mv "$dir/preflight.txt" "$dir/preflight-stage.txt" 2>/dev/null || true
    # The same pnpm switch as the first run, for the same reason.
    if ! pnpm_config_verify_deps_before_run=false "$here/preflight.sh" --root "$repo_root" --out "$dir/preflight.txt" >/dev/null 2>>"$dir/preflight.err"; then
      echo "round.sh: preflight.sh failed from the checkout too (${dir}/preflight.err); say so in the report" >&2
    fi
    if grep -q '^# EVERY check failed to start' "$dir/preflight.txt" 2>/dev/null; then
      tripped="$tripped
INFRA staging  no check could start in the install copy or in the checkout — the project's tools are not runnable from this shell (see ${dir}/preflight.txt); not a staging defect"
    else
      tripped="$tripped
INFRA staging  no check could start in the install copy, and they do from the checkout — a tool the staged copy does not have (${dir}/preflight-stage.txt); the verdicts below are from the checkout"
    fi
    # The header at the end of this script names where pre-flight ran, and the
    # comment above it says why that is load-bearing. Rewriting preflight.txt
    # without moving `pf_from` printed the stage's path over the checkout's
    # verdicts — contradicting, four lines apart, the INFRA line just appended.
    pf_from="$repo_root"
  fi

  pf="$(grep -E '^# [0-9]+ run|^# no checks detected|^(PASS|FAIL|INFRA|SKIP) ' "$dir/preflight.txt" 2>/dev/null || true)"
  # The tripwire's verdict rides with the other verdicts rather than only on
  # stderr: the lead reads this block, and a write into the author's tree is the
  # one line here that is about the REVIEW rather than about the code.
  pf="$pf$tripped"

  # Ruling 1, item 3: the shipped suite, run in the shape it SHIPS in.
  #
  # The staged copy above is the repository at a foreign path, which is a
  # different property: the tests there still walk up to a repository root that
  # is present. In an install this project's `plugin/` contents ARE the root, so
  # a test that walks upward reaches the plugin cache and a test that names a
  # repo-root path finds nothing. Ten tests were in that state when release.sh
  # gained the same check; four failed and the rest passed over a tree that was
  # not the tree they meant, which is the worse half. That check runs at release
  # time, which is the last moment to learn it — this one runs in round 1.
  #
  # Off unless a project names its artifact root, because only the project knows
  # which subdirectory becomes the root of the thing it ships.
  #
  # `preflight.artifactRoot` is deliberately NOT in REPO_ADDITIVE — a repository
  # is the attacker in that threat model — so the only place that can set it is
  # the reviewing user's own `~/.claude/self-review/config.json`, which is
  # global to them and not scoped to a repository. That is the blast radius:
  # setting it for one project also names that subdirectory in every other
  # project reviewed afterwards. Hence the SKIP below rather than a FAIL, and
  # hence SKILL.md §1 documenting the key beside `preflight.skip`.
  #
  # Same three failure modes as release.sh's, for the same reasons: an empty
  # walk is a failure, a non-zero exit is a failure, and a ZERO exit is believed
  # only when the runner's own TAP plan says a suite ran and none of it failed —
  # `node --test` writes no TAP at all when NODE_TEST_CONTEXT is set, and exits
  # 0 while doing it.
  artifact_root="$(SELF_REVIEW_LIB="$here/../hooks/lib/config.mjs" SELF_REVIEW_ROOT="$repo_root" node -e '
    import(process.env.SELF_REVIEW_LIB)
      .then((m) => process.stdout.write(String(m.loadConfig(process.env.SELF_REVIEW_ROOT).preflight?.artifactRoot ?? "")))
      .catch(() => {});' 2>/dev/null || true)"
  if [ -n "$artifact_root" ] && [ -d "$repo_root/$artifact_root" ]; then
    ship_root="$dir/artifact-root"
    rm -rf "$ship_root"
    if cp -R "$repo_root/$artifact_root" "$ship_root" 2>"$dir/artifact.err"; then
      ship_tests=()
      while IFS= read -r -d "" f; do ship_tests+=("$f"); done < <(
        find "$ship_root" -name '.*' -prune -o -name '*.test.mjs' -print0 2>/dev/null | sort -z)
      if [ "${#ship_tests[@]}" -eq 0 ]; then
        # SKIP, not FAIL. The key is global to the user (see the comment above),
        # so this directory may belong to a project that never asked for the
        # check — and a project whose shipped suite is pytest, go test or vitest
        # has no *.test.mjs to find either. SKILL.md §1 tells the lead to fix
        # what pre-flight fails before spending reviewers, and a failure that is
        # not the reviewed repo's failure spends the round arguing with itself.
        # The suite being RED is still a FAIL; only "there was nothing here to
        # run" is a skip, and it says so rather than staying silent.
        pf="$pf
SKIP artifact-suite  no *.test.mjs under $artifact_root/ — nothing to run as the installed root"
      else
        ship_rc=0
        ( cd "$ship_root" && env -u NODE_TEST_CONTEXT -u NODE_OPTIONS \
            SELF_REVIEW_LOG_DIR="$dir/artifact-log" \
            node --test --test-reporter tap "${ship_tests[@]}" ) >"$dir/artifact-suite.txt" 2>&1 || ship_rc=$?
        ship_plan="$(awk '/^# tests [1-9]/{t=1} /^# fail 0$/{f=1} END{print (t && f) ? "yes" : "no"}' "$dir/artifact-suite.txt" 2>/dev/null)"
        ship_count="$(awk '/^# tests [0-9]+$/{print $3}' "$dir/artifact-suite.txt" 2>/dev/null | tail -1)"
        if [ "$ship_rc" -eq 0 ] && [ "$ship_plan" = "yes" ]; then
          pf="$pf
PASS artifact-suite  ${ship_count:-?} tests green with $artifact_root/ as the root"
        else
          pf="$pf
FAIL artifact-suite  the suite is not green with $artifact_root/ as the root (exit $ship_rc) — see $dir/artifact-suite.txt"
        fi
      fi
    else
      echo "round.sh: could not copy $artifact_root/ for the artifact-root suite (${dir}/artifact.err) — angle-blind to install-shape failures this round" >&2
    fi
  fi
fi

# Guarded like pre-flight, and unlike tier.mjs below: a missing impact.json is
# a case tier.mjs already handles (the cross-file rules are skipped, `reasons`
# says so, and tier S is lifted to M because its caller clause could not be
# checked), so an impact failure costs accuracy, not the round. Under
# `set -e` a bare call aborted with only scope.diff written — no plan, no
# briefs — while SKILL.md promised the loop keeps going without these scripts.
if [ "$replan" -eq 0 ] && ! "$here/impact.mjs" --scope "$scope" --out "$dir/" >/dev/null 2>"$dir/impact.err"; then
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

# Moved, not deleted: the computed-vs-forced history is what "forcing down is
# the one the numbers watch" audits.
if [ "$replan" -eq 1 ]; then
  n=1
  while [ -e "$dir/tier.replaced-$n.json" ] || [ -e "$dir/briefs.replaced-$n" ]; do n=$((n + 1)); done
  mv "$dir/tier.json" "$dir/tier.replaced-$n.json"
  mv "$dir/briefs" "$dir/briefs.replaced-$n"
  # Put back if the re-plan dies before its briefs exist, so a retry still
  # finds the round planned. Cleared once brief.mjs has written the new ones.
  restore_plan() {
    rm -rf "$dir/briefs"
    mv -f "$dir/tier.replaced-$n.json" "$dir/tier.json"
    mv "$dir/briefs.replaced-$n" "$dir/briefs"
  }
  trap restore_plan EXIT
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
# The verdict this round was allowed on, above the plan: CLEAN and ESCALATE
# are the lead's to weigh, and the plan is what they would spend.
if [ -n "$converged" ]; then
  echo "converge (round $prev): ${prev_verdict:-no verdict line — run findings.mjs converge --work $work --round $prev}"
fi
printf '%s\n' "$plan_out"

# Written even when empty, so the chain does not break on a repo with no memory.
# A re-plan keeps round 1's: the scope is the same, and so is the memory.
if [ "$replan" -eq 0 ]; then
  "$here/findings.mjs" prior --scope "$scope" --out "$dir/prior.md" --work "$work" >/dev/null
fi

# Ruling 1, item 2. tree-guard's allow path and its inert path are the same
# silence, which is how it went unnoticed that a named agent's `agent_type` is
# its NAME and the guard had therefore matched none of roughly ninety finders.
# Opening the log here is what scopes the guard's writes to a repository with a
# review in progress; `findings.mjs converge` reads it back at the end of the
# round and says whether the guard watched anything.
[ "$replan" -eq 1 ] || "$here/findings.mjs" engagement --work "$work" --round "$round" >/dev/null || true

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
# A re-plan grades round 1's cold run, never a second one: the run is keyed on
# `kinds.executable`, which forcing a tier does not change. So the X row is
# dropped again for the reason round 1 recorded, or kept for its transcript.
if [ "$replan" -eq 1 ]; then
  cold_skipped="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).coldSkipped??""))}catch{}' "$dir/tier.replaced-$n.json")"
  if [ -z "$cold_skipped" ] && [ -f "$dir/cold run/transcript.md" ]; then cold="$dir/cold run/transcript.md"; fi
# Keyed on the executable SURFACE, not on an X row: tier S and every compact
# round plan a single `["compact"]` finder, so a check for angle X skipped the
# cold run exactly there — and the compact brief went on telling a reviewer WITH
# a shell to run the changed script itself, uncontained. The surface is the
# question; who grades it is a separate one.
elif node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).kinds.executable?.length?0:1)}catch{process.exit(1)}' "$dir/tier.json"; then
  # Reported, not swallowed, and never fatal: the skip is recorded in tier.json
  # and printed below, which is a true statement about the review. Losing the
  # round over it would not be.
  if [ -z "$repo_root" ]; then
    cold_skipped="every path in the scope is outside a repository — there is no tree to stage for a cold run"
  elif "$here/coldrun.sh" --root "$repo_root" --scope "$scope" --out "$dir/cold run" >"$dir/coldrun.txt" 2>"$dir/coldrun.err"; then
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
# On the compact path the single finder gets the transcript as a section; with
# none, brief.mjs tells it the round reports the skip, so it files nothing.
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
# The base as a commit, not the spelling given: `HEAD` moves, and the gate reads
# this back later to ask whether the round started from a reviewed tree.
base_sha=""
[ -z "$repo_root" ] || base_sha="$(git -C "$repo_root" rev-parse --verify -q "${base:-HEAD}^{commit}" 2>/dev/null || true)"
# Partial when a path list narrowed the scope or scope.sh truncated it: either
# way the finders did not read the whole diff, and the gate must not record it.
partial=""
if [ -n "${paths[0]+x}" ] || grep -q '^# TRUNCATED:' "$scope" 2>/dev/null; then partial=1; fi
[ "$replan" -eq 1 ] || "$here/treecheck.sh" --work "$work" --round "$round" ${repo_root:+--root "$repo_root"} \
  ${base_sha:+--base "$base_sha"} ${partial:+--partial} --record

"$here/brief.mjs" --round "$round" --plan "$dir/tier.json" --intent "$intent" \
  --scope "$scope" ${impact_md:+--impact "$dir/impact.md"} --prior "$dir/prior.md" --ledger "$ledger" \
  ${cold:+--cold "$cold"} --out "$dir/briefs/"
[ "$replan" -eq 0 ] || trap - EXIT

# The base intent becomes this review's only once the round it briefs exists;
# moved earlier, a refused round 1 would strand it in a review that never ran.
if [ "$consume_base_intent" -eq 1 ]; then
  rm "$review_base/intent.md"
  if [ -d "$review_base/ticket" ]; then mv "$review_base/ticket" "$work/ticket"; fi
fi

[ -z "${coldout:-}" ] || echo "$coldout"
# Where pre-flight ran is part of reading its verdict: a FAIL from the install
# copy that the checkout does not reproduce is the finding, not an artefact.
[ -z "$pf" ] || { echo "pre-flight (from ${pf_from}):"; echo "$pf"; }
# The staged copy's path is a trap this script sets on purpose (`cold run – ü`),
# and a failure there reads correctly only to someone who knows that, so the
# output says so (cl-c-preflight-urlpath-answer.md). It reads preflight.txt, not
# $pf: the artifact-suite verdict is appended to $pf but runs under the work
# dir, so its FAIL says nothing about the staged path.
if [ -n "$pf_from" ] && [ -n "${repo_root:-}" ] && [ "$pf_from" != "$repo_root" ] && grep -q '^FAIL ' "$dir/preflight.txt" 2>/dev/null; then
  echo "  this copy's path holds a space, an en dash and ü on purpose; a check that fails here and passes in the checkout resolved a path unsafely — a percent-encoded URL path (new URL(…).pathname, not fileURLToPath), an unquoted shell variable, or an ASCII-only assumption; rerun that check in the checkout to tell which"
fi
