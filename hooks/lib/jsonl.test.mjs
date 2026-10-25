// Run: node --test plugin/hooks/lib/jsonl.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { constants } from "node:buffer";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonlOf, linesOf } from "./jsonl.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "jsonl-test-"));
const fileWith = (name, text) => { const file = path.join(dir, name); writeFileSync(file, text); return file; };

// A file larger than any string, made sparse so it costs no disk: one line
// either side of a run of zero bytes past V8's string cap.
function overLimitFile(file, first, last) {
  writeFileSync(file, `${JSON.stringify(first)}\n`);
  truncateSync(file, constants.MAX_STRING_LENGTH + 1024);
  appendFileSync(file, `\n${JSON.stringify(last)}\n`);
  return file;
}

test("lines match a split of the whole text at every chunk size, multibyte characters included", () => {
  const text = 'ascii\n{"é":"ü"}\n\n😀 four-byte\r\nlast without newline ✓';
  const file = fileWith("multi.txt", text);
  for (let chunkBytes = 1; chunkBytes <= 9; chunkBytes += 1) {
    assert.deepEqual([...linesOf(file, { chunkBytes })], text.split("\n"), `chunkBytes ${chunkBytes}`);
  }
});

test("a trailing newline does not add an empty last line, and an empty file has none", () => {
  assert.deepEqual([...linesOf(fileWith("trail.txt", "a\nb\n"), { chunkBytes: 2 })], ["a", "b"]);
  assert.deepEqual([...linesOf(fileWith("empty.txt", ""))], []);
});

test("a line over the cap is skipped whole and its neighbours survive", () => {
  const file = fileWith("long.txt", `short\n${"x".repeat(50)}\nafter\n${"y".repeat(50)}`);
  for (const chunkBytes of [3, 16, 64, 4096]) {
    assert.deepEqual([...linesOf(file, { chunkBytes, maxLineBytes: 20 })], ["short", "after"], `chunkBytes ${chunkBytes}`);
  }
});

test("jsonlOf yields parsed values and skips blank and torn lines", () => {
  const file = fileWith("rows.jsonl", '{"a":1}\n\nnot json\n[2]\nnull\n{"torn":');
  assert.deepEqual([...jsonlOf(file, { chunkBytes: 4 })], [{ a: 1 }, [2], null]);
});

test("a missing file throws when read, as readFileSync did", () => {
  assert.throws(() => [...linesOf(path.join(dir, "absent.jsonl"))], { code: "ENOENT" });
});

test("a file larger than the string cap is read: readFileSync cannot, and this reader can", () => {
  const file = overLimitFile(path.join(dir, "huge.jsonl"), { n: 1 }, { n: 2 });
  assert.throws(() => readFileSync(file, "utf8"), { code: "ERR_STRING_TOO_LONG" });
  assert.deepEqual([...jsonlOf(file)], [{ n: 1 }, { n: 2 }]);
});
