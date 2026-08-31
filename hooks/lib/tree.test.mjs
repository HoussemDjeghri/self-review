// Run: node --test plugin/hooks/lib/tree.test.mjs   (or ./test.sh for everything)
//
// The walk exists because four hand-kept directory lists went stale silently.
// These tests are about the two properties that made it worth replacing them:
// depth (a new subdirectory is covered without anyone editing anything) and
// pruning (the fixture corpora and tooling state stay out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkFiles } from "./tree.mjs";

const tree = (spec) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tree-"));
  for (const [rel, body] of Object.entries(spec)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
};

test("a file any number of levels down is found, which is the whole point", () => {
  const root = tree({ "top.sh": "", "a/one.mjs": "", "a/b/c/deep.mjs": "" });
  try {
    assert.deepEqual(walkFiles(root), ["a/b/c/deep.mjs", "a/one.mjs", "top.sh"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dot directories, node_modules and evals/corpora are pruned", () => {
  const root = tree({
    "keep.md": "",
    ".git/config": "",
    ".claude/RESUME.md": "",
    "node_modules/pkg/index.mjs": "",
    "evals/corpora/js-cli/base/test/render.test.mjs": "",
    "evals/run.test.mjs": "",
  });
  try {
    assert.deepEqual(walkFiles(root), ["evals/run.test.mjs", "keep.md"],
      "a fixture repository's tests must never join the suite that reviews it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corpora is pruned by its path, not its name", () => {
  const root = tree({ "corpora/mine.mjs": "", "evals/corpora/theirs.mjs": "" });
  try {
    assert.deepEqual(walkFiles(root), ["corpora/mine.mjs"], "only evals/corpora is fixtures");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symlink is neither followed nor returned", () => {
  const root = tree({ "real/file.mjs": "" });
  try {
    symlinkSync(path.join(root, "real"), path.join(root, "loop"));
    assert.deepEqual(walkFiles(root), ["real/file.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
