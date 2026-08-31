#!/usr/bin/env bash
# self-review preflight — run the project's own checks before spending reviewers.
#
# Usage: preflight.sh [--out <file>] [--tail <n>] [--root <dir>] [path ...]
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
# reported as SKIP and never run. Each check is killed after
# SELF_REVIEW_PREFLIGHT_TIMEOUT seconds (default 300); the kill reaches the
# command's own shell, not always its grandchildren.
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
tail_lines=40
out=""
root=""
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
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    --*) echo "preflight.sh: unknown option $1" >&2; exit 2 ;;
    *) paths+=("$1"); shift ;;
  esac
done
case "$tail_lines" in ''|*[!0-9]*) echo "preflight.sh: --tail needs a number" >&2; exit 2 ;; esac

if [ -z "$root" ]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null) || root="$PWD"
fi
# Absolute from here on: the detectors hand this path to node and to `cd`, where
# a relative one silently resolves against the wrong directory and the report
# then claims the project defines no checks at all.
root=$(cd "$root" 2>/dev/null && pwd -P) || { echo "preflight.sh: no such directory: $root" >&2; exit 2; }

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
has_kind() { printf '%s' "$checks" | grep -q "^$1	"; }
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

# Best-effort time cap: bash 3.2 has no `timeout` binary on macOS, so a watchdog
# subshell kills the check's shell. `wait` reports 143 for a TERMed child.
run_check() {
  local cmd="$1" outfile="$2" rc
  ( cd "$root" && sh -c "$cmd" ) >"$outfile" 2>&1 &
  local pid=$!
  ( sleep "$TIMEOUT"; kill -TERM "$pid" ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" >/dev/null 2>&1
  wait "$watchdog" >/dev/null 2>&1
  return $rc
}

work=$(mktemp -d "${TMPDIR:-/tmp}/preflight.XXXXXX") || { echo "preflight.sh: cannot create temp dir" >&2; exit 2; }
trap 'rm -rf "$work"' EXIT
status="$work/status"; details="$work/details"
: >"$status"; : >"$details"
ran=0 failed=0 skipped=0

for kind in format lint types test; do
  has_kind "$kind" || continue
  cmd=$(printf '%s' "$checks" | awk -F'\t' -v k="$kind" '$1==k{print substr($0, length(k)+2); exit}')
  if is_skipped "$kind"; then
    printf 'SKIP  %-7s %s\n' "$kind" "(preflight.skip)" >>"$status"
    skipped=$((skipped + 1))
    continue
  fi
  run_check "$cmd" "$work/$kind.out"; rc=$?
  ran=$((ran + 1))
  if [ "$rc" -eq 0 ]; then
    printf 'PASS  %-7s %s\n' "$kind" "$cmd" >>"$status"
  else
    failed=$((failed + 1))
    case "$rc" in
      143|124) printf 'FAIL  %-7s %s   (timeout %ss)\n' "$kind" "$cmd" "$TIMEOUT" >>"$status" ;;
      *) printf 'FAIL  %-7s %s   (exit %s)\n' "$kind" "$cmd" "$rc" >>"$status" ;;
    esac
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
    echo "# $ran run, $failed failed, $skipped skipped"
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
else
  cat "$report"
fi
