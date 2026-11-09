# shellcheck shell=bash
# capped_run <seconds> <grace> <marker> <command> [args…]
#
# Runs one command under a hard time cap and returns its exit status. The
# caller redirects the call; the command inherits those redirections.
#
# A cap is a cap. The version this replaced sent one TERM to the check's shell
# and then waited: a runner that handles TERM (pnpm waiting on its vitest
# workers) could decline it, and a grandchild the shell had started kept running
# after the shell died — CPU the next check and the finders paid for, writing
# into a file nobody read. So the command gets its own process group (`set -m`,
# because macOS has neither `timeout` nor `setsid`), the watchdog TERMs the
# whole group, waits <grace> seconds, then KILLs it, and whatever the command
# left in its group is KILLed when it returns, timed out or not.
#
# A timeout is recorded by creating <marker>, not inferred from the exit code:
# a suite that exits 143 on its own is a red suite, and one that was stopped is
# no verdict at all — callers report the two differently.
#
# Safe under `set -e`: nothing here fails the caller but the command itself.
capped_run() {
  local secs=$1 grace=$2 marker=$3
  shift 3
  rm -f "$marker"
  local had_m=0
  case $- in *m*) had_m=1 ;; esac
  set -m
  # With job control on, a background job keeps the caller's stdin instead of
  # getting /dev/null, and a check that reads it would wait out its cap.
  "$@" </dev/null &
  local pid=$!
  ( sleep "$secs"; : >"$marker"
    kill -TERM -- "-$pid" 2>/dev/null
    sleep "$grace"
    kill -KILL -- "-$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local dog=$!
  [ "$had_m" -eq 1 ] || set +m
  local rc=0
  wait "$pid" || rc=$?
  kill -- "-$dog" 2>/dev/null || true
  wait "$dog" 2>/dev/null || true
  kill -KILL -- "-$pid" 2>/dev/null || true
  return "$rc"
}
