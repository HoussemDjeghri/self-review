import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoId } from "../hooks/lib/repo-id.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "branch-debt.mjs");

function fixture(t, { optIn = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("remote", "add", "origin", "https://example.test/o/r.git");
  writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-qm", "base"); git("branch", "-M", "main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "-qb", "feat");
  const cfg = path.join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify(optIn ? { repos: { [repoId(repo)]: { branchDebt: { maxLines: 100 } } } } : {}));
  const cli = (...args) => spawnSync(process.execPath, [CLI, "--repo", repo, ...args], { encoding: "utf8", env: { ...process.env, SELF_REVIEW_CONFIG: cfg } });
  return { repo, git, cli };
}

test("branch-debt --id prints the id the user config keys the repository by", (t) => {
  const { repo, cli } = fixture(t);
  assert.equal(cli("--id").stdout, `${repoId(repo)}\n`);
});

test("branch-debt: status counts code from the merge base, names the base, and writes nothing", (t) => {
  const { repo, git, cli } = fixture(t);
  writeFileSync(path.join(repo, "b.ts"), "export const b = 1;\nexport const c = 2;\n");
  writeFileSync(path.join(repo, "notes.md"), "prose\nprose\n");
  const r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /opted in: yes, up to 100 lines/);
  assert.match(r.stdout, /debt: 2 code lines in 1 files, from merge-base with origin\/main/);
  assert.match(r.stdout, new RegExp(`--base ${git("rev-parse", "main").stdout.trim()}`));
  assert.equal(git("for-each-ref", "refs/self-review-reviewed/").stdout, "", "read-only: no adoption");
  assert.match(git("status", "--short").stdout, /\?\? b\.ts/, "the index is untouched");
});

test("branch-debt: a repository without an opt-in says how to add one", (t) => {
  const { cli } = fixture(t, { optIn: false });
  assert.match(cli().stdout, /opted in: no — add repos\.<id>\.branchDebt\.maxLines/);
});

test("branch-debt: an unknown flag is a usage error", (t) => {
  const { cli } = fixture(t);
  assert.equal(cli("--bogus").status, 2);
});

test("branch-debt: on main, a clean merge of reviewed trees reports no debt, as the gate does", (t) => {
  const { repo, git, cli } = fixture(t);
  writeFileSync(path.join(repo, "b.ts"), "export const b = 1;\n");
  git("add", "-A"); git("commit", "-qm", "b");
  git("update-ref", "refs/self-review-reviewed/feat", "HEAD");
  git("checkout", "-q", "main");
  writeFileSync(path.join(repo, "c.ts"), "export const c = 1;\n");
  git("add", "-A"); git("commit", "-qm", "c");
  git("update-ref", "refs/self-review-reviewed/main", "HEAD");
  git("merge", "-q", "--no-edit", "feat"); // each baseline alone is 1 line short of this head
  const r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /debt: 0 code lines/);
});
