// Run: node --test plugin/scripts/lib/review-log.test.mjs   (or ./test.sh for everything)
//
// The tier row is tested here rather than in tier.test.mjs because its only
// site in tier.mjs is the one call after the tier.json write: running the CLI
// is what tests that call, and the row's shape is this module's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { counts } from "./review-log.mjs";
import { reviewFromWork } from "../findings.mjs";
import { main as brief } from "../brief.mjs";
import { main as wait } from "../wait.mjs";

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NO_CONFIG = path.join(tmpdir(), "review-log-test-no-such-config.json");
process.env.SELF_REVIEW_CONFIG = NO_CONFIG;

const temp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const rowsIn = (logDir) => readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// A directory under a regular file cannot be created, whoever runs this.
const unwritable = () => {
  const blocker = path.join(temp("review-log-"), "file");
  writeFileSync(blocker, "");
  return path.join(blocker, "log");
};

// A repository whose one changed file has a name nothing else would print, so
// finding it in a row means a path crossed the line. It sits under auth/ so
// tier.mjs fires a marker and quotes the path as the marker's evidence.
const SECRET = "secret-name";
function fixture() {
  const root = temp("sr-review-log-repo-");
  const work = path.join(root, "scratch", "self-review", "review-4");
  const roundDir = path.join(work, "round-1");
  mkdirSync(roundDir, { recursive: true });
  const file = `src/auth/${SECRET}.ts`;
  const scope = path.join(roundDir, "scope.diff");
  writeFileSync(scope, [
    "# self-review scope", `# repo: ${root}`, "# branch: main   base: HEAD   generated: 2026-10-14T10:00:00Z", "",
    "## Changed files (git status, M=modified A=added D=deleted ?=untracked)", `  A  ${file}`, "",
    "## Diff vs HEAD (tracked files, staged + unstaged)", `--- a/${file}`, `+++ b/${file}`, "@@ -0,0 +1,1 @@", "+export const token = 1;",
  ].join("\n"));
  writeFileSync(path.join(work, "intent.md"), "INTENT\n");
  return { root, work, roundDir, scope, file };
}

const tier = ({ roundDir, scope, root }, logDir) =>
  spawnSync(process.execPath, [path.join(SCRIPTS, "tier.mjs"), "--scope", scope, "--out", `${roundDir}/`],
    { cwd: root, encoding: "utf8", env: { ...process.env, SELF_REVIEW_LOG_DIR: logDir, SELF_REVIEW_CONFIG: NO_CONFIG } });

test("counts keeps the numbers and booleans, turns a list into its length, and drops every string", () => {
  assert.deepEqual(
    counts({ lines: { code: 3, docs: 0 }, graphRisk: null, truncated: false, untested: ["src/a.ts", "src/b.ts"], why: "src/a.ts changed" }),
    { lines: { code: 3, docs: 0 }, graphRisk: null, truncated: false, untested: 2 });
});

test("the tier.json write logs one tier row keyed by the review", () => {
  const at = fixture();
  const logDir = temp("review-log-");
  const result = tier(at, logDir);
  assert.equal(result.status, 0, result.stderr);
  const rows = rowsIn(logDir);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(Object.keys(row).sort(),
    ["computed", "cwd", "finders", "kind", "markers", "metrics", "override", "review", "round", "roundsCap", "split", "tier", "ts", "verifier"]);
  assert.equal(row.kind, "tier");
  assert.equal(row.review, reviewFromWork(at.work), "the key the converge rows carry");
  const written = JSON.parse(readFileSync(path.join(at.roundDir, "tier.json"), "utf8"));
  assert.deepEqual({ tier: row.tier, round: row.round, finders: row.finders, override: row.override },
    { tier: written.tier, round: 1, finders: written.finders.length, override: null });
  assert.equal(row.markers.auth, written.markers.auth.length, "a marker is counted, its evidence is not carried");
});

test("an unwritable log dir still writes tier.json and exits 0", () => {
  const at = fixture();
  const result = tier(at, unwritable());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(at.roundDir, "tier.json")));
});

// A transcript that has finished, in the shape wait.mjs reads.
const finished = (subagents, name) => {
  const said = (content, stop) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", stop_reason: stop, usage: { input_tokens: 1 }, content } });
  writeFileSync(path.join(subagents, `agent-a${name}-0123456789abcdef.jsonl`), [
    said([{ type: "tool_use", id: "t1", name: "Read", input: {} }], "tool_use"),
    said([{ type: "text", text: "```json\n[]\n```" }], "end_turn"),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
};

test("no row from any source carries a path inside the project, other than cwd", async () => {
  const at = fixture();
  const logDir = temp("review-log-");
  assert.equal(tier(at, logDir).status, 0);

  const candidates = path.join(at.roundDir, "candidates.json");
  writeFileSync(candidates, JSON.stringify([{ id: "r1-1", file: at.file, line: 1, summary: `${SECRET} returns the token` }]));
  brief(["--verify", candidates, "--work", at.work, "--round", "1", "--live", at.root], { log: () => {}, logDir });

  const subagents = path.join(at.root, "subagents");
  mkdirSync(subagents);
  const name = `self-review-finder-k4-r1-${SECRET}`;
  finished(subagents, name);
  assert.equal(await wait(["--work", at.work, "--round", "1", "--session", subagents, name], { log: () => {}, logDir }), 0);

  const rows = rowsIn(logDir);
  assert.deepEqual(rows.map((row) => row.kind), ["tier", "units", "wait"]);
  const strings = (value) => typeof value === "string" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  for (const { cwd, ...rest } of rows) {
    for (const text of strings(rest)) {
      assert.ok(!text.startsWith(at.root), `${rest.kind}: ${text}`);
      assert.ok(!text.includes(SECRET), `${rest.kind}: ${text}`);
    }
    assert.ok(!JSON.stringify(rest).includes(SECRET), `${rest.kind} names the fixture file`);
  }
});
