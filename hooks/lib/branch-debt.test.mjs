import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEWED_NS, branchOf, mainOf, smallestDebt, mainCovered, setDeadline, topOf, treeOf, pruneReviewed, reviewSnapshot, reviewedRefs, riskPathTest, writeReviewed } from "./branch-debt.mjs";
import { repoId } from "./repo-id.mjs";

const TREECHECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "treecheck.sh");
const OLD = "1600000000 +0000"; // 2020: older than any prune window

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bdl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const top = path.join(dir, "r");
  spawnSync("git", ["init", "-q", "-b", "main", top]);
  const git = (args, env = {}) => spawnSync("git", ["-C", top, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  writeFileSync(path.join(top, "a.ts"), "export const a = 1;\n");
  git(["add", "-A"]); git(["commit", "-qm", "base"], { GIT_COMMITTER_DATE: OLD, GIT_AUTHOR_DATE: OLD });
  const sha = (rev) => git(["rev-parse", rev]).stdout.trim();
  return { dir, top, git, sha };
}

test("pruneReviewed: never main's ref, even with no local main; an old ref of a gone branch, yes", (t) => {
  const { top, git, sha } = repo(t);
  const old = sha("HEAD");
  git(["update-ref", `${REVIEWED_NS}main`, old]);
  git(["update-ref", `${REVIEWED_NS}gone`, old]);
  git(["checkout", "-q", "--detach"]); git(["branch", "-D", "main"]);
  pruneReviewed(top, reviewedRefs(top), "main");
  assert.deepEqual(reviewedRefs(top).map((r) => r.branch), ["main"]);
});

test("writeReviewed: a leftover nested ref of a gone branch does not block the write", (t) => {
  const { top, git, sha } = repo(t);
  git(["update-ref", `${REVIEWED_NS}feat/x`, sha("HEAD")]);
  assert.equal(writeReviewed(top, "feat", sha("HEAD")), true);
  assert.deepEqual(reviewedRefs(top).map((r) => r.branch), ["feat"]);
  // A live branch's ref is never removed to make room.
  git(["update-ref", "-d", `${REVIEWED_NS}feat`]);
  git(["branch", "feat/y"]); git(["update-ref", `${REVIEWED_NS}feat/y`, sha("HEAD")]);
  assert.equal(writeReviewed(top, "feat", sha("HEAD")), false);
  assert.deepEqual(reviewedRefs(top).map((r) => r.branch), ["feat/y"]);
});

test("mainCovered: a branch review's snapshot sitting on main's HEAD does not cover main", (t) => {
  const { top, git, sha } = repo(t);
  const head = sha("HEAD");
  const tree = git(["write-tree"]).stdout.trim();
  writeFileSync(path.join(top, "b.ts"), "export const b = 1;\n");
  const snap = git(["commit-tree", tree, "-p", head, "-m", "self-review round 1 snapshot"]).stdout.trim();
  git(["update-ref", `${REVIEWED_NS}tmp`, snap]);
  git(["update-ref", `${REVIEWED_NS}main`, head]);
  writeFileSync(path.join(top, "c.ts"), "export const c = 1;\n");
  git(["add", "c.ts"]); git(["commit", "-qm", "unreviewed"]);
  const refs = reviewedRefs(top).map((r) => (r.branch === "tmp" ? { ...r, parent: sha("HEAD") } : r));
  assert.equal(mainCovered(top, refs, "main", sha("HEAD")), false, "another branch's snapshot does not count");
  const own = refs.map((r) => (r.branch === "main" ? { ...r, snapshot: true, parent: sha("HEAD") } : r));
  assert.equal(mainCovered(top, own, "main", sha("HEAD")), true, "main's own review of uncommitted work does");
});

test("riskPathTest: every category, case-insensitive, and an uncompilable pattern matches as text", () => {
  const risky = riskPathTest({ infra: ["\\.github/workflows"], protected: ["^src/Core/"], odd: ["(unclosed"] });
  assert.equal(risky(".github/workflows/ci.yml"), true);
  assert.equal(risky("src/core/x.ts"), true);
  assert.equal(risky("lib/(unclosed.ts"), true);
  assert.equal(risky("src/x.ts"), false);
  assert.equal(riskPathTest({})("anything"), false);
});

test("treecheck.sh --record writes what reviewSnapshot reads, under the id round.sh prints", (t) => {
  const { dir, top, git, sha } = repo(t);
  writeFileSync(path.join(top, "b.ts"), "export const b = 1;\n");
  const work = path.join(dir, "work");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  const id = spawnSync("sh", ["-c", `printf '%s' "$1" | git hash-object --stdin | cut -c1-8`, "sh", work], { encoding: "utf8" }).stdout.trim();
  const rec = (round, ...flags) => spawnSync("bash", [TREECHECK, "--work", work, "--round", String(round), "--root", top, ...flags, "--record"], { encoding: "utf8" });
  assert.equal(rec(1, "--base", sha("HEAD")).status, 0);
  let snap = reviewSnapshot(top, id);
  assert.ok(snap, `no snapshot under refs/self-review/${id}/`);
  assert.equal(snap.base, sha("HEAD"));
  assert.equal(snap.partial, false);
  assert.equal(git(["rev-parse", `${snap.commit}^`]).stdout.trim(), sha("HEAD"));
  assert.match(git(["ls-tree", "--name-only", snap.tree]).stdout, /b\.ts/, "untracked work is in the snapshot");
  mkdirSync(path.join(work, "round-2"), { recursive: true });
  assert.equal(rec(2, "--base", sha("HEAD"), "--partial").status, 0);
  snap = reviewSnapshot(top, id);
  assert.equal(snap.round, 2);
  assert.equal(snap.partial, true);
});

test("repoId ignores a GIT_DIR naming another repository", (t) => {
  const a = repo(t);
  const b = repo(t);
  a.git(["remote", "add", "origin", "https://example.test/a.git"]);
  b.git(["remote", "add", "origin", "https://example.test/b.git"]);
  const own = repoId(a.top);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(b.top, ".git");
  try { assert.equal(repoId(a.top), own); } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
});

test("the debt counts code the repository's .gitattributes marks binary or -diff", (t) => {
  const { top, git } = repo(t);
  const base = git(["write-tree"]).stdout.trim();
  writeFileSync(path.join(top, ".gitattributes"), "*.ts binary\n* -diff\n");
  writeFileSync(path.join(top, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  git(["add", "-A"]);
  const debt = smallestDebt(top, [{ commit: "x", tree: base, label: "base" }], git(["write-tree"]).stdout.trim(),
    { counts: (rel) => rel.endsWith(".ts"), risky: () => false });
  assert.equal(debt.lines, 3, "a.ts: one line deleted, two added");
});

test("past the deadline every git call answers null", (t) => {
  const { top } = repo(t);
  t.after(() => setDeadline(Infinity));
  assert.ok(topOf(top));
  setDeadline(Date.now() - 1);
  assert.equal(topOf(top), null);
  assert.equal(treeOf(top, "HEAD"), null);
});

test("branchOf / mainOf: a tag sharing the branch's name does not change the name", (t) => {
  const { top, git, sha } = repo(t);
  git(["update-ref", "refs/remotes/origin/main", sha("HEAD")]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["tag", "main"]); git(["tag", "origin/main"]);
  assert.equal(branchOf(top), "main");
  assert.equal(mainOf(top)?.local, "main");
  writeFileSync(path.join(top, "b.ts"), "export const b = 1;\n");
  git(["add", "-A"]); git(["commit", "-qm", "b"]);
  git(["update-ref", "refs/remotes/origin/main", sha("HEAD")]); // the tags now point one commit behind
  assert.equal(mainOf(top)?.ref, sha("HEAD"), "main's commit comes from the remote ref, not the tag");
  assert.equal(mainOf(top, "main")?.ref, sha("HEAD"), "an override names the branch, not the tag");
});
