// Run: node --test plugin/scripts/treecheck.test.mjs   (or ./test.sh for everything)
// F5's belt. A read-only finder ran the writer it was reviewing against the
// real repository, then `git checkout -- <files>` to undo it — and the undo's
// blast radius is every uncommitted change to those files, which is exactly
// the author's unsaved work. Prevention needs the reviewer to obey prose;
// detection does not, and it turns a silent loss into a named one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), "treecheck.sh");
const run = (cwd, ...args) => spawnSync("bash", [CHECK, ...args], { cwd, encoding: "utf8" });

/** A repo with one committed file and one uncommitted edit — the author's work. */
function fixture({ prefix = "treecheck-" } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  writeFileSync(path.join(repo, "src.mjs"), "export const one = 1;\n");
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(path.join(repo, "src.mjs"), "export const one = 2;\n");

  const work = path.join(mkdtempSync(path.join(tmpdir(), "treecheck-work-")), "sr");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  return { repo, work, git };
}

test("a round that ends the way it started reports nothing", () => {
  const { repo, work } = fixture();
  assert.equal(run(repo, "--work", work, "--round", "1", "--record").status, 0);
  assert.match(readFileSync(path.join(work, "round-1", "tree-before.txt"), "utf8"), /src\.mjs/);

  const clean = run(repo, "--work", work, "--round", "1");
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "", "silence is the whole point: every printed line costs the lead a turn");
});

test("a reviewer's undo of the author's uncommitted work is named", () => {
  const { repo, work, git } = fixture();
  run(repo, "--work", work, "--round", "1", "--record");
  git("checkout", "--", "src.mjs");   // the exact command from the field report

  const changed = run(repo, "--work", work, "--round", "1");
  assert.equal(changed.status, 0, "a detector that breaks the chain it runs in gets removed");
  assert.match(changed.stdout, /^treecheck\.sh: the working tree changed while reviewers ran — src\.mjs; a reviewer wrote or reverted something\. Put it back with: git -C .* restore --source=refs\/self-review\/[0-9a-f]{8}\/round-1 -- \.$/m);
});

test("the author's uncommitted work survives the undo, because the ref holds it", () => {
  const { repo, work, git } = fixture();
  writeFileSync(path.join(repo, "new.txt"), "untracked but not ignored\n");
  writeFileSync(path.join(repo, ".gitignore"), "secret.env\n");
  writeFileSync(path.join(repo, "secret.env"), "TOKEN=1\n");
  run(repo, "--work", work, "--round", "1", "--record");

  git("checkout", "--", "src.mjs");        // the edit, reverted
  spawnSync("rm", [path.join(repo, "new.txt")]);   // the untracked file, deleted

  const changed = run(repo, "--work", work, "--round", "1");
  const restore = changed.stdout.match(/git -C \S+ restore --source=(\S+) -- \./);
  assert.ok(restore, `no restore command in: ${changed.stdout}`);
  assert.equal(git("restore", `--source=${restore[1]}`, "--", ".").status, 0);

  assert.equal(readFileSync(path.join(repo, "src.mjs"), "utf8"), "export const one = 2;\n",
    "the author's uncommitted edit is back");
  assert.equal(readFileSync(path.join(repo, "new.txt"), "utf8"), "untracked but not ignored\n",
    "untracked non-ignored files are in the snapshot too — git stash create would have dropped this one");
  // Documented limit, pinned so it is read as a cost rather than re-filed:
  // ignored files are not saved, which is why the restore cannot bring back a
  // deleted `.env` or node_modules.
  assert.equal(spawnSync("git", ["ls-tree", "--name-only", restore[1], "--", "secret.env"],
    { cwd: repo, encoding: "utf8" }).stdout, "");
});

test("the snapshot ref is per review and per round, and old ones are pruned", () => {
  const { repo, work } = fixture();
  run(repo, "--work", work, "--round", "1", "--record");
  mkdirSync(path.join(work, "round-2"), { recursive: true });
  run(repo, "--work", work, "--round", "2", "--record");

  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/self-review/"],
    { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n");
  assert.equal(refs.length, 2, refs.join(" "));
  assert.ok(refs.every((ref) => /^refs\/self-review\/[0-9a-f]{8}\/round-[12]$/.test(ref)), refs.join(" "));

  // A week-old snapshot is pruned by the next round's record. The commit is
  // dated by hand because the prune reads committerdate, not the ref's age.
  const stale = spawnSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "old"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } }).stdout.trim();
  spawnSync("git", ["update-ref", "refs/self-review/deadbeef/round-1", stale], { cwd: repo });
  mkdirSync(path.join(work, "round-3"), { recursive: true });
  run(repo, "--work", work, "--round", "3", "--record");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/self-review/deadbeef/round-1"],
    { cwd: repo }).status, 1, "a snapshot older than a week is pruned");
});

test("a file a reviewer wrote is named too, and so is a stash", () => {
  const { repo, work, git } = fixture();
  run(repo, "--work", work, "--round", "1", "--record");
  writeFileSync(path.join(repo, "probe-output.txt"), "a writer under review wrote here\n");
  const wrote = run(repo, "--work", work, "--round", "1");
  assert.match(wrote.stdout, /probe-output\.txt/);

  git("stash", "push", "-q", "-u", "-m", "a reviewer tidying up");
  const stashed = run(repo, "--work", work, "--round", "1");
  assert.match(stashed.stdout, /the working tree changed while reviewers ran/);
  assert.match(stashed.stdout, /git stash list/, "a stash hides the change instead of deleting it, and reads as clean without this");
});

test("a path beginning with # is named, not silently dropped", () => {
  // The filter that removes snapshot()'s own `#` line used to remove any path
  // that started with one, so the message reported a change it could not name.
  const { repo, work } = fixture();
  run(repo, "--work", work, "--round", "1", "--record");
  writeFileSync(path.join(repo, "#notes.txt"), "a reviewer's scratch, in the repo\n");
  const wrote = run(repo, "--work", work, "--round", "1");
  assert.match(wrote.stdout, /— #notes\.txt; a reviewer wrote/, wrote.stdout);
});

test("a second --record keeps the first snapshot: re-running a round must not erase its evidence", () => {
  // Re-running a round is a real recovery path (a pre-flight failure fixed,
  // the scope re-captured). A re-record made the post-damage tree the baseline,
  // so a reviewer's write from the first attempt became invisible.
  const { repo, work, git } = fixture();
  run(repo, "--work", work, "--round", "1", "--record");
  git("checkout", "--", "src.mjs");   // a reviewer of the first attempt undoes the author's work

  const again = run(repo, "--work", work, "--round", "1", "--record");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /keeping round 1's original tree-before\.txt/, "it says so rather than doing it quietly");

  const changed = run(repo, "--work", work, "--round", "1");
  assert.match(changed.stdout, /src\.mjs/, "the undo is still detected against the true baseline");

  // And the ref is not re-written either: restoring from it has to bring back
  // the author's edit, not the reviewer's undo of it.
  const restore = changed.stdout.match(/git -C \S+ restore --source=(\S+) -- \./);
  assert.ok(restore, changed.stdout);
  assert.equal(git("restore", `--source=${restore[1]}`, "--", ".").status, 0);
  assert.equal(readFileSync(path.join(repo, "src.mjs"), "utf8"), "export const one = 2;\n");
});

test("a snapshot that failed is retried by the next --record for the same round", () => {
  // The witness is write-once and the ref is write-if-absent: opposite
  // idempotency, so the retry that recovers one must not clobber the other.
  const { repo, work, git } = fixture();
  const objects = path.join(repo, ".git", "objects");
  chmodSync(objects, 0o555);
  const failed = run(repo, "--work", work, "--round", "1", "--record");
  chmodSync(objects, 0o755);
  assert.match(failed.stderr, /could not save the working tree/);

  const retried = run(repo, "--work", work, "--round", "1", "--record");
  assert.equal(retried.status, 0);
  assert.match(retried.stdout, /keeping round 1's original tree-before\.txt/);
  assert.equal(retried.stderr, "", "the retry succeeded, so it says nothing");

  git("checkout", "--", "src.mjs");
  const changed = run(repo, "--work", work, "--round", "1");
  const restore = changed.stdout.match(/git -C \S+ restore --source=(\S+) -- \./);
  assert.ok(restore, `the retry's ref should be there to offer: ${changed.stdout}`);
  assert.equal(git("restore", `--source=${restore[1]}`, "--", ".").status, 0);
  assert.equal(readFileSync(path.join(repo, "src.mjs"), "utf8"), "export const one = 2;\n");
});

test("no recorded snapshot is said out loud, not passed as clean", () => {
  const { repo, work } = fixture();
  const missing = run(repo, "--work", work, "--round", "1");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^treecheck\.sh: no tree-before\.txt for round 1/);
});

test("outside a git repository it records that fact and stays quiet", () => {
  const plain = mkdtempSync(path.join(tmpdir(), "treecheck-plain-"));
  const work = path.join(mkdtempSync(path.join(tmpdir(), "treecheck-work-")), "sr");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  assert.equal(run(plain, "--work", work, "--round", "1", "--record").status, 0);
  const check = run(plain, "--work", work, "--round", "1");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, "");
});

test("usage errors name the flag", () => {
  const { repo, work } = fixture();
  assert.equal(run(repo, "--work", work).status, 2);
  assert.match(run(repo, "--round", "1").stderr, /--work is required/);
  assert.match(run(repo, "--work", work, "--round", "x").stderr, /--round needs a positive integer/);
});

test("the snapshot is of --root's repository, not of wherever the script was invoked", () => {
  // round.sh resolves the repo with `git rev-parse --show-toplevel` and passes
  // it as --root without ever cd'ing there, so this is the calling convention
  // the loop actually uses — and the one every other test here misses.
  const { repo, work } = fixture();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "treecheck-elsewhere-"));

  const recorded = run(elsewhere, "--work", work, "--round", "1", "--root", repo, "--record");
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.stderr, "", "a snapshot that could not be taken is the failure this test exists for");
  assert.match(spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/self-review/"],
    { cwd: repo, encoding: "utf8" }).stdout, /^refs\/self-review\/[0-9a-f]{8}\/round-1$/m);
});

test("a repository with no commits yet still gets its untracked work snapshotted", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "treecheck-unborn-"));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "draft.txt"), "an hour of work, never committed\n");
  const work = path.join(mkdtempSync(path.join(tmpdir(), "treecheck-work-")), "sr");
  mkdirSync(path.join(work, "round-1"), { recursive: true });

  const recorded = run(repo, "--work", work, "--round", "1", "--record");
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.stderr, "");
  const ref = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/self-review/"],
    { cwd: repo, encoding: "utf8" }).stdout.trim();
  assert.match(ref, /^refs\/self-review\/[0-9a-f]{8}\/round-1$/);
  assert.equal(spawnSync("git", ["ls-tree", "--name-only", ref, "--", "draft.txt"],
    { cwd: repo, encoding: "utf8" }).stdout, "draft.txt\n");
});

test("the printed restore command runs verbatim, including from a path with a space", () => {
  // The offer is only worth making if pasting it works: the message is prose a
  // person copies, not an argv the caller re-splits.
  const { repo, work, git } = fixture({ prefix: "treecheck dir with space-" });
  run(repo, "--work", work, "--round", "1", "--record");
  git("checkout", "--", "src.mjs");

  const changed = run(repo, "--work", work, "--round", "1");
  const command = changed.stdout.match(/Put it back with: (.*?) *$/m)?.[1];
  assert.ok(command, `no restore command in: ${changed.stdout}`);
  const restored = spawnSync("bash", ["-c", command], { cwd: repo, encoding: "utf8" });
  assert.equal(restored.status, 0, `${command}\n${restored.stderr}`);
  assert.equal(readFileSync(path.join(repo, "src.mjs"), "utf8"), "export const one = 2;\n");
});

test("a snapshot that cannot be taken warns and lets the round start anyway", () => {
  // Best-effort is a promise with two halves, and the loud half is the one a
  // silent regression would drop.
  const { repo, work } = fixture();
  const objects = path.join(repo, ".git", "objects");
  chmodSync(objects, 0o555);
  try {
    const recorded = run(repo, "--work", work, "--round", "1", "--record");
    assert.equal(recorded.status, 0, "a round still starts without its snapshot");
    assert.match(recorded.stderr, /could not save the working tree to a snapshot ref/);
    assert.equal(spawnSync("git", ["for-each-ref", "refs/self-review/"],
      { cwd: repo, encoding: "utf8" }).stdout, "");
    // The copied index is a full copy of .git/index; a failure must not leave
    // one behind in the round's work dir.
    assert.equal(existsSync(path.join(work, "round-1", "snapshot-index")), false);
  } finally {
    chmodSync(objects, 0o755);
  }
});
