import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "reviews-dir.sh");
const ID = "0bd9e1a2-1111-2222-3333-444455556666";
const run = (env) => spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("the same session gets the same base on every call, created private", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rd-"));
  const one = run({ TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: ID });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, `${tmp}/self-review-${ID}/self-review/\n`);
  assert.ok(existsSync(path.join(tmp, `self-review-${ID}`, "self-review")));
  assert.equal(run({ TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: ID }).stdout, one.stdout, "nothing to remember: the id is the address");
  rmSync(tmp, { recursive: true });
});

test("no usable session id is refused, never replaced by another path", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rd-"));
  for (const id of [undefined, "", "../../etc", `${ID}/..`]) {
    const done = run({ TMPDIR: tmp, ...(id === undefined ? {} : { CLAUDE_CODE_SESSION_ID: id }) });
    assert.equal(done.status, 2, `id=${id}`);
    assert.equal(done.stdout, "");
    assert.match(done.stderr, /not a session id/);
  }
  rmSync(tmp, { recursive: true });
});

test("a pre-planted symlink or a directory that is not private is refused on every call", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rd-"));
  const target = mkdtempSync(path.join(tmpdir(), "rd-elsewhere-"));
  symlinkSync(target, path.join(tmp, `self-review-${ID}`));
  const linked = run({ TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: ID });
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /not a directory/);
  const other = "1bd9e1a2-1111-2222-3333-444455556666";
  mkdirSync(path.join(tmp, `self-review-${other}`), { mode: 0o755 });
  chmodSync(path.join(tmp, `self-review-${other}`), 0o755);
  const open = run({ TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: other });
  assert.equal(open.status, 2);
  assert.match(open.stderr, /mode 755, not 700/);
  assert.equal(run({ TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: ID, X: "1" }).stdout, "", "and still refused on the next call");
  rmSync(tmp, { recursive: true }); rmSync(target, { recursive: true });
});
