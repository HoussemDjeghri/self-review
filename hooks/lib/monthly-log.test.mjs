// Run: node --test plugin/hooks/lib/monthly-log.test.mjs   (or ./test.sh)
//
// The monthly-segment log: one file per UTC month, appended to, and pruned of
// segments older than RETENTION_MONTHS on the first write of a new month only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RETENTION_MONTHS, appendMonthly, segmentOf } from "./monthly-log.mjs";

const logDir = () => path.join(mkdtempSync(path.join(tmpdir(), "monthly-")), "gate");
const rows = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const NOW = new Date("2026-10-14T12:00:00Z");

test("a row lands in the current UTC month's segment, creating the directory", () => {
  const dir = logDir();
  appendMonthly(dir, { a: 1 }, { now: NOW });
  appendMonthly(dir, { a: 2 }, { now: NOW });
  assert.deepEqual(readdirSync(dir), ["2026-10.jsonl"]);
  assert.deepEqual(rows(path.join(dir, "2026-10.jsonl")), [{ a: 1 }, { a: 2 }]);
});

test("the month is UTC: a write just before midnight UTC goes to that month, whatever the local zone", () => {
  assert.equal(segmentOf(new Date("2026-10-31T23:59:59Z")), "2026-10.jsonl");
  assert.equal(segmentOf(new Date("2026-11-01T00:00:00Z")), "2026-11.jsonl");
});

test("the first write of a month deletes segments older than the retention and keeps the rest", () => {
  assert.equal(RETENTION_MONTHS, 6);
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  // 7, 6 and 5 whole months before 2026-10: only the one past the line goes.
  for (const name of ["2026-03.jsonl", "2026-04.jsonl", "2026-05.jsonl", "notes.txt", "2026-03.json"]) writeFileSync(path.join(dir, name), "{}\n");
  appendMonthly(dir, { a: 1 }, { now: NOW });
  assert.deepEqual(readdirSync(dir).sort(), ["2026-03.json", "2026-04.jsonl", "2026-05.jsonl", "2026-10.jsonl", "notes.txt"],
    "a file that is not a segment is never touched");
});

test("a second write in the same month prunes nothing: one readdir a month", () => {
  const dir = logDir();
  appendMonthly(dir, { a: 1 }, { now: NOW });
  // Planted after the month's first write: still there after the second.
  writeFileSync(path.join(dir, "2025-01.jsonl"), "{}\n");
  appendMonthly(dir, { a: 2 }, { now: NOW });
  assert.ok(readdirSync(dir).includes("2025-01.jsonl"));
});

test("retention counts across a year boundary", () => {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  for (const name of ["2025-07.jsonl", "2025-08.jsonl"]) writeFileSync(path.join(dir, name), "{}\n");
  appendMonthly(dir, { a: 1 }, { now: new Date("2026-02-01T00:00:00Z") });
  assert.deepEqual(readdirSync(dir).sort(), ["2025-08.jsonl", "2026-02.jsonl"]);
});

test("an unwritable directory throws to the caller: whether that is fatal is the caller's call", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "monthly-"));
  writeFileSync(path.join(parent, "gate"), "a file where the directory should be");
  assert.throws(() => appendMonthly(path.join(parent, "gate"), { a: 1 }, { now: NOW }));
});
