// Run: node --test plugin/scripts/lib/paths.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyPath, globToRegExp, isReviewPaperwork, isTestPath, matchesAnyGlob, matchesExclude, matchesGlob, reviewPaperworkRoot } from "./paths.mjs";

const EXEMPT = {
  extensions: [".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".env", ".lock", ".png", ".csv"],
  names: ["license", "readme", "changelog", ".gitignore", ".npmrc"],
};

test("the gate's exempt lists are split into prose, configuration and assets", () => {
  const kind = (file) => classifyPath(file, EXEMPT);
  assert.equal(kind("hooks/x.mjs"), "code");
  assert.equal(kind("Makefile"), "code", "a file the gate would review is code, whatever its name");
  assert.equal(kind("docs/DESIGN.md"), "docs");
  assert.equal(kind("LICENSE"), "docs");
  assert.equal(kind(".gitignore"), "config");
  assert.equal(kind("config/defaults.json"), "config");
  assert.equal(kind("data/rows.csv"), "config", "an exempt extension that is neither prose nor an asset is configuration");
  assert.equal(kind("docs/logo.png"), "asset");
  assert.equal(kind(".github/workflows/ci.yml"), "config");
  assert.equal(kind("Dockerfile"), "config", "no extension, still configuration");
  assert.equal(kind("infra/main.tf"), "config");
  assert.equal(kind("deploy/k8s/pod.yaml"), "config", "IaC directories are configuration wherever a monorepo puts them");
});

test("test files are recognised by path, in every ecosystem the angles mention", () => {
  for (const file of ["hooks/x.test.mjs", "tests/thing.py", "spec/models/user_spec.rb", "src/__tests__/a.tsx", "pkg/server_test.go", "test/e2e.js"]) {
    assert.ok(isTestPath(file), file);
  }
  for (const file of ["src/latest.mjs", "docs/contest.md", "src/protest/index.ts"]) {
    assert.ok(!isTestPath(file), file);
  }
});

test("globs: a pattern with no slash matches the basename, ** spans directories", () => {
  assert.ok(matchesGlob("*.min.*", "static/app.min.js"));
  assert.ok(matchesGlob("RUNBOOK*", "ops/RUNBOOK.md"));
  assert.ok(matchesGlob("agents/**/*.md", "agents/self-review-finder.md"), "** matches zero directories too");
  assert.ok(matchesGlob("agents/**/*.md", "agents/nested/deep/x.md"));
  assert.ok(!matchesGlob("agents/**/*.md", "other/agents/x.md"), "a pattern with a slash is anchored at the repo root");
  assert.ok(matchesGlob("dist/**", "dist/a/b.js"));
  assert.ok(!matchesGlob("dist/**", "dist"));
  assert.ok(!matchesGlob("*.md", "docs/a/b.md") === false, "a bare glob still only matches one segment of the basename");
  assert.ok(matchesAnyGlob(["a/**", "*.snap"], "src/x.snap"));
  assert.equal(globToRegExp("a.b").test("axb"), false, "a dot is a dot, not any character");
});

test("exclusions: a bare name excludes that directory at any depth, a glob stays a glob", () => {
  const patterns = ["node_modules", ".git", "*.min.*", "dist/**"];
  assert.ok(matchesExclude(patterns, "node_modules/dep/index.js"));
  assert.ok(matchesExclude(patterns, "packages/app/node_modules/dep/index.js"), "the nested copy is the common one");
  assert.ok(matchesExclude(patterns, "static/app.min.js"));
  assert.ok(!matchesExclude(patterns, "src/node_modules_helper.js"), "a segment, not a substring");
  assert.ok(!matchesExclude(patterns, "src/lib/thing.mjs"));
});

// --- F2: a self-review work dir is recognised by its contents ---------------
//
// The reporter's dir was `scratchpad/self-review/`, and users rename — so the
// signature is content, never name. The counter-examples matter as much as the
// matches: a false positive here silently drops a real change from review.
const tree = (spec) => {
  const root = mkdtempSync(path.join(tmpdir(), "paperwork-"));
  for (const [file, body] of Object.entries(spec)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
};

test("F2: a work dir is intent.md plus a round-*/ child, whatever it is called", () => {
  const root = tree({ "notes/intent.md": "x", "notes/round-1/tier.json": "{}" });
  assert.equal(isReviewPaperwork(path.join(root, "notes")), true);
  assert.equal(isReviewPaperwork(path.join(root, "notes", "round-1")), false,
    "round-1 here holds no scope.diff, so it matches on its own only via its parent");
});

test("F2: a round-*/ dir is paperwork when it holds both scope.diff and tier.json", () => {
  const root = tree({ "r/round-3/scope.diff": "x", "r/round-3/tier.json": "{}" });
  assert.equal(isReviewPaperwork(path.join(root, "r", "round-3")), true);
  assert.equal(isReviewPaperwork(path.join(root, "r")), false);
});

test("F2: the shapes that must NOT match, because a false refusal drops a real change", () => {
  const halves = tree({
    "a/intent.md": "a design intent doc, in a real project",
    "b/round-1/scope.diff": "one half of the signature",
    "c/impact.json": "a plausible real file", "c/state/x": "so is a state dir",
    "d/round-1/tier.json": "the other half",
  });
  for (const dir of ["a", "b", "b/round-1", "c", "d", "d/round-1"]) {
    assert.equal(isReviewPaperwork(path.join(halves, dir)), false, `${dir} is not paperwork`);
  }
  assert.equal(isReviewPaperwork(path.join(halves, "nope")), false, "a path that does not exist");
});

test("F2: the paperwork root of a path is the outermost match — what a user removes", () => {
  const root = tree({
    "scratch/sr/intent.md": "x", "scratch/sr/round-1/scope.diff": "d", "scratch/sr/round-1/tier.json": "{}",
    "src/app.mjs": "real code",
  });
  assert.equal(reviewPaperworkRoot(root, "scratch/sr/round-1/briefs/q.md"), "scratch/sr");
  assert.equal(reviewPaperworkRoot(root, "scratch/sr/ledger.md"), "scratch/sr");
  assert.equal(reviewPaperworkRoot(root, "src/app.mjs"), null);
  assert.equal(reviewPaperworkRoot(root, "scratch"), null, "the dir itself is not under paperwork");
});
