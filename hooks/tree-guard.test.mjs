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

// Measured 2026-09-03, on the installed plugin, by logging the hook's real
// PreToolUse payload: spawning a subagent WITH A NAME replaces `agent_type`
// with that name. A finder launched as `r1-ab` arrives here as
// `{agent_id: "ar1-ab-579bcafc7cb1ce5c", agent_type: "r1-ab"}`, and `agent_id`
// carries the name too, so the payload holds no second source of truth. The
// guard was therefore inert for roughly ninety finders — each with a shell in
// the author's tree — while every review round read this file and correctly
// found it correct. The code matched its intent; the intent did not match the
// harness.
//
// The fix is that the plugin names its own agents, and the name leads with the
// type (`tier.mjs`). So this regex must match both spellings, and the test that
// matters is the one below binding it to the string tier.mjs actually emits.
// F10h.
test("both spellings of a reviewer are guarded: the registered type and the generated name", () => {
  const registered = { agent_id: "a70e82d2662144940", agent_type: "self-review:self-review-finder" };
  const generated = { agent_id: "aself-review-finder-r1-ab-579bcafc", agent_type: "self-review-finder-r1-ab" };
  for (const [what, over] of [["the unnamed spawn", registered], ["the generated name", generated]]) {
    assert.ok(denied("git stash", over), `${what}: a reviewer's shell reaches git`);
    assert.ok(denied("git checkout -- scripts/x.mjs", over),
      `${what}: this is the exact verb from the field report that destroyed uncommitted work`);
    assert.ok(!denied("git status", over), `${what}: a reviewer may still read`);
  }
  assert.ok(denied("git stash", { agent_type: "self-review-cold-grader-r1-x" }));
  assert.ok(denied("git stash", { agent_type: "self-review-verifier-r1-v" }));
});

// Stated rather than hidden: an off-convention name is NOT guarded, and that is
// the accepted fail-open. The plugin generates every name it is responsible for
// — the test below is what keeps that true — and a PreToolUse hook that holds a
// turn hostage over an unrecognised string is the worse failure. The day agent
// names are chosen outside this plugin, this line becomes the finding.
test("a name that does not lead with the agent's type is not recognised as a reviewer", () => {
  assert.ok(!denied("git stash", { agent_type: "r9-nametest" }),
    "documenting the hole the fix leaves, so nobody discovers it by accident twice");
});

// The seam. TWO generators choose finder names — `tier.mjs` for a normal
// round and `brief.mjs`'s buildPlan for the `--tier` fallback the skill
// reaches for when tier.mjs fails — and this regex reads both, in files
// edited for unrelated reasons. That is the shape that already produced this
// defect once. So the assertion is not on a literal: it runs each real
// generator and feeds its real output to the real guard. Rename the rows in
// either without touching the regex and this fails here, not in the author's
// working tree three days later. The fallback generator is the one that
// matters most: it runs precisely when the normal path is broken, which is
// when nobody is looking at names.
test("every name tier.mjs generates is a name tree-guard recognises", async () => {
  const { buildFinders } = await import("../scripts/tier.mjs");
  const { loadConfig } = await import("./lib/config.mjs");
  const full = loadConfig();
  const config = { ...full.tier, impactDepths: full.impact };
  const kinds = { code: ["cli.mjs"], docs: ["README.md"], config: ["app.json"],
    instructional: [], executable: ["cli.mjs"], asset: [], ignored: [] };
  const seen = [];
  for (const tier of ["S", "M", "L"]) {
    for (const round of [1, 2, 3]) {
      const { finders } = buildFinders({
        tier, round, kinds,
        markers: { security: ["cli.mjs"], auth: [], concurrency: ["cli.mjs"] },
        config, impactConfig: full.impact, compact: false,
      });
      for (const row of finders) {
        seen.push(row.name);
        assert.ok(denied("git stash", { agent_id: `a${row.name}-deadbeef`, agent_type: row.name }),
          `tier.mjs generates the name "${row.name}", which tree-guard does not recognise as a reviewer — that agent gets an unguarded shell in the author's tree`);
      }
    }
  }
  assert.ok(seen.length >= 6, `the generator produced almost nothing (${seen.length} rows) — this test has stopped testing anything`);
});

test("every name brief.mjs's fallback plan generates is a name tree-guard recognises", async () => {
  const { buildPlan } = await import("../scripts/brief.mjs");
  const seen = [];
  for (const tier of ["S", "M", "L"]) {
    for (const round of [1, 2, 3]) {
      for (const row of buildPlan(tier, round).finders) {
        seen.push(row.name);
        assert.ok(denied("git stash", { agent_id: `a${row.name}-deadbeef`, agent_type: row.name }),
          `brief.mjs --tier ${tier} generates the name "${row.name}", which tree-guard does not recognise as a reviewer — that agent gets an unguarded shell in the author's tree`);
      }
    }
  }
  assert.ok(seen.length >= 6, `the fallback generator produced almost nothing (${seen.length} rows) — this test has stopped testing anything`);
});

// Depth is NOT the variable — measured in the same run. A depth-2 finder's
// payload carries every key a depth-1 one does; it read as unguarded only
// because its parent had named it off-convention.
test("depth 2 is not a hole; a name is", () => {
  assert.ok(denied("git stash",
    { agent_id: "aself-review-finder-r2-cef-11c485", agent_type: "self-review-finder-r2-cef" }),
    "a depth-2 finder the plugin named is guarded exactly like a depth-1 one");
});

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
  assert.ok(denied(`bash -c "git clean -fd"`), "the git rule reads command position the same way");
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
  assert.equal(offence(`bash -c 'git reset --hard'`, 4), null, "at the cap it stops unwrapping");
});

test("a backslash does not hide the command name from the guard", () => {
  // `words()` already stripped ONE escaping mechanism and not the other, so
  // `g"it"` was caught and `g\\it` walked straight through — a reviewer could
  // revert the author's uncommitted work past the guard whose only job is to
  // stop exactly that. Bash's top-level rule is the same for both: drop the
  // backslash, take the next character literally.
  assert.ok(denied("g\\it checkout -- ."), "the reported bypass");
  assert.ok(denied("\\git reset --hard"), "the idiom that skips an alias is still git");
  // Not `git re\\set --hard`: an unrecognised verb is denied anyway, so that
  // assertion stays green with the stripping reverted and tests nothing. The
  // direction that flips is a READING verb, which is only allowed once the
  // backslash is gone — unstripped, `st\\atus` is not a verb this rule knows.
  assert.equal(denied("git st\\atus"), false, "an escaped reading verb is still readable");
  assert.ok(denied('g"it" checkout -- .'), "quotes were always stripped; this is the pair");
  assert.equal(denied("g\\it status"), false, "normalising does not make a reading verb a write");
});

test("a line continuation is not a command separator", () => {
  // Splitting on the raw newline left the verb alone in one segment and its
  // flags and operand in the next, so neither segment alone tripped anything.
  // Wrapping a long command across two lines is ordinary style, not evasion.
  assert.ok(denied("git\\\n reset --hard"), "the verb and its flags rejoin");
  assert.ok(denied("git \\\ncheckout -- ."));
  assert.equal(denied("git \\\nstatus"), false, "rejoining does not over-deny");
  assert.equal(denied("echo one\ntwo"), false, "a bare newline still separates");
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
  assert.equal(offence("node --test x.test.mjs"), null);
});

test("run as the harness runs it, it denies on stdin and fails open on nonsense", () => {
  const hook = (payload, env = {}) =>
    spawnSync("node", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });

  const deny = hook({ ...FINDER, tool_input: { command: "git checkout -- x" } });
  assert.equal(deny.status, 0, "a hook must never hold a turn hostage");
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");

  assert.equal(hook({ ...FINDER, tool_input: { command: "git log" } }).stdout, "");
  // The generated spelling, through the real process. Every other generated-name
  // assertion calls evaluate() in-process and every other subprocess assertion
  // uses the unnamed type, so without this line the two halves of the fix are
  // each tested and their composition is not — and the composition is what the
  // harness actually runs.
  const named = hook({ agent_id: "aself-review-finder-r1-ab-deadbeef", agent_type: "self-review-finder-r1-ab",
    tool_name: "Bash", tool_input: { command: "git stash" } });
  assert.equal(named.status, 0, "a hook must never hold a turn hostage");
  assert.equal(JSON.parse(named.stdout).hookSpecificOutput.permissionDecision, "deny",
    "the name tier.mjs generates, denied through stdin exactly as the harness delivers it");
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

test("the rm rule is deliberately gone, and this is what keeps it gone", () => {
  // Six patches in one day, three of them repairing the previous patch, and the
  // round after the sixth still found `nice rm -rf build` plus every other
  // wrapper word nobody enumerated. Counted rather than argued: across every
  // transcript on the machine the rule had saved zero lines of uncommitted work
  // and denied three legitimate reviewer actions. A prose freeze did not hold —
  // it was overridden six times by rounds that each felt like the exception —
  // so the decision is a test now. If you are here because you want the rm rule
  // back, the thing to bring is a treecheck line from a real round naming work
  // a reviewer's `rm` destroyed that the snapshot could not restore. Today that
  // count is zero, and until it isn't, this guard does not model `rm` at all.
  for (const command of ["rm -rf .", "rm -rf /repo/build", "rm -rf ..",
    "nice rm -rf build", "rm -rf -", "rm -rf . --", "\\rm -rf ."]) {
    assert.equal(denied(command, { cwd: "/repo" }), false, command);
  }
  assert.equal(offence("rm -rf ."), null, "offence() has no rm opinion left");
});
