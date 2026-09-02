// Run: node --test plugin/scripts/scope.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScope } from "./impact.mjs";

const SCOPE = path.join(path.dirname(fileURLToPath(import.meta.url)), "scope.sh");
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
const scope = (cwd, ...args) => spawnSync("bash", [SCOPE, ...args], { cwd, encoding: "utf8" }).stdout;
// git prints the resolved root (/private/var on macOS for a /var tmpdir), so match by suffix.
const sectionOf = (out, repoTail) => out.search(new RegExp(`^# repo: .*/${repoTail}$`, "m"));

// A non-repo directory holding one git repo (a skill tracked on its own) and a
// plain file beside it — the shape of ~/.claude after `git init skills/x`.
function layout() {
  const home = mkdtempSync(path.join(tmpdir(), "scope-"));
  const repo = path.join(home, "skills", "x");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "SKILL.md"), "one\ntwo\n");
  sh("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init", repo);
  writeFileSync(path.join(repo, "SKILL.md"), "one\nTWO\n");
  writeFileSync(path.join(repo, "new.md"), "fresh\n");
  writeFileSync(path.join(home, "CLAUDE.md"), "rules\n");
  return { home, repo };
}

// A second, independent repo beside the first, so grouping has two groups.
function secondRepo(home) {
  const repo = path.join(home, "skills", "y");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "Y.md"), "alpha\n");
  sh("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init", repo);
  writeFileSync(path.join(repo, "Y.md"), "ALPHA\n");
  return repo;
}

test("from a non-repo cwd, a path inside a repo is diffed against that repo, not printed in full", () => {
  const { home } = layout();
  const out = scope(home, "skills/x/SKILL.md");
  assert.match(out, /^# repo: .*skills\/x$/m);
  assert.match(out, /^-two$/m);
  assert.match(out, /^\+TWO$/m);
  assert.doesNotMatch(out, /^one$/m); // the unchanged line is not dumped
});

test("untracked files of that repo still render as full additions", () => {
  const { home } = layout();
  assert.match(scope(home, "skills/x/new.md"), /^\+fresh$/m);
});

test("paths outside any repo are printed in full after the repo sections", () => {
  const { home } = layout();
  const out = scope(home, "skills/x/SKILL.md", "CLAUDE.md");
  assert.match(out, /^\+TWO$/m);
  const plainAt = out.indexOf("==> CLAUDE.md <==");
  assert.ok(plainAt > out.indexOf("+TWO"));
  assert.match(out.slice(plainAt), /^rules$/m);
});

test("inside a repo the cwd still decides, with or without paths", () => {
  const { repo } = layout();
  assert.match(scope(repo), /^\+TWO$/m);
  assert.match(scope(repo, "SKILL.md"), /^\+TWO$/m);
});

test("paths in two different repos get one section each, grouped, not interleaved", () => {
  const { home } = layout();
  secondRepo(home);
  const out = scope(home, "skills/y/Y.md", "skills/x/SKILL.md");
  const x = sectionOf(out, "skills/x");
  const y = sectionOf(out, "skills/y");
  assert.ok(x >= 0 && y >= 0);
  assert.ok(out.indexOf("+TWO") > x && out.indexOf("+TWO") < y, "x's diff sits in x's section");
  assert.ok(out.indexOf("+ALPHA") > y, "y's diff sits in y's section");
});

test("a --base that is not a commit in one of the repos is reported in that section, not silently empty", () => {
  const { home, repo } = layout();
  secondRepo(home);
  const sha = sh("git rev-parse HEAD", repo).stdout.trim();
  const out = scope(home, "--base", sha, "skills/x/SKILL.md", "skills/y/Y.md");
  assert.match(out, /^\+TWO$/m); // the sha is valid in x
  const y = sectionOf(out, "skills/y");
  assert.match(out.slice(y), new RegExp(`# base ${sha} is not a commit in this repo`));
});

test("from a repo cwd, a path outside that repo is still printed, not silently dropped", () => {
  const { repo } = layout();
  const out = scope(repo, "SKILL.md", "../../CLAUDE.md");
  assert.match(out, /^\+TWO$/m);
  assert.match(out, /==> \.\.\/\.\.\/CLAUDE\.md <==/);
  assert.match(out, /^rules$/m);
});

test("a typo'd flag is refused, not scoped as a deleted file", () => {
  // It used to fall through to the path list and come back as
  // `==> --versoin <==` / `(missing — deleted this turn?)`, exit 0: an empty
  // scope that looks like a real one, which the round then measures.
  const { repo } = layout();
  const unknown = spawnSync("bash", [SCOPE, "--versoin"], { cwd: repo, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^scope\.sh: unknown option: --versoin/);
  assert.equal(unknown.stdout, "", "no scope at all beats a plausible empty one");
});

test("--work inside the repository under review is refused here, not only in round.sh", () => {
  // The guard used to live only in round.sh. SKILL.md keeps running these six
  // scripts by hand as a supported fallback, and scope.sh is the one that
  // actually walks `git status` — so guarding only the convenient path left the
  // documented path free to scope the round's own scope.diff, impact.json and
  // ledger.md, which is the regression the whole guard exists to stop.
  const { repo } = layout();
  const inside = spawnSync("bash", [SCOPE, "--work", path.join(repo, ".sr")], { cwd: repo, encoding: "utf8" });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /^scope\.sh: the work dir is inside the repository under review/);

  // Including one that does not exist yet: abs_path resolves through the
  // nearest existing ancestor precisely so this cannot slip past.
  const unborn = spawnSync("bash", [SCOPE, "--work", path.join(repo, "a", "b", "c")], { cwd: repo, encoding: "utf8" });
  assert.equal(unborn.status, 2);

  const outside = spawnSync("bash", [SCOPE, "--work", mkdtempSync(path.join(tmpdir(), "sr-work-"))], { cwd: repo, encoding: "utf8" });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stdout, /SKILL\.md/, "and the scope is still produced");
});

// --- F1: the changed-file list comes from the diff, not from `git status` ---
//
// The invariant, asserted exactly as the design note states it: for every file
// that appears in `## Diff vs <base>` or `## Untracked files`, one line names
// it in `## Changed files`. Before F1 the list came from `git status`, so a
// file committed this turn had real diff lines and no entry — and tier.mjs,
// round.sh and coldrun.sh all read the list, not the diff.
const diffFiles = (out) =>
  [...out.matchAll(/^diff --git a\/(?:.+) b\/(.+)$/gm)].map((m) => m[1]);
const listedFiles = (out) =>
  parseScope(out).repos.flatMap((r) => r.files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])));
function assertListCoversDiff(out) {
  const listed = new Set(listedFiles(out));
  for (const f of diffFiles(out)) assert.ok(listed.has(f), `${f} has diff lines but no ## Changed files entry`);
}

// A repo whose turn began at HEAD~1: one file committed, one edited but not
// committed, one renamed in the commit, one brand-new and untracked.
function mixedRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "scope-f1-"));
  const commit = (m) => sh(`git -c user.name=t -c user.email=t@t commit -q -m ${m}`, repo);
  writeFileSync(path.join(repo, "kept.mjs"), "a\nb\nc\n");
  writeFileSync(path.join(repo, "moved.mjs"), "one\ntwo\nthree\n");
  sh("git init -q -b main && git add -A", repo);
  commit("init");
  const base = sh("git rev-parse HEAD", repo).stdout.trim();
  sh("git mv moved.mjs renamed.mjs", repo);
  writeFileSync(path.join(repo, "renamed.mjs"), "one\ntwo\nTHREE\n");
  writeFileSync(path.join(repo, "added.mjs"), "brand new\n");
  sh("git add -A", repo);
  commit("turn");
  writeFileSync(path.join(repo, "kept.mjs"), "a\nb\nC\n");
  writeFileSync(path.join(repo, "untracked.mjs"), "never staged\n");
  return { repo, base };
}

test("F1: an uncommitted change is listed, as it always was", () => {
  const { repo } = layout();
  const out = scope(repo);
  assertListCoversDiff(out);
  assert.deepEqual(listedFiles(out).sort(), ["SKILL.md", "new.md"]);
});

test("F1: a change committed this turn is listed when --base predates it", () => {
  const { repo, base } = mixedRepo();
  const out = scope(repo, "--base", base);
  assertListCoversDiff(out);
  assert.ok(listedFiles(out).includes("added.mjs"), "a file added in this turn's commit");
});

test("F1: the mixed case — commit + unstaged edit + rename + untracked — is complete", () => {
  const { repo, base } = mixedRepo();
  const out = scope(repo, "--base", base);
  assertListCoversDiff(out);
  const listed = listedFiles(out);
  for (const f of ["added.mjs", "kept.mjs", "renamed.mjs", "moved.mjs", "untracked.mjs"]) {
    assert.ok(listed.includes(f), `${f} missing from ## Changed files`);
  }
  const files = parseScope(out).repos[0].files;
  const rename = files.find((f) => f.status === "R");
  assert.deepEqual({ from: rename.from, path: rename.path }, { from: "moved.mjs", path: "renamed.mjs" },
    "a rename stays one line, both halves intact");
  assert.equal(files.filter((f) => f.path === "untracked.mjs").length, 1, "one line per path");
});
