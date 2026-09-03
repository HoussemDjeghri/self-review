// Run: node --test plugin/hooks/tree-guard.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, offence } from "./tree-guard.mjs";
import { agentDefinition, grants } from "./lib/frontmatter.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "tree-guard.mjs");

const FINDER = {
  tool_name: "Bash",
  agent_id: "agt_123",
  agent_type: "self-review:self-review-finder",
  cwd: "/repo",
};
const call = (command, over = {}) => evaluate({ ...FINDER, ...over, tool_input: { command } });
const denied = (command, over) => Boolean(call(command, over));

test("the undo from the field report is denied, and so is every other writing verb", () => {
  assert.ok(denied("git checkout -- scripts/x.mjs"));
  for (const verb of ["restore .", "reset --hard", "stash", "stash push -u", "clean -fd", "switch main",
    "commit -am wip", "add -A", "rm f.mjs", "mv a b",
    // The eleven a denylist of writing verbs shipped without, which is why the
    // rule is now an allowlist of the verbs that read.
    "apply p.patch", "am p.patch", "merge foo", "rebase main", "cherry-pick abc", "revert abc",
    "branch -D foo", "tag -d v1", "config user.name x", "worktree remove --force w", "update-index --refresh",
    // And the ones nobody enumerated: a new verb is denied by default now.
    "push", "fetch", "pull", "submodule update", "filter-branch", "gc --prune=now"]) {
    assert.ok(denied(`git ${verb}`), `git ${verb}`);
  }
  assert.ok(denied(`git -c alias.wipe='!rm -rf .' wipe`),
    "an alias is a shell command of git's choosing; the verb after it says nothing");
  assert.match(call("git checkout -- x")?.hookSpecificOutput?.permissionDecisionReason,
    /do not undo it/, "the reason says what to do instead, which is the part that changes behaviour");
});

test("reading git state is what a finder is for, and stays allowed", () => {
  for (const read of ["log --oneline -5", "blame x.mjs", "diff HEAD", "status --porcelain", "show HEAD:x",
    "rev-parse --show-toplevel", "stash list", "stash show", "-C /elsewhere log",
    "ls-files", "ls-tree HEAD", "cat-file -p HEAD", "describe --tags", "grep -n foo", "shortlog -sn",
    "merge-base a b", "for-each-ref", "check-ignore x",
    // The read half of a verb whose other half writes.
    "config --get user.name", "config --list", "worktree list", "branch -l", "branch -a", "tag -l"]) {
    assert.equal(denied(`git ${read}`), false, `git ${read}`);
  }
});

test("the read form of a verb is the flag, not the verb", () => {
  // `config`, `branch` and `tag` each write in one shape and read in another,
  // so the allowlist asks the arguments, not just the verb.
  assert.ok(denied("git config user.name x"), "setting is not getting");
  assert.ok(denied("git branch newthing"), "an operand creates the branch");
  assert.ok(denied("git tag v9"));
  assert.ok(denied("git branch"), "bare `git branch` is a listing, but the rule asks for the flag that says so");
  assert.equal(denied("git branch --show-current"), false);
});

test("a writing verb hidden behind git's own options is still found", () => {
  assert.ok(denied("git -C /repo checkout -- x"));
  assert.ok(denied("git --no-pager reset --hard"));
  assert.ok(denied("git -c user.name=t commit -m x"));
});

test("a writing verb in any segment of a chain is found", () => {
  assert.ok(denied("sed -n '1,20p' x.mjs; git checkout -- x.mjs"));
  assert.ok(denied("node writer.mjs && git restore ."));
  assert.ok(denied("printf x >> state.jsonl || git reset"));
  assert.equal(denied("grep -n 'git checkout' docs/DESIGN.md"), false,
    "quoting the verb inside a search pattern is reading about it, not running it");
});

test("a flag is never evidence that a subcommand reads", () => {
  // `git remote -v add origin <url>` adds the remote. The predicate asked
  // args[0], saw `-v`, and allowed it — word-position matching reproduced
  // inside the rule written to replace it.
  for (const command of ["git remote -v add origin https://example.com/x.git", "git remote --verbose remove origin",
    "git remote -v set-url origin https://example.com/x.git", "git stash -v push", "git worktree -v remove w",
    "git remote rename a b", "git stash", "git worktree add ../x", "git notes add -m x",
    "git submodule update --init", "git config --get x --unset y", "git config --edit"]) {
    assert.ok(denied(command), command);
  }
  for (const read of ["git stash show -p", "git worktree list"]) {
    assert.equal(denied(read), false, read);
  }
});

test("a flag's value is never evidence that a subcommand reads", () => {
  // Round 4 skipped flags to find the subcommand, and that fails OPEN: the
  // value of a value-taking flag lands in the subcommand's place. Both of
  // these write a note while the skipping rule read `show` / `list`.
  for (const command of ["git notes --ref show add -m hack HEAD", "git notes --ref list remove HEAD",
    "git stash --message list push", "git worktree --lock-reason list add ../w",
    "git submodule --cached status deinit --all"]) {
    assert.ok(denied(command), command);
  }
  // A flag before the subcommand denies, whatever the flag: git 2.38 rejects
  // `git notes -q list` and `git worktree -v list` in its own parser, so
  // enumerating "safe" boolean flags here would model five porcelains'
  // per-version grammar to permit commands nobody can run.
  for (const command of ["git notes -q list", "git worktree -v list", "git submodule -v status",
    "git stash -q list"]) {
    assert.ok(denied(command), command);
  }
  // `remote`, `notes` and `submodule` are no longer read forms at all. Their
  // read subcommands cost four review rounds of git-grammar modelling and had
  // no caller in this repository, and the guard is allowed to lose coverage:
  // the work they were protecting is held by treecheck.sh's snapshot ref.
  for (const command of ["git remote", "git remote -v", "git remote show origin", "git notes",
    "git notes show", "git submodule", "git submodule status"]) {
    assert.ok(denied(command), command);
  }
});

test("the read forms stay readable and the write forms stay denied", () => {
  // The counts commit cf2d7c2 claimed came from a probe that was never checked
  // in; these are that probe, so the claim is now the suite's to keep. A
  // listing flag WITH a pattern (`git tag -l 'v*'`) is denied on purpose: this
  // rule cannot tell the pattern from a tag name to create, and on git before
  // 2.30 `branch -l` meant --create-reflog, so the operand form is guesswork.
  const reads = ["git log -1", "git status --porcelain", "git show HEAD:f", "git diff --cached",
    "git rev-parse --show-toplevel", "git ls-files -m", "git cat-file -p HEAD", "git describe --tags",
    "git branch -a", "git tag -l", "git config --get user.name", "git config --list",
    "git stash list", "git worktree list"];
  for (const read of reads) assert.equal(denied(read), false, read);
  const writes = ["git commit -m x", "git add -A", "git rm -r f", "git mv a b", "git reset --hard",
    "git checkout -- .", "git restore .", "git clean -fd", "git stash push", "git stash drop",
    "git branch -D x", "git tag -d v1", "git config user.name x", "git notes add -m x",
    "git submodule deinit --all", "git worktree remove w"];
  for (const write of writes) assert.ok(denied(write), write);
  assert.equal(reads.length, 14);
  assert.equal(writes.length, 16);
});

test("a shell wrapper is not a hiding place: the gate saw through these, the guard did not", () => {
  // Filed by three finders independently in round 1 of the F1-F8 review: every
  // one of these returned null while the bare form was denied.
  for (const command of [`bash -c 'git checkout -- x'`, `sh -c "git reset --hard"`, `sudo -u root git clean -fd`,
    `sudo -u root bash -c "git clean -fd"`, `env FOO=1 git add -A`, `command git rm f`, `exec git commit -m x`]) {
    assert.ok(denied(command), command);
  }
  assert.ok(denied(`bash -c "rm -rf ./build"`), "the rm rule reads command position the same way");
  assert.equal(denied(`bash -c "git log --oneline"`), false, "unwrapping does not make a read into a write");
});

test("a keyword left over from splitting a compound command is skipped", () => {
  // SEPARATORS cuts at `;`, so the segment that carries the verb starts with a
  // bare `then` / `do` / `{` — a word neither hook used to step past.
  for (const command of ["if true; then git checkout -- x; fi", "for i in 1; do git reset --hard; done",
    "while read l; do git add .; done", "{ git checkout -- x; }", "! git commit -m x",
    "if [ -f x ]; then sudo -u root bash -c 'git clean -fd'; fi"]) {
    assert.ok(denied(command), command);
  }
});

test("recursion into an inline shell is bounded", () => {
  // Two wrappers is what a real command reaches (`sudo` around `bash -c` around
  // `sh -c`); past the cap the hook stops unwrapping rather than recursing on
  // adversarial input, because a stack overflow fails open.
  assert.ok(denied(`sudo -u root bash -c "sh -c 'git reset --hard'"`), "the depth a real wrapper reaches");
  assert.equal(offence(`bash -c 'git reset --hard'`, "/repo", 4), null, "at the cap it stops unwrapping");
});

test("a recursive rm is judged by where it points", () => {
  assert.ok(denied("rm -rf build"), "relative: inside the working directory");
  assert.ok(denied("rm -rf /repo/build"));
  assert.equal(denied("rm -rf /tmp/scratch/probe"), false, "the scratchpad is where a reviewer may write");
  assert.equal(denied("rm /repo/build/one.o"), false, "not recursive");
  assert.equal(denied("rm -rf"), false, "no operand, nothing to judge");
});

test("a prefix's own words are not rm's operands or rm's flags", () => {
  // The command-position fix moved where `rm` is looked for and left the
  // operand slice at token 1, so `"rm"` itself scored as a relative operand and
  // the guard denied the very cleanup its docstring allows.
  for (const command of ["sudo rm -rf /tmp/scratch/probe", "sudo -u root rm -rf /tmp/scratch/probe",
    "env FOO=1 rm -rf /tmp/scratch/probe", "time rm -rf /tmp/scratch/probe"]) {
    assert.equal(denied(command), false, command);
  }
  assert.equal(denied("xargs -r rm /repo/build/one.o"), false, "xargs' own -r is not rm's --recursive");
  assert.ok(denied("sudo rm -rf ./build"), "and the wrapped removal inside the tree is still denied");
});

test("the lead is untouched: without agent_id the hook says nothing", () => {
  // The lead resets files legitimately while fixing findings. This is the whole
  // reason the guard could not ship until the payload identified the caller.
  assert.equal(call("git checkout -- x", { agent_id: undefined }), null);
  assert.equal(call("git checkout -- x", { agent_id: "" }), null);
  assert.equal(call("git checkout -- x", { agent_type: "general-purpose" }), null,
    "another kind of subagent is not this loop's reviewer");
  assert.equal(call("git checkout -- x", { tool_name: "Edit" }), null);
});

test("a bare agent type with no plugin prefix is still a reviewer", () => {
  assert.ok(denied("git checkout -- x", { agent_type: "self-review-verifier" }));
  assert.ok(denied("git checkout -- x", { agent_type: "self-review-cold-grader" }));
  assert.equal(denied("git checkout -- x", { agent_type: "not-self-review-finder-either" }), false);
});

test("offence() reports the verb it found, for the message", () => {
  assert.match(offence("git reset --hard"), /`git reset`.*only read/);
  assert.match(offence("rm -r x", "/repo"), /recursive/);
  assert.equal(offence("node --test x.test.mjs"), null);
});

test("run as the harness runs it, it denies on stdin and fails open on nonsense", () => {
  const hook = (payload, env = {}) =>
    spawnSync("node", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });

  const deny = hook({ ...FINDER, tool_input: { command: "git checkout -- x" } });
  assert.equal(deny.status, 0, "a hook must never hold a turn hostage");
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");

  assert.equal(hook({ ...FINDER, tool_input: { command: "git log" } }).stdout, "");
  assert.equal(hook({}).stdout, "", "no agent_id, no opinion");
  assert.equal(hook({ ...FINDER, tool_input: { command: "git checkout -- x" } }, { TREE_GUARD: "off" }).stdout, "",
    "the kill switch every hook in this plugin has");
});

// The other half of the seam tested in self-review-gate.test.mjs: `REVIEWER`
// above is a third hardcoded list of the same names, and this one decides
// whether an agent's shell can touch git at all. The subject is again the files
// on disk, so a new agent with a shell is covered the day it ships rather than
// the day someone remembers this regex.
test("every shipped agent that has a shell is inside tree-guard", () => {
  const agentDir = path.join(path.dirname(GUARD), "../agents");
  // `grants` counts an agent that states no `tools:` as holding a shell,
  // because it holds every tool the lead does. The inline parser this replaced
  // read that file as tool-less and left it out of this list entirely.
  const withShell = readdirSync(agentDir).filter((file) => file.endsWith(".md"))
    .filter((file) => grants(agentDefinition(path.join(agentDir, file)), "Bash"));
  assert.ok(withShell.length > 0, "no agent has a shell — this test has stopped testing anything");
  for (const file of withShell) {
    const type = `self-review:${file.replace(/\.md$/, "")}`;
    assert.ok(denied("git stash", { agent_type: type }),
      `${file} carries Bash and is outside tree-guard: its shell can reach git`);
  }
});
