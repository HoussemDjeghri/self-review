#!/usr/bin/env bash
# coldrun — run the shipped artifact where it has never run, inside a sandbox
# that cannot reach anything, and write down what it did.
#
# Usage: coldrun.sh [--root <repo>] [--scope <scope.diff>] [--out <dir>]
#        coldrun.sh --stage-only [--root <repo>] [--out <dir>]   # copy, don't run
#
# Angle X exists because every other angle reads the artifact and none of them
# runs it. Reading cannot catch the failure this one is for: a tool that
# resolves a path against `$PWD`, or needs a sibling directory that only exists
# in the source tree, or breaks on the space in "Application Support", passes
# every test in the repository and does nothing at all once installed. Its
# symptom is exit 0 with empty stdout, which no test suite is watching for.
#
# So the sandbox is deliberately hostile in the two ways a real install is:
#   * it is NOT the repository — nothing resolves by being next door;
#   * its path CONTAINS A SPACE — the single cheapest reproduction of unquoted
#     "$0", `dirname $0`, and word-split arguments there is.
#
# WHY THIS SCRIPT EXECUTES, AND WHY IT USED NOT TO. The first version ran each
# entry point with `--help`, on the reasoning that `--help` is conventionally
# side-effect-free; its first real run executed a test suite, because
# `tests/run.sh` parses no flags. The version after that executed nothing and
# asked the reviewing agent to pick something safe to run by hand — which is
# the same bet moved one level up, and a worse one: the code it must read to
# judge safety is exactly the code the review exists because it might be
# broken. If a `--dry-run` flag is mis-parsed, the judgement is wrong and the
# thing runs for real, with the reviewer's own credentials and network.
#
# The layer that removes the bet is containment, not better judgement:
#
#   safety by containment, coverage by selection.
#
# Once nothing here can reach the network or write outside the sandbox, WHICH
# invocation runs stops being a safety question and becomes a coverage one —
# does `--help` exercise enough to catch what X hunts? That is a question an
# agent, or a config file, is allowed to get wrong.
#
# Note that `env -i` is NOT the control. This script copies the working tree
# including the files .gitignore hides, so environment stripping would leave
# `.env`, `.envrc` and any key beside them sitting inside the sandbox with real
# values in them. Network denial is what makes a leaked secret unusable here;
# the copy also skips `.env*` outright, because a real install never has the
# developer's dotenv anyway.
#
# Exit: 0; 2 usage, an unusable --root, or a failed copy.
set -euo pipefail
set -m   # each background job in its own process group, so a timeout can kill the tree

here="$(cd "$(dirname "$0")" && pwd)"

die() { echo "coldrun.sh: $*" >&2; exit 2; }

# Long enough for an interpreter to start on a cold filesystem cache, short
# enough that a hung entry point costs one line in the transcript rather than
# the round. A timeout is itself a finding: nothing here should block.
# Overridable only so the timeout path itself is testable: a suite that waits
# ten real seconds to prove a hang is caught is a suite people stop running.
TIMEOUT="${COLDRUN_TIMEOUT:-10}"
# The transcript is read by an agent, so it is bounded before it is written:
# an entry point that prints a megabyte is a finding about the entry point, and
# the first two kilobytes say so as well as all of it.
HEAD_BYTES=2000
MAX_ENTRIES=20

root=""; out=""; scope=""; stage_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root)  [ $# -ge 2 ] || die "--root needs a directory"; root="$2";  shift 2 ;;
    --scope) [ $# -ge 2 ] || die "--scope needs a file";     scope="$2"; shift 2 ;;
    --out)   [ $# -ge 2 ] || die "--out needs a directory";  out="$2";   shift 2 ;;
    --stage-only) stage_only=1; shift ;;
    -h|--help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

root="${root:-$(pwd)}"
[ -d "$root" ] || die "no such directory: $root"
root="$(cd "$root" && pwd -P)"
[ -z "$scope" ] || [ -f "$scope" ] || die "no scope bundle at $scope"
if [ -n "$scope" ]; then
  scope_root="$(sed -n 's/^# repo: //p' "$scope" | head -1)"
  # Compared physically on both sides: `pwd` is logical by default, so a --root
  # given as /tmp and a bundle recording /private/tmp are the same tree.
  [ -z "$scope_root" ] || ! [ -d "$scope_root" ] || scope_root="$(cd "$scope_root" && pwd -P)"
  [ -z "$scope_root" ] || [ "$scope_root" = "$root" ] \
    || die "--scope describes $scope_root but --root is $root: the file list would match nothing and you would be told 'no entry point found', which is what a clean change looks like"
fi

# The space is the point, so it is in the default and not left to the caller.
# Resolved physically in BOTH branches, not just the given one: macOS hands
# mktemp a path under /var and /tmp that are symlinks to /private, and a
# seatbelt profile granted the logical path permits nothing — the sandbox would
# deny the sandbox its own directory.
if [ -z "$out" ]; then
  out="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/cold run.XXXXXX")" && pwd -P)"
else
  mkdir -p "$out" || die "cannot create --out: $out"
  out="$(cd "$out" && pwd -P)"
  case "$out" in
    *\ *) ;;
    *) echo "coldrun.sh: warning — '$out' has no space in it, so the quoting failures this exists to catch will not fire" >&2 ;;
  esac
fi
case "$out" in
  "$root"|"$root"/*) die "--out is inside the repository ($root) — then it is not a cold run" ;;
esac

# What ships is "a fresh clone plus your uncommitted work": every tracked file,
# plus every untracked file the developer has NOT ignored.
#
#   git ls-files -z --cached --others --exclude-standard
#
# `--others` is what keeps this honest — a review runs on uncommitted work, so a
# tracked-files-only copy would produce "No entry point" for the very file under
# review, which is the silent-nothing failure this angle exists to catch,
# committed by the copy step itself.
#
# `--exclude-standard` is the whole security argument. The list this replaced
# was a blocklist — `.env`, `.env.*`, `.envrc` and a handful of build dirs —
# and the script's own read-allowlist comment below rejects blocklists by name,
# for the reason this one demonstrated: it cannot name `id_rsa`, `.npmrc` with a
# token, `.netrc`, `master.key`, a service-account JSON, or this repository's own
# `.claude/settings.local.json`. Every one of those rode into the sandbox, where
# the first 2000 bytes of any invocation's stdout are copied verbatim into the
# transcript, pasted into two reviewers' briefs, and persisted as `proof` by
# findings.mjs. "The developer ignored it" is the only reliable signal of "not
# part of the project" that exists, and git already computes it — including
# .git/info/exclude and the global excludes file.
#
# It is also more accurate in the other direction: a GitHub Action with a
# committed `dist/index.js`, or a Go repo with a tracked `vendor/`, ships those,
# and the old name list dropped them.
#
# `.env`/`.env.*`/`.envrc` stay as labelled hygiene for a repo that forgot to
# ignore its dotenv. They are not the control — network denial and the read
# allowlist are — and dropping three lines for purity is the wrong trade.
copy_excludes=(.git .env .env.* .envrc)
copy_predicate="tracked and unignored files (\`git ls-files -co --exclude-standard\`)"
ship="$out/install"
rm -rf "$ship"; mkdir -p "$ship"

manifest="$out/copy-manifest"
copy_from_git=0
if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  # `--cached` lists index entries that no longer exist in the worktree, and
  # rsync exits 23 on a missing source file, so the list is filtered to what is
  # actually there. Excluded names are dropped here rather than passed as
  # --exclude, so one predicate produces one list.
  : > "$manifest"
  while IFS= read -r -d '' rel; do
    [ -e "$root/$rel" ] || continue
    keep=1
    for pat in "${copy_excludes[@]}"; do
      # shellcheck disable=SC2254  # $pat is a glob on purpose
      case "${rel##*/}" in $pat) keep=0; break ;; esac
      case "$rel" in "$pat"/*) keep=0; break ;; esac
    done
    [ "$keep" -eq 1 ] && printf '%s\0' "$rel" >> "$manifest"
  done < <(git -C "$root" ls-files -z --cached --others --exclude-standard)
  copy_from_git=1
fi

if [ "$copy_from_git" -eq 1 ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --from0 --files-from="$manifest" "$root"/ "$ship"/ \
      || die "could not copy the tracked and unignored files into the sandbox"
  else
    (cd "$root" && tar cf - --null -T "$manifest") | (cd "$ship" && tar xf -) \
      || die "could not copy the tracked and unignored files into the sandbox"
  fi
else
  # Not a git repository, or no git at all. Only reachable by hand — round.sh's
  # root always comes from scope.sh, which needs git — but the fallback must not
  # silently claim the stronger predicate, so the transcript header says which
  # one produced the copy.
  copy_predicate="working tree minus a blocklist — **not a git repository**, so ignored files were NOT filtered"
  legacy_excludes=("${copy_excludes[@]}" node_modules .venv target dist build vendor)
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${legacy_excludes[@]/#/--exclude=}" "$root"/ "$ship"/ || die "could not copy the working tree into the sandbox"
  else
    (cd "$root" && tar cf - "${legacy_excludes[@]/#/--exclude=}" .) | (cd "$ship" && tar xf -) \
      || die "could not copy the working tree into the sandbox"
  fi
fi

# Reached the way a user reaches it. A plugin, a dotfile tool and an `npm link`
# CLI all arrive through a symlink, and a symlink is where `dirname "$0"`
# quietly resolves to the wrong tree.
link="$out/via link"
ln -sfn "$ship" "$link"

# A cwd that is neither the install nor the repository — the cheapest
# reproduction of "resolves a data path against $PWD".
runcwd="$out/cwd"; mkdir -p "$runcwd"
home="$out/home";  mkdir -p "$home"

# --- staging only ----------------------------------------------------------
# `--stage-only` stops here: the copy exists, nothing has been run, and the
# install path is printed for the caller. round.sh uses it to run `preflight.sh`
# from this copy instead of from the checkout — the project's own suite, loading
# its own libraries, from a path that is not the developer's. Eleven files that
# resolved their root with `new URL(import.meta.url).pathname` survived nine
# releases because every suite in the repository computed its root from the one
# location where that cannot fail.
#
# The dependency trees an install has and this copy does not: they are ignored
# files by definition, so the copy predicate drops them, and a suite run without
# them fails on every project that has any. That is a permanent false FAIL in
# every round-1 report — the failure mode that got the first version of this fix
# rejected — so they are linked in. Linked, not copied: they are not the code
# under review, and duplicating one is the most expensive thing here. The link
# is safe where a link to the ROOT would not be, because Node realpaths
# `import.meta.url`: a dependency resolving back to the checkout is a dependency
# either way, while a root that resolved back would defeat the whole test.
if [ "$stage_only" -eq 1 ]; then
  for dep in node_modules .venv venv vendor .bundle; do
    if [ -e "$root/$dep" ] && [ ! -e "$ship/$dep" ]; then
      ln -sfn "$root/$dep" "$ship/$dep" || die "could not link $dep into the sandbox"
    fi
  done
  printf '%s\n' "$ship"
  exit 0
fi

# --- containment -----------------------------------------------------------
# Three tiers, detected here and named in the transcript, because "we ran it"
# and "we ran it where it could not reach anything" are different claims and a
# reader has to be able to tell which one they are being handed.
#
#   contained         network denied AND writes confined to the sandbox
#   network-denied    network denied only — bounded damage in a copy tree
#   uncontained       neither: nothing is executed
#
# macOS is the strong tier: sandbox-exec is documented as deprecated, but it is
# the same primitive the harness's own sandbox mode uses, so its removal is a
# shared problem rather than a reason to design around it. Linux gets bwrap
# when it is installed; `unshare -rn` alone denies the network without
# confining writes. Docker's default seccomp blocks unshare(CLONE_NEWNET), so a
# container with no bwrap lands on `uncontained` — which is exactly when
# refusing matters, because a CI runner is where the deploy tokens live.
# COLDRUN_FORCE_TIER exists for one reason: the `uncontained` branch is the
# safety-critical one and it is unreachable on any host that HAS containment,
# which is every machine this is developed on. Safety-critical code with no
# test is the shape of problem this whole design exists to remove.
#
# Validated against the three names, and not merely read: an unrecognised value
# used to flow straight through to `run_contained`, where the `case` matched no
# branch, left the wrapper array EMPTY, and executed every entry point bare —
# while `tier != "uncontained"` also skipped the refusal. `COLDRUN_FORCE_TIER=none`
# was therefore a complete bypass of every control here, reachable by anything
# that can set an environment variable. `die`, so a typo is loud.
case "${COLDRUN_FORCE_TIER:-}" in
  ""|contained|network-denied|uncontained) ;;
  *) die "COLDRUN_FORCE_TIER must be contained, network-denied or uncontained (got: ${COLDRUN_FORCE_TIER})" ;;
esac
tier="${COLDRUN_FORCE_TIER:-uncontained}"; tier_why=""
if [ -n "${COLDRUN_FORCE_TIER:-}" ]; then
  tier_why="forced by COLDRUN_FORCE_TIER"
elif command -v sandbox-exec >/dev/null 2>&1; then
  tier="contained"
elif command -v bwrap >/dev/null 2>&1; then
  tier="contained"
elif unshare -rn true >/dev/null 2>&1; then
  tier="network-denied"
  tier_why="no bubblewrap: the network is denied but writes are not confined"
else
  tier_why="no sandbox-exec, no bubblewrap, and unprivileged user namespaces are unavailable"
fi
[ "$tier" != "uncontained" ] || [ -n "$tier_why" ] || tier_why="no containment available on this host"

# Reads are denied by default too, and that is a correction: the first version
# denied only the network and writes, on the reasoning that a leaked secret is
# useless without a way to send it. It is not — `run_contained` copies the first
# two kilobytes of stdout into the transcript, and the grader reads the
# transcript. An entry point doing `cat ~/.aws/credentials` therefore exfiltrated
# a real key into the review's own context, at the STRONGEST tier, with no
# network involved. Reproduced by a reviewer on this host.
#
# An allowlist rather than a blocklist of `$HOME`: a blocklist is the same guard
# at the symptom site this whole design exists to replace, and a denied read
# fails LOUD — it shows up in the transcript as an error the grader reports —
# where a missed blocklist entry fails silent.
# `(literal "/")` first, and it is not optional: resolving any path reads the
# root directory itself, so without it seatbelt aborts every process — even
# `/bin/echo` — with SIGABRT and no diagnostic. The same goes for the symlink
# hops macOS puts in front of /etc and /var.
# Ancestors get METADATA only, never `file-read*`. Resolving a path needs to
# stat each component, not to list it, and `file-read*` on a directory literal
# also grants readdir. With the ancestors folded into `file-read*`, an
# entry point running under a sandbox whose `--out` sat below $HOME — one
# `--work ~/reviews` away, since round.sh takes that directory from its caller
# — could `ls -A $HOME` and the filenames landed in the transcript the grader
# reads. Content was still denied; names are not nothing (.aws, .ssh, an
# employer's directory). Reproduced before fixing, and pinned by a test.
# `(literal "/")` must stay a full read — with root as metadata-only every
# process dies SIGABRT with no diagnostic, the same failure the note above
# describes. Listing `/` exposes nothing but the system's top-level names.
read_allow=' (literal "/")'
meta_allow=' (literal "/etc") (literal "/var") (literal "/tmp") (literal "/private")'
# Every ancestor of the sandbox, generated rather than guessed: resolving
# `$out/install/x` stats `/private`, then `/private/tmp`, then the sandbox — and
# `realpath` on a directory whose parent is unreadable fails with EPERM, which
# is how node reported `lstat '/private/tmp'` and refused to start at all.
# From the PARENT: $out's own subtree is granted a full read below.
ancestor="$(dirname "$out")"
while [ "$ancestor" != "/" ] && [ -n "$ancestor" ]; do
  meta_allow="$meta_allow (literal \"$ancestor\")"
  ancestor="$(dirname "$ancestor")"
done
for dir in /usr /bin /sbin /opt /System /Library /etc /private/etc /dev /var/select /private/var/select /private/var/db; do
  [ -d "$dir" ] && read_allow="$read_allow (subpath \"$dir\")"
done
# Whatever PATH actually points at: a Homebrew or nvm interpreter lives outside
# the system roots above, and denying it would fail every node entry point on
# the reviewer's own machine.
# bwrap needs the same directories bound, for the same reason. Without this the
# Linux tier ran every entry point with only the system roots visible, so an
# nvm, pyenv, rbenv, cargo or linuxbrew interpreter — all normally under $HOME —
# was simply not there. The grader is told to treat "command not found" and an
# unresolved shebang as a FINDING about the artifact, so the gap did not fail
# loudly; it manufactured false positives against working code.
#
# Only the PATH directory itself is bound, never its parent: `~/bin` must not
# drag $HOME in behind it. That is the same slice the seatbelt profile grants,
# so both tiers expose the same thing.
#
# A consequence worth naming: bwrap creates the empty directories leading to a
# bind, so when a PATH entry lives under $HOME (`~/.local/bin`, `~/.nvm/...`)
# $HOME itself EXISTS inside the sandbox — as a skeleton holding nothing but
# the path to that one directory. Everything else in it is still absent, which
# is the property that matters; "the home directory does not exist" was never
# the property, and a test that asserted it was testing the wrong thing.
path_binds=()
while IFS= read -r dir; do
  [ -n "$dir" ] && [ -d "$dir" ] || continue
  phys="$(cd "$dir" && pwd -P)"
  read_allow="$read_allow (subpath \"$phys\")"
  # Skip what the fixed roots below already bind — a redundant bind is not an
  # error worth risking, and the list stays readable in a transcript.
  case "$phys" in /usr/*|/usr|/bin/*|/bin|/sbin/*|/sbin|/opt/*|/opt|/etc/*|/etc|/lib/*|/lib|/lib64/*|/lib64) continue ;; esac
  path_binds+=(--ro-bind-try "$phys" "$phys")
done < <(printf '%s' "$PATH" | tr ':' '\n' | sort -u)
read_allow="$read_allow (subpath \"$out\")"

# The wrapper for a tier, as one function, because the tier is now decided by
# RUNNING it: `command -v bwrap` said "contained" on a host where bwrap then
# died with `loopback: Failed RTM_NEWADDR: Operation not permitted`, so every
# invocation exited 1 with empty stdout while the transcript header claimed
# full containment — and empty stdout at a non-zero exit is exactly what the
# grader is told to treat as a defect in the artifact. A control that is
# present but non-functional is worse than an absent one: it reports success.
WRAPPER=()
build_wrapper() {
  WRAPPER=()
  case "$1" in
    contained)
      if command -v sandbox-exec >/dev/null 2>&1; then
        # Writes are allowed only under the sandbox, and to /dev/null, which
        # any well-behaved program uses and nothing can be harmed through.
        # Every path here is physical (see --out above) or the profile grants
        # a directory that does not exist.
        WRAPPER=(sandbox-exec -p "(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath \"$out\") (literal \"/dev/null\"))(deny file-read*)(allow file-read-metadata$meta_allow)(allow file-read*$read_allow)")
      else
        # Bound explicitly rather than `--ro-bind / /`: what is not bound does
        # not exist inside, so `$HOME` and every credential in it are simply
        # absent. `--ro-bind-try` on the paths a usr-merged distro may not have.
        #
        # Order is load-bearing: bwrap applies these in sequence and a later
        # mount buries an earlier one. `--tmpfs /tmp` therefore comes BEFORE
        # the binds, because on Linux `mktemp -d` puts $out under /tmp — with
        # the tmpfs last it covered the whole sandbox tree, and every entry
        # point exited 127 with an empty stdout, which the grader is told to
        # read as a defect in the artifact. macOS puts $out under /private/var,
        # so the local suite could not see it; CI did.
        WRAPPER=(bwrap --unshare-net --unshare-pid --die-with-parent
                 --ro-bind /usr /usr --ro-bind /etc /etc
                 --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64
                 --ro-bind-try /sbin /sbin --ro-bind-try /opt /opt
                 --dev /dev --proc /proc --tmpfs /tmp
                 ${path_binds[@]+"${path_binds[@]}"}
                 --bind "$out" "$out")
      fi
      ;;
    network-denied) WRAPPER=(unshare -rn) ;;
  esac
}

# The tier is what this host can actually ENFORCE, proved by running the real
# wrapper on `true` — not by which binaries are installed. `command -v bwrap`
# reported `contained` on a GitHub runner where bwrap then failed with
# `loopback: Failed RTM_NEWADDR: Operation not permitted`; every entry point
# exited 1 with empty stdout, the transcript header still said
# `containment: **contained**`, and the grader reads empty stdout at a non-zero
# exit as a defect in the artifact. A safety control that is present but broken
# does not fail closed on its own — it has to be made to.
#
# Skipped when the tier was forced, because the point of forcing is to exercise
# a branch this host would not otherwise take.
if [ -z "${COLDRUN_FORCE_TIER:-}" ] && [ "$tier" != "uncontained" ]; then
  mkdir -p "$out"
  # Bounded by the tier ladder, not by a flag: `uncontained` has no wrapper to
  # prove, so it is the terminating state. An earlier version looped on
  # `probe_ok` and spun forever once it got there.
  while [ "$tier" != "uncontained" ]; do
    build_wrapper "$tier"
    if [ ${#WRAPPER[@]} -gt 0 ] && ${WRAPPER[@]+"${WRAPPER[@]}"} true >/dev/null 2>"$out/.probe.err"; then
      break
    fi
    why="$(tr -d '\n' < "$out/.probe.err" 2>/dev/null | cut -c1-160)"
    case "$tier" in
      contained)
        if unshare -rn true >/dev/null 2>&1; then
          tier="network-denied"
          tier_why="a sandbox is installed but does not work here${why:+ ($why)}; the network can be denied but writes and reads cannot be confined"
        else
          tier="uncontained"
          tier_why="a sandbox is installed but does not work here${why:+ ($why)}, and unprivileged user namespaces are unavailable"
        fi
        ;;
      *)
        tier="uncontained"
        tier_why="no containment on this host worked when tried${why:+ ($why)}"
        ;;
    esac
  done
  rm -f "$out/.probe.err"
fi

# RLIMIT_NPROC is per-UID, not per-process-tree, so a fixed ceiling is either
# useless or fatal: `ulimit -u 256` on a desktop already running hundreds of
# processes killed the sandboxed shell's first `$(...)` subshell with
# "fork: Resource temporarily unavailable". Headroom over what this user
# already has is the only value that means anything — enough for a real entry
# point, far short of a fork bomb. Left empty, and the limit unset, if the
# count cannot be taken.
nproc_cap=""
if current_procs="$(ps -u "$(id -u)" 2>/dev/null | wc -l | tr -d ' ')" && [ "${current_procs:-0}" -gt 0 ] 2>/dev/null; then
  nproc_cap=$((current_procs + 128))
fi

# Memory is NOT bounded. `ulimit -v` is not enforced on macOS, and on Linux a
# value low enough to stop an allocator loop also refuses node, which reserves
# a large virtual address space at startup. Saying so beats a limit that looks
# like a control and is not one.

# The one override, and it is a config key rather than a flag: a person who
# knows their runner holds no credentials can turn this on in
# ~/.claude/self-review/config.json, and no agent can reach it. Prose asking an
# agent to be careful is what this whole design replaced.
allow_uncontained="$(node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const [pluginRoot, repoRoot] = process.argv.slice(1);
    const { loadConfig } = await import(pathToFileURL(`${pluginRoot}/hooks/lib/config.mjs`).href);
    process.stdout.write(loadConfig(repoRoot).coldRun?.uncontained ? "1" : "0");
  ' "$here/.." "$root" 2>/dev/null || echo 0)"

# `run_contained <transcript> <label> <cmd...>` — one invocation, wrapped in
# whatever this host can enforce, and appended to the transcript.
# One captured stream, disclosed when it is cut. The byte count is the whole
# capture and the fence held only the first HEAD_BYTES of it, with nothing
# between them saying so — a grader reading angle X's transcript saw a `--help`
# that stopped mid-word and could not tell a truncated command from a broken
# one. `scope.sh` already discloses its own cap; this is the same trailer.
capture() {
  local stream="$1" file="$2" total
  total="$(wc -c <"$file" | tr -d ' ')"
  if [ "$total" -gt "$HEAD_BYTES" ]; then
    printf -- '- %s (%s bytes, showing first %s):\n' "$stream" "$total" "$HEAD_BYTES"
    printf '```\n%s\n# TRUNCATED: %s bytes total, showing %s — the rest was not kept. Output that stops mid-word above was cut here, not by the command.\n```\n' \
      "$(head -c "$HEAD_BYTES" "$file")" "$total" "$HEAD_BYTES"
  else
    printf -- '- %s (%s bytes):\n' "$stream" "$total"
    printf '```\n%s\n```\n' "$(cat "$file")"
  fi
}

run_contained() {
  local log="$1" label="$2"; shift 2
  local so="$out/.stdout" se="$out/.stderr" flag="$out/.timedout"
  rm -f "$so" "$se" "$flag"

  local -a wrapper=()
  build_wrapper "$tier"
  wrapper=(${WRAPPER[@]+"${WRAPPER[@]}"})

  # `env -i` removes the inherited environment; it is a hygiene measure and not
  # the control (see the header). PATH stays because stripping it breaks every
  # shebang'd interpreter and a PATH is not a secret. stdin is /dev/null so a
  # program that reads it gets EOF instead of blocking until the timeout — and
  # one that exits 0 silently on empty stdin has just told the transcript
  # something worth grading.
  # The two decisions can never disagree: an empty wrapper is only ever correct
  # on the uncontained tier, which is reached solely through the config key.
  # Without this, any future branch that forgets to set a wrapper executes bare
  # while the transcript header still claims containment.
  if [ ${#wrapper[@]} -eq 0 ] && [ "$tier" != "uncontained" ]; then
    die "internal: tier '$tier' produced no sandbox wrapper — refusing to execute uncontained"
  fi

  local -a cmd=(env -i "PATH=${PATH}" "HOME=$home" "TMPDIR=$out" "LC_ALL=C" "TERM=dumb" "$@")
  local rc=0
  # `${wrapper[@]+...}`: on the overridden uncontained tier there is no wrapper
  # at all, and bash 3.2 — what macOS ships — calls an empty array unbound.
  # Ceilings on what the timeout cannot bound: a fork bomb exhausts the host's
  # process table well inside ten seconds, and the sandbox denies the network
  # and the filesystem, not the machine. Each is set separately and failure
  # ignored — one unsupported option in a combined `ulimit` call drops the ones
  # beside it.
  ( cd "$runcwd" \
      && { ulimit -f 51200 2>/dev/null; ulimit -t 30 2>/dev/null; ${nproc_cap:+ulimit -u "$nproc_cap" 2>/dev/null;} true; } \
      && exec ${wrapper[@]+"${wrapper[@]}"} "${cmd[@]}" ) >"$so" 2>"$se" </dev/null &
  local pid=$!
  # stdio detached from the caller's: the watcher outlives its own kill by one
  # orphaned `sleep`, and an orphan holding the script's stdout pipe open keeps
  # every caller that reads to EOF — `spawnSync`, a command substitution —
  # waiting the full timeout on runs that finished instantly.
  ( sleep "$TIMEOUT"; : >"$flag"; kill -TERM -"$pid" 2>/dev/null; sleep 2; kill -KILL -"$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
  local watcher=$!
  # Disowned so the shell does not announce "Terminated: 15" on every
  # invocation when the watcher is killed — three lines of job-control noise
  # per entry point, on the caller's stderr, saying nothing.
  disown "$watcher" 2>/dev/null || true
  { wait "$pid" || rc=$?; } 2>/dev/null
  # The GROUP, so the watcher's own `sleep` goes with it rather than lingering
  # until the timeout it was cancelled to avoid.
  kill -TERM -"$watcher" 2>/dev/null || kill "$watcher" 2>/dev/null || true
  # No duration is recorded. BSD `date` has no sub-second format and bash's
  # own $SECONDS counter ticks on a wall boundary, so an instant command
  # reports "1s" as often as "0s" — and the only duration that changes a
  # verdict is "finished" versus "hit the timeout", which the flag below says
  # exactly.

  {
    printf '### %s\n' "$label"
    printf -- '- cmd: `%s`\n' "$*"
    printf -- '- cwd: `%s`\n' "$runcwd"
    printf -- '- exit: %s%s\n' "$rc" "$([ -f "$flag" ] && echo "  — KILLED at the ${TIMEOUT}s timeout; blocking is itself a finding")"
    capture "stdout" "$so"
    capture "stderr" "$se"
    printf '\n'
  } >> "$log"
  rm -f "$so" "$se" "$flag"
}

# An entry point declares itself: a shebang, or the execute bit. Guessing from
# the directory name finds a library and misses a Makefile.
#
# Scoped to the change when a scope bundle is given. Unscoped, the first run of
# this on its own repository listed 34 entry points, 19 of them under evals/
# and 14 of those corpus fixtures — a wall of candidates the reviewer has to
# triage before doing any reviewing, which is how a tool meant to remove an
# excuse becomes one.
wanted=""
if [ -n "$scope" ]; then
  wanted="$out/changed.txt"
  # The bundle's own file list: indented status codes under one heading,
  # ending at the blank line before the diff. A rename prints `old -> new`;
  # the new path is what shipped.
  awk '/^## Changed files/ {on=1; next} on && /^$/ {exit} on {sub(/^ *[A-Z?]+ +/, ""); sub(/^.* -> /, ""); print}' "$scope" > "$wanted"
  # An empty list means the scope named no files, not "review everything": a
  # silent fallback to the whole tree is how a scoped run turns back into the
  # 34-candidate wall this flag exists to prevent.
  [ -s "$wanted" ] || echo "coldrun.sh: --scope listed no files; nothing changed to cold-run" >&2
fi

candidates=()
while IFS= read -r file; do
  rel="${file#"$ship"/}"
  case "$(basename "$file")" in .*) continue ;; esac
  [ -z "$wanted" ] || grep -qxF "$rel" "$wanted" || continue
  candidates+=("$rel")
done < <(find "$ship" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sort)
entries=("${candidates[@]+"${candidates[@]}"}")

# The product, not its fixtures. tier.mjs decides angle X's PLANNING surface
# with `shipped()` — not a test path, not under an `executableExclude` tree —
# and the two halves of one feature have to agree on what the product is. They
# did not: this repository's own corpora hold a shebang'd `bin/publish.sh` that
# tier.mjs already refuses to plan a Cold-run finder against, and this scan
# offered it anyway, as something to go and install. Nobody installs a corpus.
#
# Filtered through tier.mjs's own predicate rather than a second copy of the
# globs here, because a second copy is how the two halves disagreed in the
# first place — and it reads the config for THIS repo, so a project that
# widened `executableExclude` is honoured on both sides.
if [ ${#entries[@]} -gt 0 ]; then
  if kept="$(printf '%s\n' "${entries[@]}" | node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const [pluginRoot, repoRoot, shipRoot] = process.argv.slice(1);
      const { declaresItselfRunnable, shipped } = await import(pathToFileURL(`${pluginRoot}/scripts/tier.mjs`).href);
      const { loadConfig } = await import(pathToFileURL(`${pluginRoot}/hooks/lib/config.mjs`).href);
      const { tier } = loadConfig(repoRoot);
      const rels = readFileSync(0, "utf8").split("\n").filter(Boolean);
      const runnable = rels.filter((rel) => declaresItselfRunnable(rel, shipRoot));
      const keep = runnable.filter((rel) => shipped(rel, tier));
      // First line is the fixture count, so the caller can report what the
      // product filter removed without also counting every ordinary file that
      // was never an entry point in the first place.
      process.stdout.write([`#${runnable.length - keep.length}`, ...keep].join("\n"));
    ' "$here/.." "$root" "$ship" 2>"$out/filter.err")"; then
    dropped=0
    entries=()
    while IFS= read -r rel; do
      case "$rel" in "") continue ;; \#*) dropped="${rel#\#}"; continue ;; esac
      entries+=("$rel")
    done <<<"$kept"
    [ "$dropped" -eq 0 ] || echo "coldrun.sh: $dropped fixture(s) skipped — test paths and executableExclude trees are not the product" >&2
  else
    # Reported, not swallowed: without the filter the list is the one that
    # offers a corpus fixture as the artifact, and a reviewer who is not told
    # cannot know to distrust it.
    # Reported, not swallowed. The fallback also asks the narrower question —
    # `[ -x ]` is "may THIS uid execute it", not "does it ship executable" — so
    # the list can differ from the one tier.mjs planned against, in both
    # directions.
    entries=()
    for rel in "${candidates[@]+"${candidates[@]}"}"; do
      if [ -x "$ship/$rel" ] || [ "$(head -c 2 "$ship/$rel" 2>/dev/null)" = "#!" ]; then entries+=("$rel"); fi
    done
    echo "coldrun.sh: could not apply tier.mjs's entry-point filter (${out}/filter.err) — the list below may include test fixtures and may miss an entry point this uid cannot execute; check each path before running anything" >&2
  fi
fi

# --- the transcript --------------------------------------------------------
log="$out/transcript.md"
{
  echo "# Cold run"
  echo
  echo "- containment: **$tier**${tier_why:+ — $tier_why}"
  echo "- install: \`$ship\`  (reached through the symlink \`$link\`)"
  echo "- copy: $copy_predicate"
  echo "- cwd for every invocation: \`$runcwd\` — neither the install nor the repository"
  [ -z "$wanted" ] || echo "- scoped to the changed files"
  echo
} > "$log"

# Anything short of `contained` is refused, not run-and-labelled. The gate used
# to name only the `uncontained` tier, which inverted it: the tier that executes
# NOTHING needed a person's sign-off, while `network-denied` — which executes
# with this user's uid against the real filesystem — was unlocked by a package
# simply being absent. `unshare -rn` denies the network and nothing else, so the
# read allowlist that exists because `cat ~/.aws/credentials` once reached the
# transcript has no effect there, and neither does the write confinement: a
# latent `rm -rf "$BUILD_DIR"/*` with `$BUILD_DIR` unset reaches the real tree.
# That is a bug, not malice, and bugs are the population this angle runs on.
#
# Refusing is also not the failure this angle exists to catch. "Silently does
# nothing" is exit 0 with empty output that reads as a pass; a refusal writes
# "Nothing was executed", marks every entry point UNVERIFIED, and gives the
# grader something to file.
run_uncontained_refused=0
if [ "$tier" != "contained" ] && [ "$allow_uncontained" != "1" ]; then run_uncontained_refused=1; fi

if [ ${#entries[@]} -eq 0 ]; then
  {
    echo "## No entry point"
    echo
    echo "Nothing in the change carries a shebang or the execute bit. If this artifact"
    echo "is invoked another way — a manifest's \`bin\` field, a container, an import, a"
    echo "plugin host — it was not exercised here. If it cannot be installed at all,"
    echo "that is the finding."
  } >> "$log"
elif [ "$run_uncontained_refused" -eq 1 ]; then
  {
    echo "## Nothing was executed"
    echo
    if [ "$tier" = "network-denied" ]; then
      echo "This host can deny the network but cannot confine writes or reads: $tier_why."
      echo "An entry point here would run with this user's permissions against the real"
      echo "filesystem — no network needed to do damage — so nothing ran, and the entry"
      echo "points below are UNVERIFIED, not verified-clean."
      echo
      echo "**Install bubblewrap (\`bwrap\`) and this works immediately** — unprivileged user"
      echo "namespaces already function on this host, which is the part that is usually"
      echo "missing. \`apt install bubblewrap\`, \`dnf install bubblewrap\`, \`pacman -S bubblewrap\`."
    else
      echo "This host offers no containment: $tier_why."
      echo "Running an unknown entry point here would reach the real network and the real"
      echo "filesystem with whatever credentials this process holds, and there is no undo"
      echo "— so nothing ran, and the entry points below are UNVERIFIED, not verified-clean."
      echo
      echo "Unprivileged user namespaces do not work here, which usually means a container:"
      echo "Docker's default seccomp profile blocks \`unshare\`. Enable user namespaces for it"
      echo "(\`--security-opt seccomp=unconfined\`, or a profile permitting \`unshare\`) and"
      echo "install bubblewrap, or run the review outside the container."
    fi
    echo
    echo "To run anyway on a host you know holds no credentials, set"
    echo "\`coldRun.uncontained: true\` in ~/.claude/self-review/config.json — a person's"
    echo "decision, in a file no reviewing agent and no repository can write. It buys the"
    echo "best containment available, not none: the network stays denied where the kernel"
    echo "allows it."
    echo
    for rel in "${entries[@]}"; do echo "- \`$rel\` (not executed)"; done
  } >> "$log"
else
  shown=0
  for rel in "${entries[@]}"; do
    if [ "$shown" -ge "$MAX_ENTRIES" ]; then
      printf '_+%s more entry points not exercised (re-run with --scope to narrow)._\n' "$((${#entries[@]} - shown))" >> "$log"
      break
    fi
    shown=$((shown + 1))
    printf '## %s\n\n' "$rel" >> "$log"
    if [ -x "$ship/$rel" ]; then
      how=("$link/$rel")
    else
      # No execute bit in the copy: run it through its own shebang, and say so
      # — if a user is meant to invoke this directly, the missing bit is itself
      # the finding.
      read -r -a shb <<<"$(head -1 "$ship/$rel" | sed 's|^#!||; s|^/usr/bin/env ||')"
      how=("${shb[@]}" "$link/$rel")
      echo "_No execute bit in the copy; invoked through its shebang._" >> "$log"
      echo >> "$log"
    fi
    run_contained "$log" "no arguments" "${how[@]}"
    run_contained "$log" "--help"       "${how[@]}" --help
    run_contained "$log" "--version"    "${how[@]}" --version
  done
  {
    echo "## Coverage"
    echo
    echo "Exercised: a bare invocation, \`--help\`, \`--version\`. Those fire before argument"
    echo "parsing, so they catch the preamble class — a space in the path, an unquoted"
    echo "\`dirname \$0\`, \`set -u\` on an empty array, a shebang that does not resolve, a"
    echo "missing dependency. They do NOT exercise the artifact doing its job, so a data"
    echo "path resolved against \$PWD in the real invocation is still unexercised here."
    echo "That is a gap in coverage, not evidence of a defect."
    echo
    echo "Stdin is empty here, and never a payload. An entry point whose job begins by"
    echo "reading JSON from stdin — a Claude Code hook — therefore fails open and exits 0"
    echo "before reaching any of its own logic: read that as UNVERIFIED, not as clean. It"
    echo "stays this way on purpose; synthesising a payload means guessing each artifact's"
    echo "input protocol, and a wrong guess produces a confident false PASS."
    echo
    echo "Ignored files were not copied. An artifact that needs a gitignored build output"
    echo "fails here exactly the way it fails in a fresh clone — so \`Cannot find module"
    echo "../dist/index.js\` is a real finding about what ships, not an artefact of this"
    echo "sandbox."
  } >> "$log"
fi

# Kept small on purpose: every line printed here lands in the calling session's
# context and is paid for again on every later turn. The transcript is the
# output; this is the pointer to it.
echo "cold run: $tier"
[ -z "$tier_why" ] || echo "  $tier_why"
echo "  entry points: ${#entries[@]}"
[ "$run_uncontained_refused" -eq 0 ] || echo "  NOTHING EXECUTED — no containment on this host; the entry points are unverified"
echo "  transcript:   $log"
echo "  sandbox:      $out   (rm -rf it when done)"
