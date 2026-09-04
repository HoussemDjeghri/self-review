#!/usr/bin/env node
/**
 * Tree guard (PreToolUse hook, matcher: Bash).
 *
 * A read-only finder ran the writer it was reviewing against the real
 * repository, then `git checkout -- <files>` to put things back. The undo is
 * the destructive half: its blast radius is every uncommitted change to those
 * files, which is the author's unsaved work, and nothing in the transcript
 * says it happened. The agent files now say never to; this does not depend on
 * a reviewer having read them.
 *
 * It can ship because the PreToolUse payload identifies the caller: `agent_id`
 * is present only inside a subagent (Claude Code 2.1.251 — "Use this field,
 * not agent_type, to distinguish subagent calls from main-thread calls"), and
 * `agent_type` names which one. Without `agent_id` a hook could not tell the
 * lead's legitimate `git checkout` while fixing a finding from a reviewer's,
 * and it would have had to stay unshipped.
 *
 * Read-only git is untouched — `log`, `blame`, `diff`, `status`, `show`,
 * `stash list` — because reading git state is half of what a finder does.
 *
 * WHAT THIS IS NOT. It is a speed bump, not a boundary, and the difference
 * matters when you are deciding what to trust. It reads a command's words, and
 * an open set of spellings destroys files without ever saying `git` or `rm`:
 * `find . -exec rm -rf {} +`, `truncate -s0 f`, `: > f`, `perl -e 'unlink …'`,
 * a wrapper binary nobody enumerated. Three consecutive review rounds each
 * closed one class of bypass here and each left others; no word list converges
 * on "every shell construct that can mutate a file". What it does buy is the
 * incident it was built for — a reviewer's *tidying up*, which is a plainly
 * spelled `git checkout`/`reset`/`clean` written with no intent to evade — and
 * a denial message that teaches the reviewer the rule.
 *
 * So this file is FROZEN. A new bypass is not a finding against it, and a round
 * that patches it is spending review on the wrong layer: the property that the
 * author's uncommitted work survives a reviewer is held one layer down, by the
 * snapshot ref `treecheck.sh --record` writes before any reviewer starts
 * (`refs/self-review/<review>/round-<n>`), which makes a mutation recoverable
 * however it was spelled — and by `treecheck.sh`'s comparison afterwards, which
 * names what moved and prints the restore. Isolation — reviewers working in a
 * checkout of that snapshot rather than in the author's tree — is the layer
 * above, and is F9 in `docs/design-notes/orchestration-cost.md`. Do not read a
 * passing command here as a safe one.
 *
 * Fails open (silent exit 0) on anything unexpected; TREE_GUARD=off disables.
 */
import path from "node:path";
import { runHook } from "./lib/hook.mjs";
import { isMain } from "./lib/config.mjs";
import { afterPrefixes, inlineShell, words } from "./lib/shell.mjs";
import { noteEngagement } from "./lib/engagement.mjs";

const GUARD_TAG = "[tree-guard]";

/** The reviewers of this loop. A plugin agent's type carries a `plugin:` prefix. */
// Matches BOTH the registered type (`self-review:self-review-finder`, what a
// spawn with no name sends) and the generated name (`self-review-finder-r1-ab`,
// what `tier.mjs` produces) — because the harness puts a named agent's NAME
// into `agent_type`, so this regex is the only thing standing between a
// reviewer's shell and the author's uncommitted work, and it sees whichever of
// the two the lead happened to send. A name that does not start with the
// agent's own type is NOT guarded, by design: the plugin generates every name
// it is responsible for, and an unrecognised one is treated as not a reviewer,
// the same accepted fail-open as an unlisted `rm` spelling. F10h.
const REVIEWER = /(^|:)self-review-(finder|verifier|cold-grader)(-|$)/;

/**
 * The git verbs a reviewer may run. Everything else is denied.
 *
 * This was a denylist of writing verbs, and a denylist could not close: it
 * shipped missing `apply`, `am`, `merge`, `rebase`, `cherry-pick`, `revert`,
 * `branch -D`, `tag -d`, `config`, `worktree` and `update-index`, and the next
 * git release can add another. Reading is the enumerable direction, and a
 * reviewer that is wrongly denied loses some coverage and gets a message
 * telling it what to do instead; a reviewer that is wrongly allowed destroys
 * the author's uncommitted work with no trace.
 */
const READING_VERBS = new Set([
  "log", "blame", "diff", "diff-tree", "diff-files", "diff-index", "status", "show", "shortlog", "whatchanged",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file", "describe", "grep", "var",
  "name-rev", "for-each-ref", "show-ref", "symbolic-ref", "check-ignore", "check-attr", "check-mailmap",
  "count-objects", "verify-pack", "cherry", "range-diff", "merge-base", "help", "version", "annotate",
]);
/**
 * Verbs whose read form is a flag or a subcommand away from a write form. The
 * predicate takes the words after the verb; anything it does not accept is
 * denied like an unknown verb — `git config user.name x` writes, `git config
 * --get user.name` does not.
 */
const READING_FORMS = new Map([
  ["stash", (args) => subcommands(args, ["list", "show"])],
  ["worktree", (args) => subcommands(args, ["list"])],
  ["config", (args) => args.some((arg) => /^--(get|get-all|get-regexp|get-urlmatch|list)$/.test(arg))
    && !args.some((arg) => /^(-e|--edit|--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section)$/.test(arg))],
  ["branch", (args) => args.length > 0 && args.every(readOnlyListing)],
  ["tag", (args) => args.length > 0 && args.every(readOnlyListing)],
]);
/**
 * A subcommand verb reads when `args[0]` is a subcommand that reads. Nothing
 * else does: a flag standing where the subcommand belongs denies the command.
 *
 * Both looser rules failed open. Tolerating flags anywhere let a modifier stand
 * in for the subcommand (`git remote -v add origin <url>` adds the remote).
 * Skipping flags to find the subcommand let a value stand in for it instead
 * (`git notes --ref show add -m hack HEAD` writes a note under a ref named
 * `show`). An enumeration of skippable boolean flags was the third attempt, and
 * it permitted nothing real — git 2.38 rejects `git notes -q list` and
 * `git worktree -v list` in its own parser.
 *
 * Four review rounds went into those three designs, all of them spent modelling
 * git's per-porcelain, per-version grammar to recover coverage this guard is
 * explicitly allowed to lose. The rule now denies anything it does not fully
 * parse, and the file is frozen: the property that the author's work survives a
 * reviewer lives in treecheck.sh's snapshot ref, not here.
 */
function subcommands(args, reads) {
  return args.length > 0 && !args[0].startsWith("-") && reads.includes(args[0]);
}
// `git branch` / `git tag` with an operand creates one; with only listing flags
// they read. `-l` is the listing flag for both, and neither takes a value.
const readOnlyListing = (arg) =>
  /^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*|--color|--no-color|-i|--ignore-case)$/.test(arg);
/** git's own options before the verb: `-C <dir>`, `-c k=v`, `--no-pager`, … */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const SEPARATORS = /(?:\|\||&&|[;|\n&()])/;

/**
 * The git verb in this segment, or null when it is not a git call.
 *
 * Command position only, not "the word git appears somewhere": a finder
 * grepping the docs for `git checkout` is reading about the verb, and denying
 * that teaches the reviewer the guard is noise. Where command position *is* —
 * past `sudo -u root`, past a `then` left over from splitting an `if` at its
 * `;` — is `afterPrefixes()`, shared with the gate so the two hooks cannot
 * disagree about it again.
 */
function gitVerb(tokens) {
  let index = afterPrefixes(tokens);
  if (tokens[index] !== "git") return null;
  // `git -c alias.wipe='!rm -rf .' wipe` runs a shell command of git's own
  // choosing, so the verb that follows says nothing about what will happen.
  if (tokens.some((token) => token.startsWith("alias."))) return { verb: "-c alias.…", args: [] };
  index += 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (GIT_GLOBAL_WITH_VALUE.has(token)) { index += 2; continue; }
    if (token.startsWith("-")) { index += 1; continue; }
    // Both halves: `args` keeps the flags, because for `config`, `branch` and
    // `tag` the flag is what separates the read form from the write form.
    return { verb: token, args: tokens.slice(index + 1) };
  }
  return null;
}

/** Whether this git call only reads. An unknown verb is not a read. */
function readsOnly(git) {
  const form = READING_FORMS.get(git.verb);
  if (form) return form(git.args);
  return READING_VERBS.has(git.verb);
}

/**
 * A recursive `rm` whose operands are not all safely outside the working
 * directory. "Tracked" is not a question a hook can answer without running
 * git in the reviewer's own repo, so the rule is the one it can: absolute
 * paths outside `cwd` are the reviewer's scratchpad and are allowed.
 */
function recursiveRemoval(tokens, cwd) {
  const at = afterPrefixes(tokens);
  if (tokens[at] !== "rm") return false;
  // Everything after `rm`, not after token 0: a prefix's own words are not
  // rm's. Left at `slice(1)`, `sudo rm -rf <scratchpad>` scored `"rm"` itself as
  // a relative operand and denied the reviewer's legitimate cleanup, and
  // `xargs -r rm f` matched xargs' `-r` as rm's `--recursive`.
  const rest = tokens.slice(at + 1);
  const flags = rest.filter((token) => token.startsWith("-"));
  if (!flags.some((flag) => flag === "--recursive" || /^-[^-]*r/i.test(flag))) return false;
  const operands = rest.filter((token) => !token.startsWith("-"));
  if (!operands.length) return false;
  return operands.some((operand) => !path.isAbsolute(operand) || (cwd && operand.startsWith(`${cwd}${path.sep}`)));
}

/**
 * The reason to deny this command, or null.
 *
 * `depth` bounds the recursion into `bash -c "…"` bodies: a wrapper nests in
 * practice at most twice (`sudo -u root bash -c "sh -c '…'"`), and an
 * adversarial command must not be able to make the hook recurse forever —
 * failing open on a stack overflow is exactly the outcome the guard exists to
 * prevent.
 */
export function offence(command, cwd = "", depth = 0) {
  for (const segment of String(command).split(SEPARATORS)) {
    const tokens = words(segment);
    if (!tokens.length) continue;
    const inline = inlineShell(tokens);
    if (inline !== null && depth < 4) {
      const nested = offence(inline, cwd, depth + 1);
      if (nested) return nested;
    }
    const git = gitVerb(tokens);
    if (git && !readsOnly(git)) {
      return `\`git ${git.verb}\` is not one of the git verbs that only read`;
    }
    if (recursiveRemoval(tokens, cwd)) return "a recursive `rm` inside the working directory";
  }
  return null;
}

export function evaluate(payload) {
  // agent_id is what separates a reviewer from the lead: the lead resets files
  // legitimately while fixing findings, and denying that would break the loop.
  if (typeof payload.agent_id !== "string" || !payload.agent_id) return null;
  if (payload.tool_name !== "Bash") return null;
  const agentType = String(payload.agent_type ?? "");
  const matched = REVIEWER.test(agentType);
  // The audit line, before the decision. This is not a bypass patch — the file
  // is still frozen against those — it is ruling 1's item 2: the guard's allow
  // path and its inert path are the same silence, and that is how it came to be
  // inert for roughly ninety named finders while every review round read it and
  // correctly found it correct. Writing only into an open log keeps a project
  // that never runs this loop paying nothing; failing silently keeps a hook
  // that cannot write its audit line from holding a turn hostage.
  noteEngagement(typeof payload.cwd === "string" ? payload.cwd : "", agentType, matched, { session: payload.session_id });
  if (!matched) return null;
  const reason = offence(payload.tool_input?.command ?? "", typeof payload.cwd === "string" ? payload.cwd : "");
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: [
        `${GUARD_TAG} Denied: ${reason}, and you are a reviewer. Reviewers only read the repository — git verbs that are not plainly read-only are denied whatever they turn out to do, including as an undo.`,
        `The author's uncommitted work is in that tree. A finder that ran the writer under review and then \`git checkout -- <files>\` to tidy up destroyed every unsaved change to those files, silently.`,
        `Do now: to exercise a writer, copy what it needs into the session scratchpad named in your brief and run it there. If it cannot run outside the repository, that is angle X's job (the contained cold run) — file "not exercised" with what you read instead. If a probe has already dirtied the tree, report that in your findings; do not undo it.`,
      ].join("\n"),
    },
    systemMessage: `tree-guard: denied a tree-mutating command from ${payload.agent_type}`,
  };
}

// Guarded so the tests can import evaluate() and offence() directly: runHook
// reads stdin, and an unguarded call blocks forever under `node --test`.
if (isMain(import.meta.url)) runHook("TREE_GUARD", "tree-guard", evaluate);
