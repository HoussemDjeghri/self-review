// Run: node --test plugin/scripts/tier.test.mjs   (or ./test.sh for everything)
// The shipped defaults are the fixture: these rules are only as good as the
// numbers and keyword lists config/defaults.json actually ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../hooks/lib/config.mjs";
import { parseDiff } from "./lib/diff.mjs";
import { buildFinders, classifyChanged, laterRound, measure, mergeToFit, pickTier, plan, riskMarkers, wireEvidence } from "./tier.mjs";
import { parseScope } from "./impact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "tier.mjs");
process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "tier-test-no-such-config.json");

const CONFIG = loadConfig();
const TIER = { ...CONFIG.tier, impactDepths: CONFIG.impact };
const EXEMPT = CONFIG.exempt;

const bundle = (files, diff = "") => [
  "# self-review scope",
  "# repo: /repo",
  "# branch: main   base: HEAD   generated: 2026-08-23T10:00:00Z",
  "",
  "## Changed files (git status, M=modified A=added D=deleted ?=untracked)",
  ...files.map((entry) => `  ${entry}`),
  "",
  "## Diff vs HEAD (tracked files, staged + unstaged)",
  diff,
].join("\n");

const hunk = (file, added = [], removed = []) => [
  `--- a/${file}`, `+++ b/${file}`, "@@ -1,4 +1,4 @@",
  ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`),
].join("\n");

const planFor = (files, diff, impact = null, over = {}) =>
  plan({ scope: parseScope(bundle(files, diff)), impact, config: TIER, exempt: EXEMPT, ...over });

const IMPACT = (over = {}) => ({
  adapter: "grep", counts: { caller_files: 0, broken: 0 }, untested: [], project_has_tests: true, symbols: [], graph: null, ...over,
});

// --- step 1 ----------------------------------------------------------------
test("executable surface: a file that declares itself runnable, not a directory that looks like it", () => {
  // The two live one directory apart in this very repo and only one of them is
  // a thing anyone invokes, which is why the question is asked of the file.
  // Paths are repo-root relative, and the plugin is a subdirectory of the repo.
  const files = [
    { path: "plugin/scripts/impact.mjs", status: "M" },   // shebang + execute bit
    { path: "plugin/scripts/lib/wire.mjs", status: "M" }, // a library beside it
    { path: "README.md", status: "M" },
  ];
  const withRoot = classifyChanged(files, TIER, EXEMPT, process.cwd());
  assert.deepEqual(withRoot.executable, ["plugin/scripts/impact.mjs"], "a shebang is the file saying it is an entry point");

  // No root to ask, or a file that is gone: fails closed to "not runnable" —
  // one missed finder, never a crashed plan.
  assert.deepEqual(classifyChanged(files, TIER, EXEMPT).executable, []);
  assert.deepEqual(classifyChanged([{ path: "plugin/scripts/deleted-yesterday.mjs", status: "D" }], TIER, EXEMPT, process.cwd()).executable, []);

  // What carries no shebang of its own is what the glob list is for.
  const globbed = classifyChanged([{ path: "package.json", status: "M" }, { path: "Makefile", status: "M" }], TIER, EXEMPT, "/nonexistent");
  assert.deepEqual(globbed.executable, ["Makefile", "package.json"], "code first, then config — kinds order, not diff order");
});

test("an extension never makes a file an entry point", () => {
  // `tier.executable` shipped `*.sh`, `*.bash` and `*.zsh`, which contradicted
  // the rule the list exists to serve: it is only for what CANNOT declare
  // itself. `scripts/lib/path.sh` says in its own second line "Sourced, never
  // executed", carries mode 644 and no shebang — and the glob claimed it
  // anyway, planning angle X for a change that touches nothing a user runs.
  assert.deepEqual(classifyChanged([{ path: "plugin/scripts/lib/path.sh", status: "M" }], TIER, EXEMPT, process.cwd()).executable, [],
    "a sourced-only library is not an entry point because of how it is spelled");
  // The runnable shell script beside it still is — by its own shebang.
  assert.deepEqual(classifyChanged([{ path: "plugin/scripts/coldrun.sh", status: "M" }], TIER, EXEMPT, process.cwd()).executable,
    ["plugin/scripts/coldrun.sh"]);
});

test("angle X is planned alone, and graded by an agent with no shell", () => {
  // Two review rounds in a row returned `wrong-layer` on the version of this
  // that asked a reviewer, in prose, to decide which invocation of unknown
  // code was safe to run. The property is held by the tool list now, which
  // means X can never share a finder with an angle that needs Bash — not at
  // tier M, where it used to ride inside C+E+F, and not in round 2's fold.
  const rowsOf = (over) => buildFinders({
    tier: "M", round: 1, markers: { security: [], auth: [], concurrency: [] },
    config: TIER, impactConfig: CONFIG.impact, compact: false,
    kinds: { code: ["cli.mjs"], docs: [], config: [], instructional: [], executable: ["cli.mjs"], asset: [], ignored: [] },
    ...over,
  }).finders;

  const x = rowsOf({}).find((row) => row.angles.includes("X"));
  assert.deepEqual(x.angles, ["X"], "alone, never merged into a group that needs a shell");
  assert.equal(x.agent, "self-review-cold-grader");
  for (const row of rowsOf({}).filter((row) => !row.angles.includes("X"))) {
    assert.equal(row.agent, "self-review-finder");
  }
  // And round 2, where it used to be appended to the second code row.
  const later = rowsOf({ round: 2 }).find((row) => row.angles.includes("X"));
  assert.deepEqual(later.angles, ["X"]);
  assert.equal(later.agent, "self-review-cold-grader");
});

test("a test fixture is not the product, however runnable it looks", () => {
  // This repository's own corpora hold a shebang'd, executable bin/publish.sh,
  // a Dockerfile and a package.json — and a bare glob matches by basename at
  // ANY depth, so editing one planned a Cold-run finder to go install and run
  // a wire-break fixture as if it were the plugin.
  const fixtures = [
    { path: "evals/corpora/bash-docs/base/bin/publish.sh", status: "M" },
    { path: "evals/corpora/config/base/Dockerfile", status: "M" },
    { path: "evals/corpora/js-cli/base/package.json", status: "M" },
  ];
  assert.deepEqual(classifyChanged(fixtures, TIER, EXEMPT, process.cwd()).executable, []);
  // The shipped entry point beside them still counts.
  assert.deepEqual(classifyChanged([{ path: "plugin/scripts/impact.mjs", status: "M" }], TIER, EXEMPT, process.cwd()).executable,
    ["plugin/scripts/impact.mjs"]);
});

test("a symlink is asked about itself, not about whatever it points at", () => {
  // stat follows the link, so an added `evil -> /etc/hostname` had its
  // TARGET's mode and first bytes inspected — a file outside the tree
  // answering a question about what ships. lstat, and fail closed.
  const root = mkdtempSync(path.join(tmpdir(), "sr-link-"));
  writeFileSync(path.join(root, "real.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  symlinkSync("/bin/sh", path.join(root, "points-away"));
  symlinkSync("real.sh", path.join(root, "points-inside"));

  const kinds = classifyChanged([
    { path: "real.sh", status: "M" }, { path: "points-away", status: "A" }, { path: "points-inside", status: "A" },
  ], { ...TIER, executable: [], executableExclude: [] }, EXEMPT, root);
  assert.deepEqual(kinds.executable, ["real.sh"], "only the file that is itself an entry point");
});

test("a plan row never aliases the angle list of the constant it came from", () => {
  // Spreading a row copies the reference to `angles`, so one `.push` onto a
  // plan row edits the module constant for every later call in the process.
  const first = laterRound(3, { code: ["a.ts"], docs: [], config: [], instructional: [], executable: [], asset: [], ignored: [] }, false);
  first[0].angles.push("MUTATED");
  const second = laterRound(3, { code: ["a.ts"], docs: [], config: [], instructional: [], executable: [], asset: [], ignored: [] }, false);
  assert.deepEqual(second[0].angles, ["compact"], "the second call must not inherit the first call's push");
});

test("angle X rides the verification finder, and only where there is something to run", () => {
  const kinds = (executable) => ({ code: ["a.ts"], docs: [], config: [], instructional: [], executable, asset: [], ignored: [] });
  const anglesOf = (rows) => rows.flatMap((row) => row.angles);

  const runnable = buildFinders({ tier: "M", round: 1, kinds: kinds(["deploy.sh"]), markers: { security: [], concurrency: [], auth: [] }, config: TIER, impactConfig: CONFIG.impact, compact: false });
  assert.ok(anglesOf(runnable.finders).includes("X"), "a changed entry point is reviewed by running it");
  const inert = buildFinders({ tier: "M", round: 1, kinds: kinds([]), markers: { security: [], concurrency: [], auth: [] }, config: TIER, impactConfig: CONFIG.impact, compact: false });
  assert.ok(!anglesOf(inert.finders).includes("X"), "nothing to run means no reviewer told to run it");

  // A fix is a new change and can break the cold run — but a round with no
  // entry point left in it must not carry an angle with no subject: a
  // reviewer with no subject reports a pass it did not earn.
  assert.ok(anglesOf(laterRound(2, kinds(["deploy.sh"]), false)).includes("X"));
  assert.ok(!anglesOf(laterRound(2, kinds([]), false)).includes("X"));
  assert.ok(!anglesOf(laterRound(3, kinds(["deploy.sh"]), false)).includes("X"), "round 3 is the shape question, not another sweep");
});

test("kinds: generated files are listed and never counted, instructional docs are flagged", () => {
  const kinds = classifyChanged([
    { path: "hooks/x.mjs", status: "M" }, { path: "README.md", status: "M" },
    { path: "skills/self-review/SKILL.md", status: "M" }, { path: "package-lock.json", status: "M" },
    { path: "dist/bundle.js", status: "M" }, { path: "docs/logo.png", status: "A" },
    { path: ".github/workflows/ci.yml", status: "M" },
  ], TIER, EXEMPT);
  assert.deepEqual(kinds.code, ["hooks/x.mjs"]);
  assert.deepEqual(kinds.docs, ["README.md", "skills/self-review/SKILL.md"]);
  assert.deepEqual(kinds.instructional, ["skills/self-review/SKILL.md"], "SKILL.md is instructions a model executes — that is angle P4");
  assert.deepEqual(kinds.config, [".github/workflows/ci.yml"]);
  assert.deepEqual(kinds.asset, ["docs/logo.png"]);
  assert.deepEqual(kinds.ignored, ["package-lock.json", "dist/bundle.js"]);
});

// --- step 3 ----------------------------------------------------------------
test("markers: paths and added lines fire them, context lines and prose do not", () => {
  const files = [{ path: "src/auth/login.ts", status: "M" }, { path: "README.md", status: "M" }];
  const diff = parseDiff([
    ...hunk("src/auth/login.ts", ["  const out = child_process.exec(cmd);"], ["  const out = safe(cmd);"]).split("\n"),
    ...hunk("README.md", ["Run `rm -rf build` to clean."]).split("\n"),
  ]);
  const kinds = classifyChanged(files, TIER, EXEMPT);
  const markers = riskMarkers({ files, diff, kinds, config: TIER, broken: 0 });
  assert.deepEqual(markers.auth, ["src/auth/login.ts (auth)"]);
  assert.equal(markers.security.length, 1);
  assert.match(markers.security[0], /^src\/auth\/login\.ts:1 child_process$/, "the marker quotes the line it fired on");
  assert.deepEqual(markers.destructive, [], "a README documenting rm -rf is not a destructive change");
  assert.deepEqual(markers.contractBreak, []);
  assert.deepEqual(riskMarkers({ files, diff, kinds, config: TIER, broken: 2 }).contractBreak, ["2 remaining references to a removed or renamed symbol"]);
});

test("markers: patterns match case-insensitively, and the prose false positive is the accepted cost", () => {
  // Case was tried as a discriminator and reverted (DESIGN §7.6): real code
  // writes SQL lowercase and security tokens camelCase, so matching literally
  // missed `drop table`, `truncate table` and `clientSecret` — and
  // markers.security/markers.concurrency are the only thing that spawns the
  // angle-G and angle-H finders. A miss costs a reviewer, a false positive
  // costs a tier bump, so this test pins the bump rather than the miss.
  const files = [{ path: "src/Auth/Login.ts", status: "M" }];
  const diff = parseDiff([
    ...hunk("src/Auth/Login.ts", [
      "  // truncate the summary when it is too long",
      '  await db.raw("drop table sessions;");',
      "  const w = new Worker(url);",
      "  const key = cfg.clientSecret;",
    ]).split("\n"),
  ]);
  const kinds = classifyChanged(files, TIER, EXEMPT);
  const markers = riskMarkers({ files, diff, kinds, config: TIER, broken: 0 });
  assert.deepEqual(markers.destructive, ["src/Auth/Login.ts:1 truncate", "src/Auth/Login.ts:2 drop"],
    "lowercase SQL fires, and so does the English sentence — the known cost of matching loosely");
  assert.deepEqual(markers.concurrency, ["src/Auth/Login.ts:2 await", "src/Auth/Login.ts:3 Worker"],
    "`new Worker(...)` fires the concurrency marker that spawns angle H");
  assert.deepEqual(markers.security, ["src/Auth/Login.ts:4 Secret"],
    "`cfg.clientSecret` fires the security marker that spawns angle G");
  assert.deepEqual(markers.auth, ["src/Auth/Login.ts (Auth)"],
    "a directory is the same directory whatever case it is spelled in");
});

test("markers: a config file gets no exemption, not even this tool's own word list", () => {
  // The round-8 invariant, after `tier.markerDeclaring` was deleted: config is
  // where destructive commands actually run, and no file can opt out of the
  // scan by claiming to be a word list. The known cost is the last assertion —
  // a false positive on this repo's own defaults, which raises a tier and never
  // hides one.
  const files = [{ path: "docker-compose.yml", status: "M" }, { path: "config/defaults.json", status: "M" }, { path: ".self-review.json", status: "A" }];
  const diff = parseDiff([
    ...hunk("docker-compose.yml", ["    command: rm -rf /data"]).split("\n"),
    ...hunk("config/defaults.json", ['      "destructive": ["rm -rf"]']).split("\n"),
    ...hunk(".self-review.json", ['  {"tier": {"riskContent": {"destructive": ["rm -rf"]}}}']).split("\n"),
  ]);
  const kinds = classifyChanged(files, TIER, EXEMPT);
  const markers = riskMarkers({ files, diff, kinds, config: TIER, broken: 0 });
  assert.deepEqual(markers.destructive, [
    "docker-compose.yml:1 rm -rf",
    "config/defaults.json:1 rm -rf",
    ".self-review.json:1 rm -rf",
  ], "every code- and config-kind file is scanned, including the tool's own config");
});

test("markers: a removed line that matched is not a marker — only added lines are", () => {
  const files = [{ path: "src/run.ts", status: "M" }];
  const diff = parseDiff(hunk("src/run.ts", ["  safe();"], ["  eval(input);"]).split("\n"));
  const markers = riskMarkers({ files, diff, kinds: classifyChanged(files, TIER, EXEMPT), config: TIER, broken: 0 });
  assert.deepEqual(markers.security, []);
});

// --- steps 2 and 4 ---------------------------------------------------------
test("metrics count changed lines per kind and ignore generated files", () => {
  const files = [{ path: "a.mjs", status: "M" }, { path: "b.md", status: "A" }, { path: "package-lock.json", status: "M" }];
  const kinds = classifyChanged(files, TIER, EXEMPT);
  const diff = parseDiff([...hunk("a.mjs", ["x", "y"], ["z"]).split("\n"), ...hunk("b.md", ["prose"]).split("\n"), ...hunk("package-lock.json", Array(400).fill("noise")).split("\n")]);
  const metrics = measure({ scope: { truncated: false }, files, diff, kinds, impact: null });
  assert.deepEqual(metrics.lines, { code: 3, docs: 1, config: 0 });
  assert.equal(metrics.files, 2, "a lockfile is not a changed file for tiering");
  assert.equal(metrics.newFiles, 1);
  assert.equal(metrics.callerFiles, null, "without impact.json the cross-file metrics are absent, not zero");
});

test("tier S: one small file, no marker, nothing references it", () => {
  const result = planFor(["M  src/copy.ts"], hunk("src/copy.ts", ["const LABEL = 'Save';"], ["const LABEL = 'save';"]), IMPACT());
  assert.equal(result.tier, "S");
  assert.equal(result.finders.length, 1);
  assert.deepEqual(result.finders[0].angles, ["compact"]);
  assert.equal(result.finders[0].impact, "full", "the one finder of a tier-S round gets the whole blast radius");
  assert.equal(result.verifier, "author");
});

test("tier S needs impact: without it the caller clause cannot be checked, so it stays M", () => {
  const result = planFor(["M  src/copy.ts"], hunk("src/copy.ts", ["const LABEL = 'Save';"], ["const LABEL = 'save';"]));
  assert.equal(result.tier, "M");
  assert.match(result.reasons.join(" "), /no impact\.json/);
});

test("tier S is refused when something still references the changed file", () => {
  const small = hunk("src/copy.ts", ["const LABEL = 'Save';"], ["const LABEL = 'save';"]);
  assert.equal(planFor(["M  src/copy.ts"], small, IMPACT({ counts: { caller_files: 2, broken: 0 } })).tier, "M");
  assert.equal(planFor(["A  src/new.ts"], small, IMPACT()).tier, "M", "a new file is never trivial");
});

test("tier L: each escalating rule fires on its own and says why", () => {
  const big = hunk("src/a.ts", Array.from({ length: 320 }, (_, i) => `const x${i} = ${i};`));
  assert.equal(planFor(["M  src/a.ts"], big, IMPACT()).tier, "L");
  const many = Array.from({ length: 9 }, (_, i) => `M  src/f${i}.ts`);
  assert.equal(planFor(many, hunk("src/f0.ts", ["x"]), IMPACT()).tier, "L");
  const auth = planFor(["M  src/session/token.ts"], hunk("src/session/token.ts", ["x"]), IMPACT());
  assert.equal(auth.tier, "L");
  assert.match(auth.reasons.join(" "), /auth: src\/session\/token\.ts/);
  const broken = planFor(["M  src/a.ts"], hunk("src/a.ts", ["x"]), IMPACT({ counts: { caller_files: 1, broken: 3 } }));
  assert.equal(broken.tier, "L");
  assert.match(broken.reasons.join(" "), /contractBreak/);
  const risky = planFor(["M  src/a.ts"], hunk("src/a.ts", ["x"]), IMPACT({ graph: { risk_score: 0.8 } }));
  assert.equal(risky.tier, "L");
  const wide = planFor(["M  src/a.ts"], hunk("src/a.ts", ["x"]), IMPACT({ counts: { caller_files: 25, broken: 0 } }));
  assert.equal(wide.tier, "L");
});

// --- the wire marker -------------------------------------------------------
// It is gated on consumers FOUND, not on a wire contract having changed:
// otherwise every route edit escalates and the marker means nothing.
const WIRE = (over = {}) => IMPACT({
  wire: {
    tokens: [{ key: "/api/users/*", value: "/api/users/:id", verb: "GET", to: "/api/v2/users/*", state: "renamed", file: "server/routes.ts" }],
    references: [{ token: "/api/users/*", file: "web/src/api/users.ts", line: 14, kind: "code", generated: false }],
    ...over,
  },
});

test("wireEvidence quotes the contract and the consumer that still names it", () => {
  assert.deepEqual(wireEvidence(WIRE()),
    ["GET /api/users/:id → /api/v2/users/*, still named at web/src/api/users.ts:14"]);
  assert.deepEqual(wireEvidence(WIRE({ tokens: [{ key: "/api/orders/*", value: "/api/orders/:id", verb: "POST", to: null, state: "removed", file: "server/routes.ts" }], references: [{ token: "/api/orders/*", file: "web/o.ts", line: 3, kind: "code", generated: false }] })),
    ["POST /api/orders/:id (removed), still named at web/o.ts:3"]);
});

test("a wire contract with no live consumer is not evidence — it is a question for the finder", () => {
  assert.deepEqual(wireEvidence(WIRE({ references: [] })), [], "zero consumers is unknown, not a marker");
  assert.deepEqual(wireEvidence(WIRE({ references: [{ token: "/api/users/*", file: "docs/api.md", line: 2, kind: "docs", generated: false }] })), [],
    "a mention in a doc is not a caller");
  assert.deepEqual(wireEvidence(WIRE({ references: [{ token: "/api/users/*", file: "web/__generated__/client.ts", line: 8, kind: "code", generated: true }] })), [],
    "a generated client is a regenerate, not a break");
  assert.deepEqual(wireEvidence(IMPACT()), [], "an impact.json from before this feature");
});

test("wireBreak escalates to L on its own, separately from contractBreak", () => {
  const result = planFor(["M  server/routes.ts"], hunk("server/routes.ts", ["x"]), WIRE());
  assert.equal(result.tier, "L");
  assert.match(result.reasons.join(" "), /wireBreak/);
  assert.deepEqual(result.markers.contractBreak, [], "a string over a wire is not a symbol reference");
  assert.match(result.markers.wireBreak.join(" "), /web\/src\/api\/users\.ts:14/);
  assert.equal(planFor(["M  server/routes.ts"], hunk("server/routes.ts", ["x"]), WIRE({ references: [] })).tier, "S",
    "a route edit nothing calls does not buy six finders");
});

test("a truncated scope is L and says it must be split", () => {
  const scope = parseScope(`${bundle(["M  src/a.ts"], hunk("src/a.ts", ["x"]))}\n# TRUNCATED: 9000 lines total, showing 6000.`);
  const result = plan({ scope, impact: IMPACT(), config: TIER, exempt: EXEMPT });
  assert.equal(result.tier, "L");
  assert.equal(result.split, true);
});

test("a new code file with no test in a tested project is L, not M", () => {
  const impact = IMPACT({ symbols: [{ name: "handler", file: "src/new.ts", test_refs: 0 }], project_has_tests: true });
  const result = planFor(["A  src/new.ts", "M  src/old.ts"], hunk("src/new.ts", ["export function handler() {}"]), impact);
  assert.equal(result.tier, "L");
  assert.match(result.reasons.join(" "), /new untested file: src\/new\.ts/);
  const tested = IMPACT({ symbols: [{ name: "handler", file: "src/new.ts", test_refs: 2 }], project_has_tests: true });
  assert.equal(planFor(["A  src/new.ts", "M  src/old.ts"], hunk("src/new.ts", ["export function handler() {}"]), tested).tier, "M");
});

// --- step 5 ----------------------------------------------------------------
test("tier M round 1: the SKILL.md §2a groups, security only when the marker fired", () => {
  const result = planFor(["M  src/a.ts", "M  src/b.ts"], hunk("src/a.ts", ["const x = 1;"]), IMPACT());
  assert.deepEqual(result.finders.map((f) => f.angles), [["A", "B", "D"], ["C", "E", "F"], ["Q", "V"]]);
  assert.deepEqual(result.finders.map((f) => f.impact), ["summary", "full", "summary"]);
  assert.deepEqual(result.merged, []);
  const secure = planFor(["M  src/a.ts", "M  src/b.ts"], hunk("src/a.ts", ["const r = fetch(url);"]), IMPACT());
  assert.deepEqual(secure.finders.at(-1).angles, ["G"]);
  const async_ = planFor(["M  src/a.ts", "M  src/b.ts"], hunk("src/a.ts", ["await queue.push(x);"]), IMPACT());
  assert.deepEqual(async_.finders[1].angles, ["C", "E", "F", "H"], "concurrency joins the cross-file finder at M");
});

test("mixed kinds merge within a kind to fit the cap, and no kind is dropped", () => {
  const files = ["M  src/a.ts", "M  src/b.ts", "M  README.md", "M  skills/self-review/SKILL.md", "M  config/app.yml"];
  const result = planFor(files, hunk("src/a.ts", ["const r = fetch(url);"]), IMPACT());
  assert.equal(result.tier, "M");
  assert.ok(result.finders.length <= TIER.finders.maxPerRound);
  assert.deepEqual(result.merged, [["G", "into", "Q+V"]]);
  assert.deepEqual(result.finders.find((f) => f.angles.includes("G")).angles, ["G", "Q", "V"]);
  assert.equal(result.finders.find((f) => f.angles.includes("G")).name, "r1-gqv");
  for (const kind of ["code", "docs", "config"]) {
    assert.ok(result.finders.some((f) => f.kind === kind), `${kind} kept a finder`);
  }
  assert.ok(result.finders.some((f) => f.angles.includes("P4")), "an instructional doc turns P4 on");
});

test("a CI or IaC change is L on its own: infra is an escalating marker", () => {
  const result = planFor(["M  .github/workflows/ci.yml"], hunk(".github/workflows/ci.yml", ["  - run: ./deploy.sh"]), IMPACT());
  assert.equal(result.tier, "L");
  assert.match(result.reasons.join(" "), /infra: \.github\/workflows/);
});

test("merging never crosses kinds and stops as soon as the round fits", () => {
  const rows = [
    { group: "A+B+D", angles: ["A", "B", "D"], kind: "code" },
    { group: "Q+V", angles: ["Q", "V"], kind: "code" },
    { group: "G", angles: ["G"], kind: "code" },
    { group: "P1+P3", angles: ["P1", "P3"], kind: "docs" },
  ];
  assert.deepEqual(mergeToFit(rows, "M", 4).merged, [], "a round that already fits is not merged");
  const merged = mergeToFit(rows, "M", 3);
  assert.deepEqual(merged.merged, [["G", "into", "Q+V"]]);
  assert.equal(merged.rows.length, 3);
  const docsOnly = mergeToFit([{ group: "P2+V", angles: ["P2", "V"], kind: "docs" }, { group: "G", angles: ["G"], kind: "code" }], "M", 1);
  assert.deepEqual(docsOnly.merged, [], "there is no same-kind target, so nothing merges");
});

test("tier L round 1: split groups, opus on the security and concurrency finders", () => {
  const diff = [hunk("src/a.ts", ["const r = fetch(url);", "await r.json();"]), hunk("src/b.ts", Array.from({ length: 320 }, (_, i) => `const x${i} = ${i};`))].join("\n");
  const result = planFor(["M  src/a.ts", "M  src/b.ts"], diff, IMPACT());
  assert.equal(result.tier, "L");
  assert.equal(result.verifier, "agent");
  assert.equal(result.roundsCap, 6);
  assert.deepEqual(result.finders.map((f) => f.angles), [["A", "B"], ["C", "D"], ["E", "F"], ["Q", "V"], ["G"], ["H"]]);
  assert.deepEqual(result.finders.filter((f) => f.model === "opus").map((f) => f.angles), [["G"], ["H"]]);
});

test("round 2 is at most two finders, plus the cold grader; round 3 adds the finder that may say no", () => {
  const kinds = { code: ["a.ts"], docs: ["README.md"], config: ["ci.yml"], instructional: [], executable: [], asset: [], ignored: [] };
  const second = laterRound(2, kinds, false);
  assert.equal(second.length, 2);
  assert.ok(second.some((row) => row.kind === "docs" && row.angles.includes("K1")), "config folds into the nearest finder");
  assert.deepEqual(laterRound(3, kinds, false).map((row) => row.angles), [["compact"], ["S"]],
    "two rounds of fixes did not settle it, so one reviewer stops hunting defects and asks whether the shape is right");
  assert.deepEqual(laterRound(1, kinds, true).map((row) => row.angles), [["compact"]],
    "--compact is a narrowed round by hand, not evidence of a design problem");
  const codeOnly = laterRound(2, { code: ["a.ts"], docs: [], config: [], instructional: [], executable: [], asset: [], ignored: [] }, false);
  assert.deepEqual(codeOnly.map((row) => row.angles), [["A", "B", "D", "Q", "V"], ["C", "E", "F", "G", "H"]]);
});

test("X is added to the round-2 budget, not taken out of it", () => {
  // Its own presence used to trigger the fold: `rows.length > 2` counted the
  // cold row, so a code-and-script change with no docs collapsed the two
  // 5-angle code finders into one 10-angle finder. The round that ships
  // something runnable got the least attention per angle.
  const k = (over) => ({ code: [], docs: [], config: [], instructional: [], executable: [], asset: [], ignored: [], ...over });

  const withScript = laterRound(2, k({ code: ["a.ts"], executable: ["a.sh"] }), false);
  assert.deepEqual(withScript.map((row) => row.angles), [["A", "B", "D", "Q", "V"], ["C", "E", "F", "G", "H"], ["X"]],
    "the two code finders survive; X is the third");

  // The cap on non-cold rows still holds — X buys nothing else a pass.
  const withDocs = laterRound(2, k({ code: ["a.ts"], docs: ["README.md"], executable: ["a.sh"] }), false);
  assert.equal(withDocs.filter((row) => row.angles[0] !== "X").length, 2, "still at most two ordinary finders");
  assert.deepEqual(withDocs.at(-1).angles, ["X"]);
});

test("the config angles never land on the grader that has no shell", () => {
  // With no docs row, the fold used to pick `rows[rows.length - 1]` — the X
  // row — and push K1,K2 onto it. That made `isColdGrader` false, so X was
  // spawned as an ordinary finder WITH Bash, holding a brief that told it the
  // run had already happened and it had no shell. The one row that must never
  // host another angle was the default host.
  const noDocs = { code: ["a.ts"], docs: [], config: ["ci.yml"], instructional: [], executable: ["bin/ship"], asset: [], ignored: [] };
  for (const round of [2, 3]) {
    const { finders } = buildFinders({
      tier: "M", round, kinds: noDocs, markers: { security: [], concurrency: [], auth: [] },
      config: TIER, impactConfig: CONFIG.impact, compact: false,
    });
    const cold = finders.filter((f) => f.agent === "self-review-cold-grader");
    assert.equal(cold.length, round === 2 ? 1 : 0, `round ${round}: X runs on the sweep rounds only`);
    for (const f of cold) assert.deepEqual(f.angles, ["X"], "the grader hosts nothing else");
    // Round 3 is the shape round — one compact reviewer and `S`, no config
    // fold to get wrong. Round 2 is the round that folds, and so the round
    // that used to hand K1,K2 to the grader.
    const host = finders.find((f) => f.angles.includes("K1"));
    if (round === 2) {
      assert.ok(host, "the config angles are still covered");
      assert.notEqual(host.agent, "self-review-cold-grader");
    }
  }
});

test("impact depth follows the angles, and the call budget follows the kind", () => {
  const { finders } = buildFinders({
    tier: "M", round: 1,
    kinds: { code: ["a.ts"], docs: ["README.md"], config: ["ci.yml"], instructional: [], executable: [], asset: [], ignored: [] },
    markers: { security: [], concurrency: [], auth: [] }, config: TIER, impactConfig: CONFIG.impact, compact: false,
  });
  const byName = Object.fromEntries(finders.map((row) => [row.angles.join(""), row]));
  assert.equal(byName.ABD.impact, "summary");
  assert.equal(byName.CEF.impact, "full");
  assert.equal(byName.P1P3.impact, "docs");
  assert.equal(byName.K1K2.impact, "docs");
  assert.equal(byName.ABD.calls, TIER.finders.callsCode);
  assert.equal(byName.P1P3.calls, TIER.finders.callsDocs);
  assert.ok(finders.every((row) => row.weightFixLines === true));
});

test("a ceiling holds down growth, but never a risk marker that has just fired", () => {
  // The ceiling is a tier-vs-tier comparison, and a tier is a scalar: it cannot
  // tell "the cumulative diff got longer" (what the cap exists for) from "the
  // fix became dangerous". A round-2 patch that first touches auth/, or first
  // adds a DROP TABLE, reaches L through pickTier's escalating list — and
  // capping it to S would silently drop the opus security finder that marker
  // exists to force. Every other --cap test uses a marker-free fixture, which
  // is exactly how this survived.
  const danger = planFor(["M  src/auth/session.mjs"], hunk("src/auth/session.mjs", ["const t = 1;"]),
    IMPACT(), { round: 2, cap: "S", capMarkers: [] });
  assert.equal(danger.tier, "L", "auth fired for the first time: the ceiling yields");
  assert.equal(danger.cappedTo, null);
  assert.deepEqual(danger.capLifted, ["auth"]);
  assert.match(danger.reasons[0], /^ceiling S lifted: auth fired for the first time/);
  assert.ok(danger.finders.some((row) => row.angles.includes("G")), "and the security finder is bought");

  // A marker round 1 already had is not news, so the ceiling still binds:
  // otherwise every round of an auth change would ratchet, which is the bug.
  const known = planFor(["M  src/auth/session.mjs"], hunk("src/auth/session.mjs", ["const t = 1;"]),
    IMPACT(), { round: 2, cap: "S", capMarkers: ["auth"] });
  assert.equal(known.tier, "S");
  assert.equal(known.cappedTo, "S");
  assert.equal(known.capLifted, null);
});

// --- CLI -------------------------------------------------------------------
const workdir = () => mkdtempSync(path.join(tmpdir(), "tier-"));
function run(args, files = ["M  src/a.ts", "M  src/b.ts"], diff = hunk("src/a.ts", ["const x = 1;"])) {
  const dir = workdir();
  const scope = path.join(dir, "scope.diff");
  writeFileSync(scope, bundle(files, diff));
  const result = spawnSync(process.execPath, [SCRIPT, "--scope", scope, "--out", dir, ...args], { encoding: "utf8" });
  return { ...result, dir, scope };
}

test("CLI: tier.json is written and stdout stays inside eight lines", () => {
  const big = [hunk("src/a.ts", ["const r = fetch(url);", "await r.json();"]), hunk("src/b.ts", Array.from({ length: 320 }, (_, i) => `const x${i} = ${i};`))].join("\n");
  const result = run([], ["M  src/a.ts", "M  src/b.ts", "M  README.md"], big);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length <= 8, `eight lines is the budget, got ${lines.length}`);
  assert.match(lines[0], /^tier L · round 1/);
  assert.match(lines.at(-1), /^verifier: agent · rounds cap 6/);
  const written = JSON.parse(readFileSync(path.join(result.dir, "tier.json"), "utf8"));
  assert.equal(written.schema, 1);
  assert.equal(written.tier, "L");
  assert.equal(written.impactAdapter, null);
});

test("CLI: lowering the tier is possible, unauditable lowering is not", () => {
  const forced = run(["--force", "S", "--reason", "one comment, reviewed by hand"]);
  assert.equal(forced.status, 0, forced.stderr);
  const written = JSON.parse(readFileSync(path.join(forced.dir, "tier.json"), "utf8"));
  assert.equal(written.tier, "S");
  assert.equal(written.forced, "S");
  assert.equal(written.computed, "M", "an override records what the rules said, so a forced-down review is countable");
  assert.equal(written.reason, "one comment, reviewed by hand");
  assert.match(written.reasons[0], /^forced S: one comment/);
  assert.match(forced.stdout, /tier S \(forced\)/);
  assert.equal(run(["--force", "S"]).status, 2, "--force without --reason is a usage error");
  assert.equal(run(["--force", "X", "--reason", "x"]).status, 2);
  assert.equal(run(["--reason", "x"]).status, 2);
});

test("CLI: --cap holds a later round at round 1's tier, and is not a --force", () => {
  // The default fixture is two files, which the rules put at M. A round that
  // only inherited a ceiling must still record what the rules said — the whole
  // point is that the ratchet is visible, not hidden behind a forced tier.
  const held = run(["--round", "2", "--cap", "S"]);
  assert.equal(held.status, 0, held.stderr);
  const written = JSON.parse(readFileSync(path.join(held.dir, "tier.json"), "utf8"));
  assert.equal(written.tier, "S");
  assert.equal(written.cappedTo, "S");
  assert.equal(written.forced, null, "a ceiling is not an override");
  assert.equal(written.computed, "M");
  assert.match(written.reasons[0], /^held at S: round 1 tiered the change S/);
  assert.match(held.stdout, /tier S \(held\) · round 2/);

  // A cap above what the rules computed changes nothing and claims nothing.
  const loose = JSON.parse(readFileSync(path.join(run(["--round", "2", "--cap", "L"]).dir, "tier.json"), "utf8"));
  assert.equal(loose.tier, "M");
  assert.equal(loose.cappedTo, null);

  assert.equal(run(["--cap", "X"]).status, 2, "a cap that is not a tier is a usage error");
  assert.equal(run(["--cap", "S", "--cap-markers", "nonsense"]).status, 2, "an unknown marker name is a usage error, not a silent no-op");
  // round.sh hands over every marker round 1 fired, and two of the eight do not
  // escalate: validating against the escalating list alone made the flag
  // unusable by its only caller the first time it was passed for real.
  assert.equal(run(["--cap", "S", "--cap-markers", "security,concurrency"]).status, 0, "a non-escalating marker is still a marker");
  assert.equal(run(["--cap-markers", "auth"]).status, 2, "--cap-markers belongs to --cap");
});

test("CLI: a missing scope is exit 3, a missing flag is exit 2", () => {
  const dir = workdir();
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--scope", "/no/such/file", "--out", dir], { encoding: "utf8" }).status, 3);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--out", dir], { encoding: "utf8" }).status, 2);
  assert.equal(run(["--round", "0"]).status, 2);
});

test("the plan brief.mjs is handed carries every field brief.mjs requires", () => {
  const result = run([], ["M  src/a.ts", "M  src/b.ts", "M  README.md", "M  .github/workflows/ci.yml"]);
  const written = JSON.parse(readFileSync(path.join(result.dir, "tier.json"), "utf8"));
  const briefs = path.join(result.dir, "briefs");
  const intent = path.join(result.dir, "intent.md");
  writeFileSync(intent, "INTENT\nUser asked: \"x\"\n");
  const brief = spawnSync(process.execPath, [path.join(HERE, "brief.mjs"),
    "--plan", path.join(result.dir, "tier.json"), "--intent", intent, "--scope", result.scope, "--out", briefs,
  ], { encoding: "utf8" });
  assert.equal(brief.status, 0, brief.stderr);
  assert.equal(brief.stdout.trim().split("\n").length, written.finders.length + 1);
  for (const row of written.finders) {
    assert.match(readFileSync(path.join(briefs, `${row.name}.md`), "utf8"), /YOUR ANGLE/);
  }
});


// The measured regression these two tests exist for: a 2-line tier-S change
// whose round-1 fix added a 24-line test file recomputed as tier M in round 2
// and spawned two finders where round 1 had spent one. Fixing a finding well
// must not cost more than finding it.
test("round 2 is held at the tier round 1 gave the change", () => {
  // The real shape from the 2026-08-29 smoke: a 2-line edit, then a 24-line
  // test file the loop itself wrote to fix round 1's finding.
  const scope = parseScope(bundle(["M  src/cli.mjs", "A  test/cli.test.mjs"],
    [hunk("src/cli.mjs", ["a", "b"]), hunk("test/cli.test.mjs", Array.from({ length: 24 }, (_, i) => `line ${i}`))].join("\n")));
  const loose = plan({ scope, impact: IMPACT(), round: 2, config: TIER, exempt: EXEMPT });
  assert.equal(loose.computed, "M", "the cumulative scope really does compute M");
  assert.equal(loose.finders.length, 2, "and that is what used to buy two finders");

  const held = plan({ scope, impact: IMPACT(), round: 2, cap: "S", config: TIER, exempt: EXEMPT });
  assert.equal(held.tier, "S");
  assert.equal(held.cappedTo, "S");
  assert.equal(held.computed, "M", "what the rules computed is still recorded");
  assert.equal(held.finders.length, 1, "a tier-S review spends one finder in every round");
  assert.match(held.reasons[0], /held at S/);

  // Round 3 is where the rule used to break: laterRound checked `round >= 3`
  // before it checked compact, so shape bought a whole second reviewer.
  const third = plan({ scope, impact: IMPACT(), round: 3, cap: "S", config: TIER, exempt: EXEMPT });
  assert.equal(third.finders.length, 1, "still one at round 3");
  assert.deepEqual(third.finders[0].angles, ["compact", "S"], "shape rides along in the compact brief, it does not buy an agent");
});

test("a cap that --force overrode is not recorded as a hold", () => {
  // Otherwise tier.json reads "forced to L" and "held at S" at the same time,
  // and an auditor cannot tell which one decided the round.
  const scope = parseScope(bundle(["M  src/cli.mjs", "A  test/cli.test.mjs"],
    [hunk("src/cli.mjs", ["a", "b"]), hunk("test/cli.test.mjs", Array.from({ length: 24 }, (_, i) => `line ${i}`))].join("\n")));
  const forced = plan({ scope, impact: IMPACT(), round: 2, cap: "S", force: "L", reason: "the fix restructured the parser", config: TIER, exempt: EXEMPT });
  assert.equal(forced.tier, "L");
  assert.equal(forced.cappedTo, null, "the cap never bound");
});

test("--cap never raises a tier, and --force still beats it", () => {
  const scope = parseScope(bundle(["M  src/cli.mjs"], hunk("src/cli.mjs", ["a", "b"])));
  const up = plan({ scope, impact: IMPACT(), round: 2, cap: "L", config: TIER, exempt: EXEMPT });
  assert.equal(up.tier, "S", "a cap is a ceiling, not a floor");
  assert.equal(up.cappedTo, null);

  const forced = plan({ scope, impact: IMPACT(), round: 2, cap: "S", force: "L", reason: "the fix restructured the parser", config: TIER, exempt: EXEMPT });
  assert.equal(forced.tier, "L", "raising a round deliberately outranks the cap");
});

// --- F2 (also): one line when a single directory dominates the change --------
test("F2: a directory holding most of the changed lines gets a note, not a refusal", () => {
  // The generic form of round.sh's paperwork refusal: a vendored tree, a
  // generated bundle or an old review's notes dominating a scope is almost
  // never the change under review — and it is the tier the reviewer pays for.
  // A note, because unlike the paperwork signature this shape is guesswork.
  const bulk = Array.from({ length: 1200 }, (_, i) => `line ${i}`);
  const dominated = planFor(
    ["?? scratchpad/notes.md", "  M src/app.mjs"],
    [hunk("scratchpad/notes.md", bulk), hunk("src/app.mjs", ["one", "two"])].join("\n"),
  );
  const note = dominated.notes.find((line) => line.includes("scratchpad/"));
  assert.match(note, /^note: 1,200 of 1,202 changed lines are under scratchpad\/ — if that is not the change, narrow the scope$/);
});

test("F2: the note stays quiet on a small change, and on a spread-out one", () => {
  const small = planFor(["  M src/app.mjs"], hunk("src/app.mjs", ["one", "two"]));
  assert.deepEqual(small.notes, [], "under the 1,000-line floor, however dominant");

  const bulk = (n) => Array.from({ length: n }, (_, i) => `line ${i}`);
  const spread = planFor(
    ["  M a/one.mjs", "  M b/two.mjs"],
    [hunk("a/one.mjs", bulk(900)), hunk("b/two.mjs", bulk(900))].join("\n"),
  );
  assert.deepEqual(spread.notes, [], "no single directory holds 60 % of it");
});

test("F2: a file at the repository root is never reported as a dominant directory", () => {
  const huge = planFor(["  M big.mjs"], hunk("big.mjs", Array.from({ length: 1500 }, (_, i) => `line ${i}`)));
  assert.deepEqual(huge.notes, [], "'./' is not a directory a user can narrow to");
});
