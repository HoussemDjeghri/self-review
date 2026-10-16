// Run: node --test plugin/scripts/brief.test.mjs   (or ./test.sh for everything)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { angleSections, buildPlan, dismissedFrom, estimateTokens, fixedFrom, impactLines, logPriorShown, main, priorIdsIn, renderBrief, reviewName, reviewNumber, writeBriefs } from "./brief.mjs";
import { agentSettings } from "../hooks/lib/agent-settings.mjs";
import { reviewFromWork } from "./findings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "brief.mjs");
const CATALOGUE = path.join(HERE, "..", "skills", "self-review", "references", "angles.md");
// A user config file that does not exist keeps loadConfig() on the shipped
// defaults, so these assertions do not depend on the machine running them.
process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "brief-test-no-such-config.json");
// brief.mjs appends to the metrics log; the suite must not write into the
// developer's own memory.
process.env.SELF_REVIEW_LOG_DIR = mkdtempSync(path.join(tmpdir(), "sr-log-"));

const workdir = () => mkdtempSync(path.join(tmpdir(), "brief-"));
const budget = { maxTokens: 2800, impactMaxLines: 80, priorMaxLines: 10 };
const angles = angleSections(readFileSync(CATALOGUE, "utf8"));
const briefArgs = (over = {}) => ({
  row: { name: "r1-a", angles: ["A"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "full" },
  index: 0, total: 1, round: 1,
  intent: "INTENT\nUser asked: \"x\"\n", scope: "/w/round-1/scope.diff", live: "/repo",
  angles, stateFile: "/w/round-1/state/r1-a.jsonl",
  dismissed: [], impact: { lines: [], protectedFlags: [] }, prior: [], budget,
  ...over,
});

test("angles are lifted verbatim from the catalogue, one section each", () => {
  assert.equal(angles.get("A").title, "A · Line-by-line diff scan");
  assert.match(angles.get("A").body, /^Read every hunk line by line/);
  assert.doesNotMatch(angles.get("A").body, /Removed-behaviour/, "a section stops at the next heading");
  assert.match(angles.get("P4").title, /^P4 · /);
  assert.match(angles.get("compact").body, /every lens at once/);
  assert.doesNotMatch(angles.get("H").body, /^## /m, "the trailing rule between groups is not angle text");
});

test("the fallback plan follows the round-1 groups, and merges by round", () => {
  assert.deepEqual(buildPlan("M", 1).finders.map((f) => f.angles), [["A", "B", "D"], ["C", "E", "F"], ["Q", "V"]]);
  assert.equal(buildPlan("S", 1).finders.length, 1);
  assert.deepEqual(buildPlan("S", 1).finders[0].angles, ["compact"]);
  const large = buildPlan("L", 1);
  assert.equal(large.finders.length, 6, "six is the cap, not a coincidence");
  assert.equal(large.verifier, "agent", "tier L gets an independent verifier");
  for (const finder of large.finders) {
    const risk = ["G", "H"].includes(finder.angles[0]);
    assert.deepEqual({ model: finder.model, effort: finder.effort }, agentSettings(risk ? "risk-finder" : "finder"), finder.angles.join("+"));
  }
  assert.equal(buildPlan("M", 2).finders.length, 2, "round 2 merges to two finders");
  assert.deepEqual(buildPlan("L", 3).finders.map((f) => f.angles), [["compact"]], "round 3+ is one compact finder");
  assert.equal(buildPlan("M", 2).finders[0].name, "self-review-finder-r2-abdqv",
    "the fallback plan's names must lead with the agent type too — tree-guard reads the name");
});

test("only the dismissed section of the ledger travels to the next round", () => {
  const ledger = `# ledger\n\n## fixed\n- F1 — swallowed abort\n\n## dismissed   <- passed on\n- D1 — race: refuted, the lock is held\n- D2 — off-by-one: refuted\n\n## open\n- O1 — backoff cap\n`;
  assert.deepEqual(dismissedFrom(ledger), ["- D1 — race: refuted, the lock is held", "- D2 — off-by-one: refuted"]);
  assert.deepEqual(dismissedFrom("# ledger\n\n## fixed\n- F1\n"), [], "no dismissed section means nothing to pass on");
  assert.deepEqual(dismissedFrom(""), []);
  assert.deepEqual(fixedFrom(ledger), ["- F1 — swallowed abort"], "the fixed section is read for angle S");
  assert.deepEqual(fixedFrom("# ledger\n\n## dismissed\n- D1\n"), []);
  assert.deepEqual(fixedFrom(""), []);
});

test("the fix history reaches angle S and no other angle", () => {
  const fixed = ["- [blocker] gate.mjs:1233 — wrong bound", "- [major] gate.mjs:1240 — wrong frame"];
  const shape = renderBrief(briefArgs({
    row: { name: "r3-s", angles: ["S"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "full" },
    fixed,
  }));
  assert.match(shape.text, /FIX HISTORY/);
  assert.match(shape.text, /wrong bound/, "S's step 3 is unperformable without the fix list");
  // The rule the exception is carved out of: every other angle re-discovers a
  // fix as correct, so telling it what was already fixed is the bias itself.
  const line = renderBrief(briefArgs({ fixed }));
  assert.doesNotMatch(line.text, /FIX HISTORY/);
  assert.doesNotMatch(line.text, /wrong bound/);
  const firstS = renderBrief(briefArgs({
    row: { name: "r3-s", angles: ["S"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "full" },
    fixed: [],
  }));
  assert.match(firstS.text, /none — this is the first round to reach angle S/);
});

const IMPACT = [
  "IMPACT (grep, 0.4s): 3 files · 5 symbols · 14 refs in 9 files",
  "# Line numbers are current as of 2026-08-23T10:04:11Z.",
  "",
  "## Broken references — still reference a removed or renamed symbol",
  "- scripts/salvage.mjs:44          → mergeInto (removed)",
  "",
  "## Callers and references (code)",
  ...Array.from({ length: 30 }, (_, i) => `- src/caller${i}.ts:${i} → run`),
  "",
  "## Docs and config that mention the change",
  "- README.md:12 → mergeInto",
].join("\n");

test("impact depth: summary is the file's own two-line header", () => {
  const { lines } = impactLines(IMPACT, "summary", budget);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^IMPACT \(grep/);
});

test("impact depth: docs keeps broken references and the docs section, drops the caller list", () => {
  const { lines } = impactLines(IMPACT, "docs", budget);
  const text = lines.join("\n");
  assert.match(text, /Broken references/);
  assert.match(text, /README\.md:12/);
  assert.doesNotMatch(text, /src\/caller3\.ts/);
  assert.ok(lines.length <= budget.impactMaxLines / 2);
  assert.match(lines[0], /^IMPACT \(grep/, "the counts header is what tells a docs reviewer how big the change is");
  assert.match(text, /Line numbers are current/, "a single-# note above the first section is header, not a section");
});

test("broken references are protected wherever they sit, and the rows above them stay droppable", () => {
  const reordered = ["IMPACT: counts", "# line numbers as of now", "",
    "## Callers and references (code)",
    ...Array.from({ length: 20 }, (_, i) => `- src/caller${i}.ts:${i} -> run`),
    "", "## Broken references — still reference a removed symbol", "- scripts/salvage.mjs:44 -> mergeInto (removed)"].join("\n");
  const impact = impactLines(reordered, "full", budget);
  const droppable = impact.protectedFlags.filter((flag) => !flag).length;
  assert.ok(droppable >= 20, `only ${droppable} lines droppable — protection is a prefix again`);
  const brief = renderBrief(briefArgs({ impact, budget: { ...budget, maxTokens: 600 } }));
  assert.match(brief.text, /salvage\.mjs:44/, "the broken reference survives");
  assert.doesNotMatch(brief.text, /caller19/, "the last caller row goes first");
  assert.ok(brief.tokens <= 600, `still ${brief.tokens} tokens`);
});

test("impact depth: full is capped at brief.impactMaxLines", () => {
  const { lines, protectedFlags } = impactLines(IMPACT, "full", { ...budget, impactMaxLines: 6 });
  assert.ok(lines.filter((_, i) => !protectedFlags[i]).length <= 6);
  assert.ok(lines.length <= 10, `${lines.length} lines is more than the cap plus its protected rows`);
});

test("a broken-references section longer than the cap is kept whole, not truncated", () => {
  // The cap used to run before the protection pass, so exactly the rows the
  // impact block exists to show were the ones the cap cut off.
  const many = ["IMPACT: counts", "# line numbers as of now", "",
    "## Broken references — still reference a removed or renamed symbol",
    ...Array.from({ length: 25 }, (_, i) => `- src/ref${i}.ts:${i} -> mergeInto (removed)`),
    "", "## Callers and references (code)",
    ...Array.from({ length: 25 }, (_, i) => `- src/caller${i}.ts:${i} -> run`)].join("\n");
  const { lines } = impactLines(many, "full", { ...budget, impactMaxLines: 10 });
  const text = lines.join("\n");
  for (let i = 0; i < 25; i += 1) assert.match(text, new RegExp(`ref${i}\\.ts`), `broken reference ${i} was cut`);
  assert.doesNotMatch(text, /caller24/, "the caller rows are still capped");
});

test("the state-file instructions follow the agent the plan assigned, not the angle shape", () => {
  // The reviewer with no Bash must be told to Write its lifeboat; every other
  // reviewer is told to append it. brief.mjs used to decide that by
  // re-deriving tier.mjs's private predicate (angles === ["X"]) — a second
  // copy of a check, which is the exact way the two halves of this feature
  // once disagreed about what an entry point is. The row already carries the
  // answer tier.mjs computed.
  const graded = renderBrief(briefArgs({
    row: { name: "r1-x", angles: ["X"], agent: "self-review-cold-grader", model: "sonnet", effort: "high", calls: 20, impact: "summary" },
  }));
  assert.match(graded.text, /candidates you have so far there/, "Write, because this reviewer has no shell");
  assert.doesNotMatch(graded.text, /same Bash call/);

  // Same angle, ordinary finder: the instructions follow the agent, not the X.
  const shelled = renderBrief(briefArgs({
    row: { name: "r1-x", angles: ["X"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 20, impact: "summary" },
  }));
  assert.match(shelled.text, /same Bash call/, "a reviewer with a shell is told to append");
});

test("an over-budget brief trims impact rows first, from the lowest-ranked end", () => {
  const impact = impactLines(IMPACT, "full", budget);
  const brief = renderBrief(briefArgs({ impact, budget: { ...budget, maxTokens: 600 } }));
  assert.ok(brief.trimmedImpact > 0);
  assert.match(brief.text, /# trimmed to fit 600 tokens: \d+ impact rows/);
  assert.match(brief.text, /salvage\.mjs:44/, "broken references survive the trim");
  assert.doesNotMatch(brief.text, /caller29/, "the last-listed caller goes first");
  assert.ok(brief.tokens <= 600, `still ${brief.tokens} tokens`);
});

test("prior findings are trimmed only after impact, and the angle is never trimmed", () => {
  const prior = Array.from({ length: 10 }, (_, i) => `- prior finding ${i}`);
  const brief = renderBrief(briefArgs({ prior, budget: { ...budget, maxTokens: 470 } }));
  assert.match(brief.text, /\d+ prior lines/);
  assert.match(brief.text, /Read every hunk line by line/, "angle text is never cut");
});

test("prior lines ship with the rule for citing them, and nothing ships without them", () => {
  // The finder's own answer about which prior line it is re-raising is what
  // DESIGN §4.4 measures the memory on, and the rule belongs beside the lines
  // it is about — a finder reading only the brief would otherwise never see it.
  const withPrior = renderBrief(briefArgs({ prior: ["- [1a2b3c4d] src/a.mjs:4 · correctness · the tail is dropped · fixed"] }));
  assert.match(withPrior.text, /put the eight characters its\nbrackets hold in your finding's `prior_id`/);
  assert.doesNotMatch(renderBrief(briefArgs({})).text, /prior_id/, "no prior lines, no rule for citing them");
});

test("the brief reports the prior lines it kept, so a trimmed one is never counted as shown", () => {
  // DESIGN §4.4 scores a finder's `prior_id` against what the run put in front
  // of it. The render is the only place that knows: the token budget drops
  // prior lines from the end, and a line dropped here was never shown.
  const prior = Array.from({ length: 10 }, (_, i) => `- [${String(i).padStart(8, "a")}] src/f${i}.mjs:1 · correctness · finding ${i} · fixed`);
  const whole = renderBrief(briefArgs({ prior }));
  assert.deepEqual(priorIdsIn(whole.priorShown).length, 10);
  const trimmed = renderBrief(briefArgs({ prior, budget: { ...budget, maxTokens: 470 } }));
  assert.ok(trimmed.trimmedPrior > 0, "this budget must actually cut prior lines");
  assert.equal(trimmed.priorShown.length, 10 - trimmed.trimmedPrior);
  for (const id of priorIdsIn(trimmed.priorShown)) assert.match(trimmed.text, new RegExp(id));
});

test("the prior ids a round showed are logged once, as the union across its briefs", () => {
  const logDir = workdir();
  const row = logPriorShown(["1a2b3c4d", "5e6f7a8b"], { round: 2, cwd: "/repo", logDir, now: () => "T" });
  assert.deepEqual(row, { ts: "T", kind: "prior-shown", cwd: "/repo", round: 2, shown: ["1a2b3c4d", "5e6f7a8b"] });
  assert.deepEqual(JSON.parse(readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim()), row);
  // A round that showed nothing writes an empty row, and that is the point: no
  // row at all is indistinguishable from a build too old to log, so a reader
  // has to call a cold review unmeasured and switch off the guard that catches
  // an unverifiable cite — in the one arm that has no ids to cite.
  const empty = logPriorShown([], { round: 1, cwd: "/repo", logDir, now: () => "T" });
  assert.deepEqual(empty, { ts: "T", kind: "prior-shown", cwd: "/repo", round: 1, shown: [] });
  assert.equal(readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("a ledger that cannot fit is flagged, not cut", () => {
  const dismissed = Array.from({ length: 40 }, (_, i) => `- D${i} — refuted because the lock is held across the whole write`);
  const brief = renderBrief(briefArgs({ dismissed, budget: { ...budget, maxTokens: 400 } }));
  assert.match(brief.text, /# over budget: ledger 40 lines/);
  assert.match(brief.text, /- D39 —/, "every dismissal still ships");
  assert.ok(brief.tokens > 400);
});

test("a brief that fits carries no budget note", () => {
  const brief = renderBrief(briefArgs());
  assert.doesNotMatch(brief.text, /^# /m);
  assert.match(brief.text, /^You are reviewer 1 of 1 in round 1/);
  assert.match(brief.text, /CALL BUDGET\n40 tool calls/);
  assert.match(brief.text, /ALREADY DISMISSED[^\n]*\nnone/);
  assert.match(brief.text, /STATE FILE[^\n]*\n\/w\/round-1\/state\/r1-a\.jsonl/);
});

test("both briefs say an empty lifeboat is left alone, not filled with `[]`", () => {
  // 2026-09-08: a finder with nothing to report wrote `[]` into its state file,
  // taking the empty-list form from the OUTPUT section eleven lines below —
  // which is the final message's contract, not the lifeboat's. `wait.mjs` read
  // the round as having a candidate. The count there no longer miscounts it,
  // but the shape is manufactured here, so it is closed here too.
  for (const grading of [false, true]) {
    const agent = grading ? "self-review-cold-grader" : "self-review-finder";
    const text = renderBrief(briefArgs({ row: { ...briefArgs().row, agent } })).text;
    assert.match(text, /STATE FILE[\s\S]*?belongs in your final message, not here/,
      `grading=${grading}: the lifeboat's contract must rule out \`[]\``);
  }
});

test("the estimator counts bytes, not characters", () => {
  assert.equal(estimateTokens("abcdefg"), 2);
  // Four two-byte characters: 8 bytes is 3 estimated tokens, 4 characters would
  // be 2 — so a regression to text.length fails here instead of shipping briefs
  // that undercount every non-ASCII line.
  assert.equal(estimateTokens("é".repeat(4)), 3);
  assert.equal(estimateTokens("abcd"), 2);
});

test("the CLI writes one brief per plan row, creates the state directory, and prints a table of at most 8 lines", () => {
  const dir = workdir();
  writeFileSync(path.join(dir, "intent.md"), "INTENT\nUser asked: \"ship phase 2\"\n");
  writeFileSync(path.join(dir, "scope.diff"), "## Changed files\n  M scripts/brief.mjs\n");
  const lines = [];
  const results = main(
    ["--round", "1", "--tier", "L", "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "scope.diff"),
     "--out", path.join(dir, "round-1", "briefs"), "--live", dir],
    { log: (line) => lines.push(line) },
  );
  assert.equal(results.length, 6);
  assert.ok(lines.length <= 8, `${lines.length} stdout lines`);
  assert.match(lines[0], /^# 6 briefs for round 1, tier L .* verifier: agent — spawn each line as printed/);
  // The exact call, so the agent runs under the row's name: the guards match it
  // and wait.mjs finds the state file by it.
  const call = JSON.parse(/^Agent (\{.*\})  # 40 calls, \d+ tok$/.exec(lines[1])[1]);
  assert.equal(call.name, "self-review-finder-r1-ab");
  assert.match(call.subagent_type, /^(self-review:)?self-review-finder$/);
  assert.deepEqual({ model: call.model, effort: call.effort }, agentSettings("finder"),
    "the call carries effort too — before it did, a plan row's effort never reached the agent");
  assert.equal(call.prompt, `Read ${path.join(dir, "round-1", "briefs", "self-review-finder-r1-ab.md")} and follow it.`);
  assert.ok(existsSync(path.join(dir, "round-1", "briefs", "self-review-finder-r1-g.md")));
  assert.ok(existsSync(path.join(dir, "round-1", "state")), "the state directory exists before the finder appends to it");
  assert.match(readFileSync(path.join(dir, "round-1", "briefs", "self-review-finder-r1-g.md"), "utf8"), /ship phase 2/);
});

test("a review's finder names carry its number, so no two reviews of a session print the same name", () => {
  // The harness renames a repeated name to `-2`, `-3`, … and every lookup by the
  // printed name then finds another review's agent or none (B7, 18 sessions).
  const names = (k) => {
    const dir = workdir();
    const work = path.join(dir, `review-${k}`);
    writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
    writeFileSync(path.join(dir, "scope.diff"), "diff\n");
    const lines = [];
    const results = main(["--round", "1", "--tier", "M", "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "scope.diff"),
      "--out", path.join(work, "round-1", "briefs"), "--live", dir], { log: (l) => lines.push(l) });
    const printed = lines.filter((l) => l.startsWith("Agent ")).map((l) => JSON.parse(/^Agent (\{.*\})  #/.exec(l)[1]).name);
    // The brief, the state file and the call agree, so wait.mjs's default names
    // (the brief stems) are the names that were spawned.
    for (const { file } of results) {
      const stem = path.basename(file, ".md");
      assert.ok(printed.includes(stem), `${stem} not among ${printed}`);
      assert.ok(readFileSync(file, "utf8").includes(path.join(work, "round-1", "state", `${stem}.jsonl`)));
    }
    return printed;
  };
  const first = names(1), third = names(3);
  assert.ok(first.includes("self-review-finder-k1-r1-abd"), first.join(" "));
  assert.ok(third.includes("self-review-finder-k3-r1-abd"), third.join(" "));
  assert.ok(first.every((name) => !third.includes(name)));
});

test("reviewName puts the review after the agent type, once, and leaves a name with no review alone", () => {
  assert.equal(reviewName("self-review-finder-r1-ab", "self-review-finder", "3"), "self-review-finder-k3-r1-ab");
  assert.equal(reviewName("self-review-cold-grader-r1-x", "self-review-cold-grader", 2), "self-review-cold-grader-k2-r1-x");
  assert.equal(reviewName("self-review-finder-k3-r1-ab", "self-review-finder", 3), "self-review-finder-k3-r1-ab", "idempotent");
  assert.equal(reviewName("r2-custom", "self-review-finder", 4), "r2-custom-k4", "a name that does not lead with its type still becomes unique");
  assert.equal(reviewName("self-review-finder-r1-ab", "self-review-finder", null), "self-review-finder-r1-ab");
  assert.equal(reviewNumber("/s/self-review/review-12"), "12");
  assert.equal(reviewNumber("/s/self-review"), null);
});

test("a tier.json plan drives the briefs, including its own names and models", () => {
  const dir = workdir();
  writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
  writeFileSync(path.join(dir, "scope.diff"), "diff\n");
  writeFileSync(path.join(dir, "tier.json"), JSON.stringify({
    schema: 1, tier: "M", round: 2, verifier: "author",
    finders: [{ name: "r2-custom", kind: "code", angles: ["C"], agent: "self-review-finder", model: "opus", effort: "high", calls: 25, impact: "summary" }],
  }));
  const lines = [];
  main(["--plan", path.join(dir, "tier.json"), "--intent", path.join(dir, "intent.md"),
        "--scope", path.join(dir, "scope.diff"), "--out", path.join(dir, "briefs")], { log: (l) => lines.push(l) });
  assert.match(lines[0], /round 2, tier M/);
  assert.match(lines[1], /^Agent \{"subagent_type":"(self-review:)?self-review-finder","name":"r2-custom","model":"opus",.*\}  # 25 calls/);
  assert.match(readFileSync(path.join(dir, "briefs", "r2-custom.md"), "utf8"), /C · Cross-file tracer/);
});

test("what the ledger carried is stated, and an empty one at round 2 says so", () => {
  // Rounds 2-4 of the v0.7.2 review ran on a ledger the lead never wrote:
  // `round.sh` seeds `<work>/ledger.md` with a placeholder, so "nothing was
  // dismissed" and "the lead forgot" produced identical silence and the
  // dismissed list had to be pasted into the agent prompts by hand.
  const dir = workdir();
  writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
  writeFileSync(path.join(dir, "scope.diff"), "diff\n");
  const plan = (round) => {
    const file = path.join(dir, `plan-${round}.json`);
    writeFileSync(file, JSON.stringify({
      schema: 1, tier: "S", round, verifier: "author",
      finders: [{ name: `r${round}-a`, kind: "code", angles: ["A"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "summary" }],
    }));
    return file;
  };
  const run = (round, ledgerFile) => {
    const lines = [];
    main(["--plan", plan(round), "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "scope.diff"),
          ...(ledgerFile ? ["--ledger", ledgerFile] : []), "--out", path.join(dir, `briefs-${round}`)], { log: (l) => lines.push(l) });
    return lines.join("\n");
  };

  const placeholder = path.join(dir, "placeholder.md");
  writeFileSync(placeholder, "_No dismissals yet._\n");
  assert.match(run(2, placeholder), /no dismissed findings carried into this round/);
  assert.match(run(2, placeholder), /placeholder\.md was never updated/,
    "the line names the file the lead has to write, not just the fact");

  const real = path.join(dir, "ledger.md");
  writeFileSync(real, "# ledger\n\n## dismissed\n- D1 — refuted: the lock is held\n- D2 — refuted: unreachable\n");
  assert.match(run(3, real), /^# 2 dismissed findings carried into every brief$/m);

  // A written ledger whose dismissed section holds only its placeholder: no
  // dismissals, and no scolding either — the lead did update it.
  const none = path.join(dir, "none.md");
  writeFileSync(none, "# ledger\n\n## fixed\n- r1-1 fixed\n\n## dismissed\n_No dismissals yet._\n\n## open\n- r1-2 open\n");
  assert.match(run(2, none), /^# 0 dismissed findings carried into every brief$/m);

  // Round 1 has nothing to carry by definition, so it must not be scolded.
  const round1 = run(1, placeholder);
  assert.doesNotMatch(round1, /never updated/);
  assert.match(round1, /^# 0 dismissed findings carried into every brief$/m);
});

test("a plan is rejected whole: a bad row leaves no earlier brief on disk", () => {
  const dir = workdir();
  writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
  const plan = (finders) => {
    const file = path.join(dir, `plan-${finders[finders.length - 1].name}.json`);
    writeFileSync(file, JSON.stringify({ round: 1, tier: "M", finders }));
    return file;
  };
  const out = path.join(dir, "briefs");
  const row = (name, over = {}) => ({ name, angles: ["A"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "summary", ...over });
  const run = (planFile) => spawnSync("node", [SCRIPT, "--plan", planFile, "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "intent.md"), "--out", out], { encoding: "utf8" });

  const unknownAngle = run(plan([row("ok-first"), row("bad-second", { angles: ["ZZ"] })]));
  assert.equal(unknownAngle.status, 3);
  assert.match(unknownAngle.stderr, /no angle "ZZ" in the catalogue/);
  assert.ok(!existsSync(path.join(out, "ok-first.md")), "the first row's brief must not survive the second row's error");

  const duplicate = run(plan([row("dup"), row("dup", { angles: ["C"] })]));
  assert.equal(duplicate.status, 3, "two rows cannot share a brief file");
  assert.match(duplicate.stderr, /used more than once/);
  assert.ok(!existsSync(path.join(out, "dup.md")));

  const noCalls = run(plan([{ name: "no-budget", angles: ["A"], agent: "self-review-finder", model: "sonnet", effort: "high", impact: "summary" }]));
  assert.equal(noCalls.status, 3, "a row without a call budget would brief a finder with \"undefined tool calls\"");
  assert.match(noCalls.stderr, /calls must be a positive integer/);

  const badDepth = run(plan([row("wrong-depth", { impact: "Full" })]));
  assert.equal(badDepth.status, 3, "an unknown impact depth is refused, not silently treated as full");
  assert.match(badDepth.stderr, /impact must be one of/);
  assert.ok(!existsSync(out));

  const noEffort = run(plan([row("no-effort", { effort: undefined })]));
  assert.equal(noEffort.status, 3, "a row without an effort would spawn the finder on the frontmatter's effort");
  assert.match(noEffort.stderr, /effort/);
  assert.ok(!existsSync(out));
});

test("--help prints the usage and exits 0", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /usage/i);
});

test("usage errors exit 2, unreadable inputs exit 3, and neither writes a brief", () => {
  const dir = workdir();
  writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
  const run = (args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  const good = ["--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "intent.md"), "--out", path.join(dir, "out")];
  assert.equal(run([...good]).status, 2, "no plan and no tier");
  assert.equal(run(["--plan", "p.json", "--tier", "M", ...good]).status, 2, "both plan and tier");
  assert.equal(run(["--tier", "M", "--scope", "x", "--out", "y"]).status, 2, "no intent");
  assert.equal(run(["--tier", "M", "--wat", "1", ...good]).status, 2, "unknown flag");
  assert.equal(run(["--tier", "M", "--round", "0", ...good]).status, 2, "round 0");
  const missing = run(["--tier", "M", "--intent", path.join(dir, "nope.md"), "--scope", path.join(dir, "intent.md"), "--out", path.join(dir, "out")]);
  assert.equal(missing.status, 3);
  const traversal = path.join(dir, "plan.json");
  writeFileSync(traversal, JSON.stringify({ finders: [{ name: "../escaped", angles: ["A"], calls: 10, impact: "summary" }] }));
  const escaped = run(["--plan", traversal, "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "intent.md"), "--out", path.join(dir, "out", "briefs")]);
  assert.equal(escaped.status, 3, "a plan name that is a path, not a name, is refused");
  assert.ok(!existsSync(path.join(dir, "out", "escaped.md")), "and nothing is written outside --out");
  const badRound = path.join(dir, "round0.json");
  writeFileSync(badRound, JSON.stringify({ round: 0, finders: [{ name: "r0-a", angles: ["A"], calls: 10, impact: "summary" }] }));
  assert.equal(run(["--plan", badRound, "--intent", path.join(dir, "intent.md"), "--scope", path.join(dir, "intent.md"), "--out", path.join(dir, "out")]).status, 3, "a plan round is validated like --round");
  assert.match(missing.stderr, /cannot read the intent block/);
  assert.ok(!existsSync(path.join(dir, "out")), "a failed run leaves no half-written round behind");
});

test("--verify writes the verifier brief and prints its call under a guarded name", () => {
  const dir = workdir();
  mkdirSync(path.join(dir, "round-2"), { recursive: true });
  writeFileSync(path.join(dir, "intent.md"), "INTENT\nUser asked: \"fix it\"\n");
  writeFileSync(path.join(dir, "cands.json"), JSON.stringify([{ id: "r2-1", title: "x" }]));
  const lines = [];
  const [{ file }] = main(["--verify", path.join(dir, "cands.json"), "--work", dir, "--round", "2", "--batch", "3", "--live", dir],
    { log: (l) => lines.push(l), logDir: workdir() });
  assert.equal(lines.length, 1);
  const call = JSON.parse(lines[0].replace(/^Agent /, ""));
  assert.equal(call.name, "self-review-verifier-r2-b3", "the name tree-guard matches, never the registered type");
  assert.match(call.subagent_type, /^(self-review:)?self-review-verifier$/);
  assert.deepEqual({ model: call.model, effort: call.effort }, agentSettings("verifier"));
  assert.equal(call.prompt, `Read ${file} and follow it.`);
  const brief = readFileSync(file, "utf8");
  assert.match(brief, /^Verify these 1 candidate findings from round 2/);
  assert.match(brief, /fix it/);
  assert.match(brief, /"id": "r2-1"/);
  assert.ok(brief.includes(path.join(dir, "round-2", "state", "self-review-verifier-r2-b3.jsonl")));
  assert.ok(existsSync(path.join(dir, "round-2", "state")));

});

test("--verify splits more than 8 candidates into even numbered batches, one Agent line each", () => {
  const dir = workdir();
  const work = path.join(dir, "review-2");
  mkdirSync(path.join(work, "round-1"), { recursive: true });
  writeFileSync(path.join(work, "intent.md"), "INTENT\n");
  writeFileSync(path.join(dir, "cands.json"), JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: `r1-${i + 1}` }))));
  const lines = [];
  const logDir = workdir();
  const batches = main(["--verify", path.join(dir, "cands.json"), "--work", work, "--round", "1", "--live", dir], { log: (l) => lines.push(l), logDir });
  assert.match(lines[0], /^# 11 candidates, at most 8 per verifier: 2 batches — spawn every line in one message/);
  const calls = lines.slice(1).map((l) => JSON.parse(l.replace(/^Agent /, "")));
  assert.deepEqual(calls.map((c) => c.name), ["self-review-verifier-k2-r1-b1", "self-review-verifier-k2-r1-b2"],
    "the review number keeps a verifier's name unique in the session too");
  assert.deepEqual(batches.map((b) => b.name), calls.map((c) => c.name));
  const ids = batches.map(({ file }) => [...readFileSync(file, "utf8").matchAll(/"id": "(r1-\d+)"/g)].map((m) => m[1]));
  assert.deepEqual(ids.map((i) => i.length), [6, 5], "even, not 8 + 3");
  assert.deepEqual(ids.flat(), Array.from({ length: 11 }, (_, i) => `r1-${i + 1}`), "every candidate once, in order");
  assert.match(readFileSync(batches[1].file, "utf8"), /^Verify these 5 candidate findings/);

  // The split, kept past the scratchpad: one numbers-only row under the review's key.
  const rows = readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["candidates", "cwd", "firstBatch", "kind", "perAgent", "review", "round", "stage", "ts"]);
  assert.equal(rows[0].review, reviewFromWork(work));
  assert.deepEqual({ kind: rows[0].kind, round: rows[0].round, stage: rows[0].stage, candidates: rows[0].candidates, perAgent: rows[0].perAgent, firstBatch: rows[0].firstBatch },
    { kind: "units", round: 1, stage: "verify", candidates: 11, perAgent: [6, 5], firstBatch: 1 });
});

test("--verify with an unwritable log dir still writes every brief and prints every call", () => {
  const dir = workdir();
  mkdirSync(path.join(dir, "round-1"), { recursive: true });
  writeFileSync(path.join(dir, "intent.md"), "INTENT\n");
  writeFileSync(path.join(dir, "cands.json"), JSON.stringify([{ id: "r1-1" }]));
  // A directory under a regular file cannot be created, whoever runs this.
  const blocker = path.join(workdir(), "file");
  writeFileSync(blocker, "");
  const lines = [];
  const [{ file }] = main(["--verify", path.join(dir, "cands.json"), "--work", dir, "--round", "1", "--live", dir],
    { log: (l) => lines.push(l), logDir: path.join(blocker, "log") });
  assert.equal(lines.length, 1);
  assert.ok(existsSync(file));
});

test("the compact brief's cold-run section follows what the round planned", () => {
  // A compact row with nothing runnable planned no cold run, so saying one
  // "did not run" is false — and the reviewer filed that sentence as a finding.
  const compact = { name: "r1-compact", angles: ["compact"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "full" };
  const none = renderBrief(briefArgs({ row: compact, coldPlanned: false }));
  assert.doesNotMatch(none.text, /THE COLD RUN/, "nothing runnable, nothing missing");

  const skipped = renderBrief(briefArgs({ row: compact, coldPlanned: true, coldSkipped: "coldrun.sh failed — see /w/round-1/coldrun.err" }));
  assert.match(skipped.text, /No cold run this round \(coldrun\.sh failed — see \/w\/round-1\/coldrun\.err\)/);
  assert.match(skipped.text, /do not file it as a finding/);
  assert.match(skipped.text, /do not run the artifact/, "the skip is never made up for uncontained");

  const ran = renderBrief(briefArgs({ row: compact, cold: "/w/round-1/cold run/transcript.md" }));
  assert.match(ran.text, /THE COLD RUN \(already performed/);
});

test("writeBriefs reads the cold-run plan from tier.json, and keeps the section when the plan cannot say", () => {
  const dir = workdir();
  const row = { name: "r1-compact", angles: ["compact"], agent: "self-review-finder", model: "sonnet", effort: "high", calls: 40, impact: "full" };
  const write = (plan, sub) => {
    const [brief] = writeBriefs({
      plan: { round: 1, finders: [row], ...plan }, outDir: path.join(dir, sub), stateDir: path.join(dir, sub, "state"),
      angles, intent: "INTENT\n", scope: "/w/scope.diff", live: "/repo", impactText: "", prior: [], dismissed: [],
      config: budget, cold: "",
    });
    return readFileSync(brief.file, "utf8");
  };
  assert.doesNotMatch(write({ kinds: { executable: [] } }, "none"), /THE COLD RUN/);
  assert.match(write({ kinds: { executable: ["bin/x.sh"] }, coldSkipped: "the cold run executed nothing" }, "skipped"),
    /No cold run this round \(the cold run executed nothing\)/);
  assert.match(write({}, "unknown"), /No cold run this round \(no transcript was produced\)/, "a --tier plan has no kinds");
});
