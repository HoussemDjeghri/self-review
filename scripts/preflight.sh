#!/usr/bin/env bash
# self-review preflight — run the project's own checks before spending reviewers.
#
# Usage: preflight.sh [--out <file>] [--tail <n>] [--root <dir>] [--deadline <epoch>] [path ...]
#
# Detects the checks this project already defines — package.json scripts,
# pyproject tools, go.mod, Cargo.toml, Makefile targets, an executable
# ./test.sh — runs the ones whose ecosystem the changed paths touch, and prints
# one line per check plus the tail of each failure. A reviewer reading code that
# fails its own tests reviews the wrong thing, and finding that out costs one
# Bash call here instead of a round of agents.
#
# Paths narrow which ecosystems run (only the ones whose file types changed);
# with no paths, everything detected runs. Checks named in `preflight.skip`
# (config/defaults.json, overridden by ~/.claude/self-review/config.json) are
# reported as SKIP and never run. Each check is stopped after
# SELF_REVIEW_PREFLIGHT_TIMEOUT seconds (default 300) — its whole process group,
# TERM and then KILL after SELF_REVIEW_PREFLIGHT_GRACE seconds (default 5).
# --deadline is an absolute time (epoch seconds) shared with the caller's other
# work: each check gets what is left of it, and a check with less than 10 s left
# is SKIP rather than started.
#
# A check is PASS, FAIL, INFRA or SKIP. INFRA is "no verdict on the code": the
# command could not be run at all (exit 126/127), or it was stopped before it
# finished. Both are counted apart from FAIL on purpose, so that a genuine red
# still stands out against an environment that is broken or a suite that is slow.
#
# Exit 0 even when checks fail — a failing check is the report, not an error, so
# the caller reads the report instead of branching on $?. Exit 2 is usage.
set -uo pipefail

TIMEOUT=${SELF_REVIEW_PREFLIGHT_TIMEOUT:-300}
# A watchdog built on a bad interval kills every check the moment it starts and
# reports the whole project as timing out, so the value is checked, not trusted.
case "$TIMEOUT" in
  ''|*[!0-9]*|0) echo "preflight.sh: SELF_REVIEW_PREFLIGHT_TIMEOUT must be a positive whole number of seconds, not '$TIMEOUT'; using 300" >&2
                 TIMEOUT=300 ;;
esac
GRACE=${SELF_REVIEW_PREFLIGHT_GRACE:-5}
case "$GRACE" in
  ''|*[!0-9]*|0) echo "preflight.sh: SELF_REVIEW_PREFLIGHT_GRACE must be a positive whole number of seconds, not '$GRACE'; using 5" >&2
                 GRACE=5 ;;
esac
tail_lines=40
out=""
root=""
deadline=""
paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "preflight.sh: --out needs a file" >&2; exit 2; }
           out="$2"; shift 2 ;;
    --out=*) out="${1#--out=}"; shift ;;
    --tail) [ $# -ge 2 ] || { echo "preflight.sh: --tail needs a number" >&2; exit 2; }
            tail_lines="$2"; shift 2 ;;
    --tail=*) tail_lines="${1#--tail=}"; shift ;;
    --root) [ $# -ge 2 ] || { echo "preflight.sh: --root needs a directory" >&2; exit 2; }
            root="$2"; shift 2 ;;
    --root=*) root="${1#--root=}"; shift ;;
    --deadline) [ $# -ge 2 ] || { echo "preflight.sh: --deadline needs an epoch time" >&2; exit 2; }
                deadline="$2"; shift 2 ;;
    --deadline=*) deadline="${1#--deadline=}"; shift ;;
    # Derived, not a line range: the range was '2,21p' and this header grew by
    # four lines, so --help silently stopped printing its last paragraph. The
    # header runs from the shebang to the first `set -`, which is the same form
    # round.sh, treecheck.sh, coldrun.sh and scope.sh use — and unlike a
    # stop-at-the-first-non-comment scan it survives a blank line inside the
    # header, which is the same truncation with a different trigger.
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    --*) echo "preflight.sh: unknown option $1" >&2; exit 2 ;;
    *) paths+=("$1"); shift ;;
  esac
done
case "$tail_lines" in ''|*[!0-9]*) echo "preflight.sh: --tail needs a number" >&2; exit 2 ;; esac
case "$deadline" in *[!0-9]*) echo "preflight.sh: --deadline needs an epoch time in seconds" >&2; exit 2 ;; esac

if [ -z "$root" ]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null) || root="$PWD"
fi
# Absolute from here on: the detectors hand this path to node and to `cd`, where
# a relative one silently resolves against the wrong directory and the report
# then claims the project defines no checks at all.
root=$(cd "$root" 2>/dev/null && pwd -P) || { echo "preflight.sh: no such directory: $root" >&2; exit 2; }

# The project's own virtualenv first on PATH, as `npm run` puts node_modules/.bin
# there for a script. coldrun.sh already links `.venv` into the staged copy the
# way it links node_modules, but nothing activated it: no review shell has, so
# `ruff` was whatever PATH held — in the field a pyenv shim that answers 127 for
# a Python the project pins and the machine lacks — and every check of a uv
# project "could not start" (~55 times in 6 sessions). Detection below goes
# through the same PATH, so a tool only the venv holds is now found at all.
for venv in .venv venv; do
  if [ -d "$root/$venv/bin" ]; then PATH="$root/$venv/bin:$PATH"; break; fi
done

# Which ecosystems the change touched. No paths = no information, so everything
# detected runs; project-wide runners (Makefile, ./test.sh) always run.
eco_node=0 eco_py=0 eco_go=0 eco_rs=0
if [ ${#paths[@]} -eq 0 ]; then
  eco_node=1 eco_py=1 eco_go=1 eco_rs=1
else
  for p in "${paths[@]}"; do
    case "$p" in
      *.js|*.mjs|*.cjs|*.jsx|*.ts|*.tsx|*.json) eco_node=1 ;;
      *.py|*.pyi|pyproject.toml) eco_py=1 ;;
      *.go|go.mod|go.sum) eco_go=1 ;;
      *.rs|Cargo.toml) eco_rs=1 ;;
    esac
  done
fi

# Checks are "kind<TAB>command" lines; the first detector to claim a kind wins,
# so a package.json "test" script beats a Makefile target of the same name.
checks=""
# Here-strings, not `printf | grep -q`: an early-exiting reader under pipefail
# turns the writer's SIGPIPE into the pipeline's status (scope.sh's exit 141).
has_kind() { grep -q "^$1	" <<<"$checks"; }
add_check() { has_kind "$1" || checks="$checks$1	$2
"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

if [ "$eco_node" = 1 ] && [ -f "$root/package.json" ]; then
  pm=npm
  # First match wins, in this order — a repo mid-migration keeps two lockfiles,
  # and which package manager runs the checks must not be decided by loop order.
  for candidate in "pnpm-lock.yaml pnpm" "yarn.lock yarn" "bun.lockb bun"; do
    set -- $candidate
    if [ -f "$root/$1" ] && command_exists "$2"; then pm="$2"; break; fi
  done
  scripts=$(node -e 'const s=require(process.argv[1]).scripts||{};console.log(Object.keys(s).join(" "))' "$root/package.json" 2>/dev/null || true)
  has_script() { case " $scripts " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
  for s in format:check fmt:check format-check prettier:check; do has_script "$s" && { add_check format "$pm run $s"; break; }; done
  for s in lint eslint; do has_script "$s" && { add_check lint "$pm run $s"; break; }; done
  for s in typecheck type-check tsc types; do has_script "$s" && { add_check types "$pm run $s"; break; }; done
  has_script test && add_check test "$pm test"
fi

if [ "$eco_py" = 1 ] && { [ -f "$root/pyproject.toml" ] || [ -f "$root/setup.cfg" ] || [ -f "$root/tox.ini" ]; }; then
  py_paths="."
  [ ${#paths[@]} -gt 0 ] && py_paths=$(printf '%q ' "${paths[@]}")
  command_exists ruff && { add_check format "ruff format --check $py_paths"; add_check lint "ruff check $py_paths"; }
  command_exists mypy && add_check types "mypy $py_paths"
  command_exists pytest && add_check test "pytest -q"
fi

if [ "$eco_go" = 1 ] && [ -f "$root/go.mod" ] && command_exists go; then
  # gofmt -l exits 0 whether or not it listed files, so the listing is the test.
  add_check format 'out=$(gofmt -l .); [ -z "$out" ] || { echo "$out"; exit 1; }'
  add_check lint "go vet ./..."
  add_check test "go test ./..."
fi

if [ "$eco_rs" = 1 ] && [ -f "$root/Cargo.toml" ] && command_exists cargo; then
  add_check format "cargo fmt --check"
  cargo clippy --version >/dev/null 2>&1 && add_check lint "cargo clippy -q"
  add_check test "cargo test -q"
fi

if [ -f "$root/Makefile" ] || [ -f "$root/makefile" ]; then
  makefile="$root/Makefile"; [ -f "$makefile" ] || makefile="$root/makefile"
  make_target() { grep -qE "^$1:" "$makefile"; }
  make_target fmt && add_check format "make fmt"
  make_target lint && add_check lint "make lint"
  make_target typecheck && add_check types "make typecheck"
  make_target test && add_check test "make test"
fi

[ -x "$root/test.sh" ] && add_check test "./test.sh"

# `import()` of a bare specifier looks in node_modules, so the config library is
# resolved to an absolute path first — otherwise `bash scripts/preflight.sh`
# loads no config at all and every configured skip is silently ignored.
lib_dir=$(cd "$(dirname -- "$0")/../hooks/lib" 2>/dev/null && pwd -P) || lib_dir=""
skips=""
if [ -n "$lib_dir" ]; then
  skips=$(SELF_REVIEW_LIB="$lib_dir/config.mjs" SELF_REVIEW_ROOT="$root" node -e '
    import(process.env.SELF_REVIEW_LIB).then((m) => {
      console.log((m.loadConfig(process.env.SELF_REVIEW_ROOT).preflight?.skip ?? []).join(" "));
    }).catch((error) => {
      process.stderr.write(`preflight.sh: cannot read the self-review config (${error.message}); running every detected check\n`);
    });')
else
  echo "preflight.sh: cannot find the plugin's hooks/lib next to this script; running every detected check" >&2
fi

is_skipped() { case " $skips " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# shellcheck source=lib/capped.sh
. "$(dirname -- "$0")/lib/capped.sh"

# The project's command under a hard cap; `$3` is created if the cap stopped it.
run_check() {
  local cmd="$1" outfile="$2" marker="$3" cap="$4"
  capped_run "$cap" "$GRACE" "$marker" sh -c 'cd "$1" && exec sh -c "$2"' sh "$root" "$cmd" >"$outfile" 2>&1
}

work=$(mktemp -d "${TMPDIR:-/tmp}/preflight.XXXXXX") || { echo "preflight.sh: cannot create temp dir" >&2; exit 2; }
trap 'rm -rf "$work"' EXIT
status="$work/status"; details="$work/details"
: >"$status"; : >"$details"
ran=0 failed=0 skipped=0 infra=0 unfinished=0

for kind in format lint types test; do
  has_kind "$kind" || continue
  cmd=$(awk -F'\t' -v k="$kind" '$1==k{print substr($0, length(k)+2); exit}' <<<"$checks")
  if is_skipped "$kind"; then
    printf 'SKIP  %-7s %s\n' "$kind" "(preflight.skip)" >>"$status"
    skipped=$((skipped + 1))
    continue
  fi
  cap=$TIMEOUT
  if [ -n "$deadline" ]; then
    left=$((deadline - $(date +%s)))
    if [ "$left" -lt 10 ]; then
      printf 'SKIP  %-7s %s   (pre-flight budget spent — re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged)\n' "$kind" "$cmd" >>"$status"
      skipped=$((skipped + 1))
      continue
    fi
    [ "$left" -ge "$cap" ] || cap=$left
  fi
  run_check "$cmd" "$work/$kind.out" "$work/$kind.stopped" "$cap"; rc=$?
  ran=$((ran + 1))
  if [ -e "$work/$kind.stopped" ]; then
    # Stopped is not red. A cap that fired says the suite is slower than the
    # cap, which is a fact about the budget: in 6 of 12 CopilotKit runs the
    # 300 s cap stopped a `pnpm test` whose tail read 915 passed of 915, and
    # every one was reported FAIL — wrong every time, which is the signal this
    # report has learned not to send. A hang the change caused reads the same,
    # so the line says there is no verdict and the tail is kept below; the lead
    # reports the suite unverified, an absent signal rather than a false one,
    # and it blocks `converged` until a re-run gives the check a verdict.
    # Read from the marker, never from exit 143: a suite that exits 143 by
    # itself is a red suite.
    unfinished=$((unfinished + 1))
    printf 'INFRA %-7s %s   (did not finish in %ss — no verdict on the code; re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged)\n' "$kind" "$cmd" "$cap" >>"$status"
    {
      echo
      echo "--- DID NOT FINISH $kind: last $tail_lines lines of \`$cmd\` ---"
      tail -n "$tail_lines" "$work/$kind.out"
    } >>"$details"
  elif [ "$rc" -eq 0 ]; then
    printf 'PASS  %-7s %s\n' "$kind" "$cmd" >>"$status"
  elif [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    # A check that could not START is not a check that failed, and reporting it
    # as FAIL is worse than reporting nothing: measured over three days of use,
    # a pre-flight that false-failed in 8 of 8 rounds taught its operator to
    # skip the section entirely, so the round where it was finally right was
    # skipped with the rest. 126 is "found but not executable", 127 is "not
    # found" — the shell's own answer to "did this ever run", which is why they
    # are the whole test. A per-tool error-string list (`ERR_PNPM_…`,
    # `npm ERR! code E…`) would catch more and rot silently, and a check that
    # rots is the thing being fixed here.
    infra=$((infra + 1))
    printf 'INFRA %-7s %s   (exit %s — the command could not be run; the check never started)\n' "$kind" "$cmd" "$rc" >>"$status"
  else
    failed=$((failed + 1))
    printf 'FAIL  %-7s %s   (exit %s)\n' "$kind" "$cmd" "$rc" >>"$status"
    {
      echo
      echo "--- FAIL $kind: last $tail_lines lines of \`$cmd\` ---"
      tail -n "$tail_lines" "$work/$kind.out"
    } >>"$details"
  fi
done

report="$work/report"
{
  echo "# self-review preflight"
  echo "# repo: $root   generated: $(date -u +%FT%TZ)"
  if [ "$ran" -eq 0 ] && [ "$skipped" -eq 0 ]; then
    echo "# no checks detected — this project defines no formatter, linter, type-checker or test command that preflight recognises"
  else
    echo "# $ran run, $failed failed, $infra could not start, $unfinished did not finish, $skipped skipped"
    if [ "$ran" -gt 0 ] && [ "$infra" -eq "$ran" ]; then
      echo "# EVERY check failed to start (exit 126/127: a tool not found or not executable where they ran)."
      echo "# Nothing here is a verdict on the code, and the reviewers still need a real one."
    fi
  fi
  cat "$status"
  cat "$details"
} >"$report"

if [ -n "$out" ]; then
  mkdir -p "$(dirname -- "$out")" 2>/dev/null || true
  cp "$report" "$out" || { echo "preflight.sh: cannot write $out" >&2; exit 2; }
  # stdout stays the summary: the failure tails are one Read away in the file.
  sed -n '1,3p' "$report"; cat "$status"
  [ "$failed" -eq 0 ] || echo "# failures quoted in $out"
  [ "$unfinished" -eq 0 ] || echo "# tails of the checks that did not finish quoted in $out"
else
  cat "$report"
fi
