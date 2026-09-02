// Run: node --test plugin/scripts/lib/marker.test.mjs   (or ./test.sh for everything)
//
// The grammar three consumers agree on. The cases that matter are the ones the
// real 112-marker log produced: counts that are not numbers, and the
// `rounds=0` non-review that used to read as a converged one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSummary, validateMarker } from "./marker.mjs";

const ok = (fields) => {
  const { record, problems } = validateMarker(fields);
  assert.deepEqual(problems, [], `expected valid, got: ${problems.join(" ")}`);
  return record;
};
const bad = (fields, match) => {
  const { record, problems } = validateMarker(fields);
  assert.equal(record, null);
  assert.ok(problems.some((p) => match.test(p)), `no problem matched ${match}: ${problems.join(" | ")}`);
  return problems;
};

test("a counted outcome formats to key=value tokens only", () => {
  const record = ok({ outcome: "converged", rounds: 2, fixed: 3, dismissed: 1, open: 0, tier: "M", adapter: "grep" });
  assert.equal(formatSummary(record), "outcome=converged rounds=2 fixed=3 dismissed=1 open=0 tier=M adapter=grep");
});

test("not-converged is counted the same way", () => {
  const record = ok({ outcome: "not-converged", rounds: 6, fixed: 4, dismissed: 2, open: 3 });
  assert.equal(formatSummary(record), "outcome=not-converged rounds=6 fixed=4 dismissed=2 open=3");
});

test("every count is required for a counted outcome", () => {
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0 }, /^open is required/);
});

// The nine real tokens that corrupted audit.mjs's sums, in their own shapes.
for (const value of ["2of3", "3+verifier", "1(rebutted,", "0;", "0.", "3-complete+1-stopped", "-1", ""]) {
  test(`a count of "${value}" is refused, not silently kept as a string`, () => {
    bad({ outcome: "converged", rounds: value, fixed: 0, dismissed: 0, open: 0 }, /^rounds/);
  });
}

test("not-applicable refuses counts rather than defaulting them to zero", () => {
  bad({ outcome: "not-applicable", reason: "no-code-changed", rounds: 0 }, /rounds cannot be given/);
});

test("not-applicable requires a reason from the closed set", () => {
  bad({ outcome: "not-applicable" }, /^reason is required/);
  bad({ outcome: "not-applicable", reason: "felt-unnecessary" }, /is not one of/);
});

test("reason=other must say what the case was", () => {
  bad({ outcome: "not-applicable", reason: "other" }, /^note is required/);
  const record = ok({ outcome: "not-applicable", reason: "other", note: "the harness ate it" });
  assert.equal(formatSummary(record), "outcome=not-applicable reason=other");
});

test("a reason on a counted outcome is refused", () => {
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, reason: "user-declined" }, /only applies to/);
});

test("the outcome itself is checked", () => {
  bad({}, /^outcome is required/);
  bad({ outcome: "done" }, /is not one of/);
});

test("the note never enters the summary, however it is written", () => {
  const record = ok({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, note: "rounds=99 open=?? — prose" });
  assert.equal(formatSummary(record), "outcome=converged rounds=1 fixed=0 dismissed=0 open=0");
  assert.equal(record.note, "rounds=99 open=?? — prose");
});

test("a label with whitespace would split one field into two, so it is refused", () => {
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, tier: "M then S" }, /cannot contain whitespace/);
});

test("all defects are reported at once, not one per rejection", () => {
  const problems = bad({ outcome: "converged", rounds: "x" }, /^rounds/);
  assert.ok(problems.length >= 4, `expected every missing count too, got: ${problems.join(" | ")}`);
});

test("rounds=0 is the escape hatch wearing a review's clothes, so it is refused", () => {
  bad({ outcome: "converged", rounds: 0, fixed: 0, dismissed: 0, open: 0 }, /rounds=0 is not a review/);
  bad({ outcome: "not-converged", rounds: 0, fixed: 0, dismissed: 0, open: 0 }, /rounds=0 is not a review/);
  // The other three counts are zero on a clean first round. Only rounds is a claim.
  ok({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0 });
});

test("an unknown outcome does not hide the other defects", () => {
  const problems = bad({ outcome: "done", rounds: "two", fixed: 1, dismissed: 0, open: -1 }, /is not one of/);
  assert.ok(problems.some((p) => /^rounds="two"/.test(p)), `rounds not judged: ${problems.join(" | ")}`);
  assert.ok(problems.some((p) => /^open="-1"/.test(p)), `open not judged: ${problems.join(" | ")}`);
});

test("a missing outcome does not hide the other defects either", () => {
  const problems = bad({ rounds: "two" }, /^outcome is required/);
  assert.ok(problems.some((p) => /^rounds="two"/.test(p)), `rounds not judged: ${problems.join(" | ")}`);
});

test("a tier override round-trips, because SKILL.md tells the loop to record one", () => {
  const record = ok({ outcome: "converged", rounds: 2, fixed: 1, dismissed: 0, open: 0, tier: "S", forced: "S", computed: "M" });
  assert.equal(formatSummary(record), "outcome=converged rounds=2 fixed=1 dismissed=0 open=0 tier=S forced=S computed=M");
});

test("half an override is not readable, so both sides are required together", () => {
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, forced: "S" }, /forced and computed/);
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, computed: "M" }, /forced and computed/);
});

test("a tier label outside S|M|L would open an audit bucket nothing writes", () => {
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, tier: "XL" }, /tier="XL" is not one of/);
  bad({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, forced: "XL", computed: "M" }, /forced="XL" is not one of/);
  // adapter is an open vocabulary — the loop names its own scope adapters.
  ok({ outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0, adapter: "jj" });
});

test("a key the record does not have is named, not silently ignored", () => {
  // A typo means the real field is missing AND a stray one is present. Naming
  // only the first sends the author back to fix half of it.
  const problems = bad({ outcome: "converged", rounds: 2, fixed: 3, dismissed: 1, opne: 0 }, /^open is required/);
  assert.ok(problems.some((p) => /opne/.test(p)), `the typo was not named: ${problems.join(" | ")}`);
});

test("the legacy summary string is a key like any other, and refused as one", () => {
  bad({ summary: "rounds=2 fixed=3" }, /summary/);
});
