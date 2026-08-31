// Run: node --test plugin/scripts/lib/diff.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedLineCounts, parseDiff } from "./diff.mjs";

const DIFF = `
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +10,7 @@ export function outer() {
 context
-const gone = 1;
+const kept = 2;
+const extra = 3;
 more context
\\ No newline at end of file
diff --git a/dev/null b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export function fresh() {}
+fresh();
`.trim().split("\n");

test("a diff yields files, hunks, and the new-file line number of every added line", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((entry) => entry.file), ["src/a.ts", "src/new.ts"]);
  assert.equal(files[0].hunks[0].context, "export function outer() {", "the @@ trailer is kept: it names the enclosing definition");
  assert.deepEqual(files[0].hunks[0].lines, [
    { sign: "-", text: "const gone = 1;", line: 11 },
    { sign: "+", text: "const kept = 2;", line: 11 },
    { sign: "+", text: "const extra = 3;", line: 12 },
  ]);
  assert.deepEqual(files[1].hunks[0].lines.map((line) => line.line), [1, 2], "a new file counts from its first line");
});

test("a file diffed twice in one bundle keeps one entry, and its hunks add up", () => {
  const twice = [...DIFF, "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -40,1 +40,2 @@", "+const later = 4;"];
  const files = parseDiff(twice);
  assert.equal(files.length, 2);
  assert.equal(files[0].hunks.length, 2);
  assert.deepEqual([...changedLineCounts(files)], [["src/a.ts", 4], ["src/new.ts", 2]]);
});

test("text outside a hunk is not a changed line", () => {
  assert.deepEqual(parseDiff(["# self-review scope", "  M src/a.ts", "not a diff at all"]), []);
});
