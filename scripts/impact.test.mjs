// Run: node --test plugin/scripts/impact.test.mjs   (or ./test.sh for everything)
// The grep engine is exercised for real against a temp tree; code-review-graph
// is a stub binary on PATH (DESIGN §7 decision 4 — no committed index).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyse, changedSymbols, chooseEngine, collectReferences, definitionsIn, fileSymbols,
  main, normaliseLimits, parseHits, parseScope, parseStatusLine, rankSymbols, renderMarkdown, searchArgs, symbolPatterns,
} from "./impact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "impact.mjs");
process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "impact-test-no-such-config.json");

const CONFIG = {
  adapter: "auto", timeoutSec: 20, maxSymbols: 30, maxRefsPerSymbol: 200, maxLines: 80,
  minSymbolLength: 3, stopWords: ["run", "config"], exclude: ["node_modules", "*.min.*"],
  exempt: { extensions: [".md", ".json", ".yml"], names: ["readme"] },
};

const scopeBundle = (root, files, diff) => [
  "# self-review scope",
  `# repo: ${root}`,
  "# branch: main   base: HEAD   generated: 2026-08-23T10:00:00Z",
  "",
  "## Changed files (git status, M=modified A=added D=deleted ?=untracked)",
  ...files,
  "",
  "## Diff vs HEAD (tracked files, staged + unstaged)",
  diff,
  "",
  "## Untracked files (rendered as full additions)",
  "",
].join("\n");

test("the scope bundle is parsed, not re-derived from git", () => {
  const scope = parseScope(scopeBundle("/repo", ["  M  a/b.mjs", "  ?? new.mjs", "  R  old.mjs -> renamed.mjs"], "@@ -1 +1 @@\n-x\n+y"));
  assert.equal(scope.plain, false);
  assert.equal(scope.repos.length, 1);
  assert.equal(scope.repos[0].root, "/repo");
  assert.equal(scope.repos[0].base, "HEAD");
  assert.deepEqual(scope.repos[0].files, [
    { path: "a/b.mjs", status: "M" }, { path: "new.mjs", status: "?" },
    // The old path is kept: for a file-system router it is the contract that
    // was removed, and the only thing worth searching the tree for.
    { path: "renamed.mjs", status: "R", from: "old.mjs" },
  ]);
  assert.deepEqual(scope.repos[0].diff, ["@@ -1 +1 @@", "-x", "+y", "", ""]);
});

test("a truncated scope and a plain (non-git) scope are both recognised", () => {
  assert.equal(parseScope("# self-review scope\n# repo: /r\n\n# TRUNCATED: 9000 lines total, showing 6000.").truncated, true);
  const plain = parseScope("# self-review scope (not a git repo — full file contents)\n# generated: x\n");
  assert.equal(plain.plain, true);
  assert.deepEqual(plain.repos, []);
});

test("a status line survives the porcelain spellings scope.sh produces", () => {
  assert.deepEqual(parseStatusLine("   M hooks/x.mjs"), { path: "hooks/x.mjs", status: "M" });
  assert.deepEqual(parseStatusLine("  MM hooks/x.mjs"), { path: "hooks/x.mjs", status: "M" });
  assert.deepEqual(parseStatusLine("  ?? new file.mjs"), { path: "new file.mjs", status: "?" });
  assert.deepEqual(parseStatusLine('  A  "weird\\"name.mjs"'), { path: 'weird"name.mjs', status: "A" });
  assert.equal(parseStatusLine("## Diff vs HEAD"), null);
});

test("definitions are read per language, and an indented JS const is a local, not a definition", () => {
  assert.deepEqual(definitionsIn("export function loadConfig(a) {", ".mjs"), [{ name: "loadConfig", kind: "function" }]);
  assert.deepEqual(definitionsIn("const LOG_DIR = 1;", ".mjs"), [{ name: "LOG_DIR", kind: "const" }]);
  assert.deepEqual(definitionsIn("  const local = 1;", ".mjs"), [], "a nested const would make every local a search term");
  assert.deepEqual(definitionsIn("export { alpha, beta as gamma };", ".mjs").map((d) => d.name), ["alpha", "beta"]);
  assert.deepEqual(definitionsIn("    def method(self):", ".py"), [{ name: "method", kind: "def" }], "python methods are indented");
  assert.deepEqual(definitionsIn("func (s *Server) Serve() {", ".go"), [{ name: "Serve", kind: "func" }]);
  assert.deepEqual(definitionsIn("    pub fn parse(x: u8) {", ".rs"), [{ name: "parse", kind: "fn" }]);
  assert.deepEqual(definitionsIn("emit_git() {", ".sh"), [{ name: "emit_git", kind: "func" }]);
  assert.deepEqual(definitionsIn("  return helper(x);", ".java"), [], "a return statement is not a method declaration");
  assert.deepEqual(definitionsIn("anything at all", ".xyz"), [], "an unknown language contributes no symbols");
});

const DIFF = `
--- a/lib/thing.mjs
+++ b/lib/thing.mjs
@@ -1,6 +1,6 @@ export function outer(a) {
-export function mergeInto(a, b) {
-  return a;
+export function mergeAll(a, b) {
+  return b;
 }
-const GONE = 1;
+const KEPT = 2;
@@ -20,2 +20,3 @@
+export function brandNew() {}
`.trim().split("\n");

test("symbol state: renamed, added, removed, and the enclosing name from the hunk header", () => {
  const symbols = Object.fromEntries(changedSymbols(DIFF).map((s) => [s.name, s]));
  assert.equal(symbols.mergeInto.state, "renamed", "a - definition beside a + definition in one hunk is a rename");
  assert.equal(symbols.mergeAll.state, "added");
  assert.equal(symbols.GONE.state, "renamed", "GONE/KEPT are also a - and a + in the same hunk");
  assert.equal(symbols.brandNew.state, "added");
  assert.equal(symbols.outer.state, "changed", "the @@ … @@ trailer names the enclosing definition");
  assert.equal(symbols.mergeInto.file, "lib/thing.mjs");
  assert.ok(symbols.mergeInto.weight > 0, "weight is the changed lines of the defining hunk");
});

test("a definition removed with nothing added beside it is removed, not renamed", () => {
  const diff = ["--- a/x.mjs", "+++ b/x.mjs", "@@ -1,3 +1,1 @@", "-export function dropped() {}", " keep"];
  assert.equal(changedSymbols(diff)[0].state, "removed");
});

test("a deleted file is a removed symbol under its own name", () => {
  assert.deepEqual(fileSymbols([{ path: "scripts/old.sh", status: "D" }]), [
    { name: "old.sh", kind: "file", file: "scripts/old.sh", state: "removed", weight: 0 },
  ]);
});

test("ranking: stop words and short names go, file names keep their own budget, --symbol always survives", () => {
  const defined = [
    { name: "run", kind: "const", file: "a.mjs", state: "changed", weight: 9 },
    { name: "ab", kind: "const", file: "a.mjs", state: "changed", weight: 9 },
    { name: "loadConfig", kind: "function", file: "a.mjs", state: "changed", weight: 5 },
    { name: "other", kind: "function", file: "a.mjs", state: "changed", weight: 7 },
  ];
  const files = [{ name: "a.mjs", kind: "file", file: "a.mjs", state: "changed", weight: 0 }];
  const ranked = rankSymbols(defined, files, { ...CONFIG, maxSymbols: 2 });
  assert.deepEqual(ranked.map((s) => s.name), ["other", "loadConfig", "a.mjs"], "the cap applies to defined symbols; the file name is not squeezed out");
  const forced = rankSymbols(defined, files, { ...CONFIG, maxSymbols: 1 }, ["run", "nowhere"]);
  assert.ok(forced.some((s) => s.name === "run"), "--symbol overrides the stop list");
  assert.ok(forced.some((s) => s.name === "nowhere" && s.kind === "given"), "--symbol can name a symbol the diff does not define");
});

test("search arguments are engine-specific, and every engine gets the exclusions", () => {
  const rg = searchArgs("rg", ["alpha"], ["node_modules"], { fixed: true });
  assert.equal(rg.command, "rg");
  assert.ok(rg.args.includes("--hidden"), "config lives in dot-directories; rg skips them by default");
  assert.ok(rg.args.join(" ").includes("!node_modules"));
  assert.ok(rg.args.includes("-F") && rg.args.includes("-w"));
  const git = searchArgs("git", ["alpha"], ["node_modules"], { fixed: false });
  assert.deepEqual(git.args.slice(0, 6), ["grep", "-n", "-I", "--no-color", "--untracked", "-E"]);
  assert.ok(git.args.includes(":!node_modules"));
  assert.ok(!git.args.includes("-w"), "a regex pattern must not be word-wrapped: it starts with a quote");
  const grep = searchArgs("grep", ["alpha"], ["node_modules", "*.min.*"], { fixed: true });
  assert.ok(grep.args.includes("--exclude-dir=node_modules") && grep.args.includes("--exclude=*.min.*"));
});

test("a file symbol is searched by name and by import form", () => {
  assert.deepEqual(symbolPatterns({ name: "loadConfig", kind: "function" }), { literals: ["loadConfig"], regexes: [] });
  const file = symbolPatterns({ name: "config.mjs", kind: "file" });
  assert.deepEqual(file.literals, ["config.mjs"]);
  assert.match(`import x from "../lib/config.mjs";`, new RegExp(file.regexes[0]));
  assert.match(`from "./config"`, new RegExp(file.regexes[0]), "the extension-less import form counts too");
});

test("hit lines are split on the first two colons, so source text keeps its own", () => {
  assert.deepEqual(parseHits("./a/b.mjs:12:const url = 'http://x';\nnot a hit\n"), [
    { file: "a/b.mjs", line: 12, text: "const url = 'http://x';" },
  ]);
});

// --- the grep engine, for real --------------------------------------------
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "impact-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

test("references: the changed file is skipped, tests and docs are classified, a generic name is not expanded", () => {
  const root = tree({
    "lib/thing.mjs": "export function mergeInto() {}\n",
    "lib/caller.mjs": "import { mergeInto } from './thing.mjs';\nmergeInto();\n",
    "tests/thing.test.mjs": "import { mergeInto } from '../lib/thing.mjs';\n",
    "README.md": "call mergeInto to merge\n",
    "node_modules/dep/index.js": "mergeInto()\n",
    "noisy.mjs": Array.from({ length: 6 }, () => "everywhere();").join("\n"),
  });
  const symbols = [
    { name: "mergeInto", kind: "function", file: "lib/thing.mjs", state: "removed", weight: 3 },
    { name: "everywhere", kind: "function", file: "lib/thing.mjs", state: "changed", weight: 1 },
  ];
  const found = collectReferences({
    engine: "grep", root, symbols, changedFiles: ["lib/thing.mjs"],
    config: { ...CONFIG, maxRefsPerSymbol: 5 }, timeoutMs: 10000,
  });
  const files = found.references.map((r) => r.file).sort();
  assert.deepEqual([...new Set(files)], ["README.md", "lib/caller.mjs", "tests/thing.test.mjs"]);
  assert.ok(!files.includes("node_modules/dep/index.js"), "the exclude list holds");
  assert.deepEqual(found.noisy, ["everywhere"]);
  assert.equal(found.noisyCounts.everywhere, 6);
  assert.ok(!found.references.some((r) => r.symbol === "everywhere"), "a name over the cap is named, not expanded");
  assert.deepEqual(found.failures, []);
});

test("engine choice falls back when ripgrep is absent", () => {
  assert.ok(["rg", "git", "grep"].includes(chooseEngine(HERE)));
});

// --- end to end ------------------------------------------------------------
const END_TO_END = (root) => scopeBundle(root, ["  M  lib/thing.mjs"], [
  "diff --git a/lib/thing.mjs b/lib/thing.mjs",
  "--- a/lib/thing.mjs",
  "+++ b/lib/thing.mjs",
  "@@ -1,2 +1,2 @@",
  "-export function mergeInto(a) {}",
  "+export function mergeAll(a) {}",
].join("\n"));

test("analyse: a rename produces the broken-reference row the whole script exists for", () => {
  const root = tree({
    "lib/thing.mjs": "export function mergeAll() {}\n",
    "lib/caller.mjs": "mergeInto();\n",
    "docs/guide.md": "mergeInto is the entry point\n",
  });
  const result = analyse({ scope: parseScope(END_TO_END(root)), adapter: "grep", config: CONFIG });
  assert.match(result.markdown, /## Broken references/);
  assert.match(result.markdown, /lib\/caller\.mjs:1 +→ mergeInto \(renamed\)/);
  assert.equal(result.json.counts.broken, 1, "the docs mention is not a contract break");
  assert.match(result.markdown, /## Docs and config that mention the change[\s\S]*docs\/guide\.md/);
  assert.equal(result.json.schema, 1);
  assert.equal(result.json.adapter, "grep");
  assert.equal(result.summary, result.markdown.split("\n")[0], "the summary is the file's own first line");
});

// --- wire contracts, end to end --------------------------------------------
// The unit tests in lib/wire.test.mjs prove the primitive; these two prove the
// whole script on a tree, which is where the four spellings, the noise
// literals, the docs mention and the generated client all exist at once.
const MONOREPO = (root) => scopeBundle(root, ["  M  server/routes.ts"], [
  "diff --git a/server/routes.ts b/server/routes.ts",
  "--- a/server/routes.ts",
  "+++ b/server/routes.ts",
  "@@ -1,3 +1,3 @@",
  '-router.get("/api/users/:id", getUser);',
  '+router.get("/api/v2/users/:id", getUser);',
  'router.get("/", health);',
].join("\n"));

const MONOREPO_FILES = {
  "server/routes.ts": 'router.get("/api/v2/users/:id", getUser);\nrouter.get("/", health);\n',
  "web/src/api/users.ts": 'export const byId = (id) => fetch("/api/users/" + id);\nexport const admin = (id) => fetch("/api/users-admin/" + id);\nexport const home = () => fetch("/index.html");\n',
  "web/src/api/hooks.ts": "export const useUser = (id) => fetch(`/api/users/${id}`);\n",
  "svc/client.py": 'def get_user(id): return requests.get(f"/api/users/{id}")\ndef legacy(id): return requests.get("/api/users/%s" % id)\n',
  "web/src/__generated__/client.ts": 'export const getUser = (id) => fetch("/api/users/" + id);\n',
  "docs/api.md": "The endpoint is `/api/users/:id`.\n",
};

test("a renamed route finds the consumers no import links to, and none of the noise", () => {
  const root = tree(MONOREPO_FILES);
  const result = analyse({ scope: parseScope(MONOREPO(root)), adapter: "grep", config: CONFIG });
  const files = result.json.wire.references.map((reference) => reference.file).sort();
  assert.deepEqual(files, ["docs/api.md", "svc/client.py", "svc/client.py", "web/src/__generated__/client.ts", "web/src/api/hooks.ts", "web/src/api/users.ts"],
    "concat, template, f-string and %s — and not /api/users-admin/, /index.html or /");
  assert.equal(result.json.counts.wire_broken, 4, "the docs mention and the generated client are reported and not counted");
  assert.match(result.markdown, /## Wire contracts/);
  assert.match(result.markdown, /GET \/api\/users\/:id → \/api\/v2\/users\/\*/);
  assert.match(result.markdown, /web\/src\/__generated__\/client\.ts:1 .*·generated/);
  assert.match(result.markdown, /nothing names the new value either/, "a rename done on one side only is the same bug in the other direction");
  assert.equal(result.json.counts.broken, 0, "no symbol moved: a wire break is not a contractBreak");
});

test("a route line merely reformatted produces no wire row at all", () => {
  // The whole reason the trigger is removed-and-not-re-added: otherwise every
  // re-indent greps the tree for every literal on the line.
  const root = tree(MONOREPO_FILES);
  const moved = scopeBundle(root, ["  M  server/routes.ts"], [
    "diff --git a/server/routes.ts b/server/routes.ts",
    "--- a/server/routes.ts",
    "+++ b/server/routes.ts",
    "@@ -1,2 +1,4 @@",
    '-router.get("/api/users/:id", getUser);',
    "+router.get(",
    '+  "/api/users/:id",',
    "+  getUser,",
    "+);",
  ].join("\n"));
  const result = analyse({ scope: parseScope(moved), adapter: "grep", config: CONFIG });
  assert.deepEqual(result.json.wire.tokens, []);
  assert.equal(result.json.counts.wire_broken, 0);
  assert.doesNotMatch(result.markdown, /Wire contracts/);
});

test("the wire section is inside the line budget, not added on top of it", () => {
  // Bumping `overhead` reserved this section's HEADING; its body was appended
  // after the caller budget had already been spent, so a realistic API-version
  // bump rendered an 80-line cap at 165 lines while still telling the finder
  // its callers were "cut at 80".
  const routes = Array.from({ length: 20 }, (_, i) => i);
  // Both kinds of pressure at once: enough wire consumers to fill the section,
  // and enough symbol callers that the caller budget is actually binding —
  // without the second, an over-computed budget shows no symptom.
  const files = Object.fromEntries(routes.map((i) => [
    `web/c${i}.ts`,
    `${routes.map((j) => `fetch("/api/orders${j}/" + id);`).join("\n")}\nsharedHelper();\n`,
  ]));
  const root = tree({ ...files, "server/routes.ts": routes.map((i) => `router.get("/api/v2/orders${i}/:id", h);`).join("\n") });
  const diff = [
    "diff --git a/server/routes.ts b/server/routes.ts",
    "--- a/server/routes.ts",
    "+++ b/server/routes.ts",
    `@@ -1,${routes.length} +1,${routes.length} @@`,
    // A *changed* symbol, not a removed one: broken references are never cut,
    // so only ordinary callers compete with the wire section for the budget.
    "-export function sharedHelper(a) { return a; }",
    "+export function sharedHelper(a, b) { return a + b; }",
    ...routes.map((i) => `-router.get("/api/orders${i}/:id", h);`),
    ...routes.map((i) => `+router.get("/api/v2/orders${i}/:id", h);`),
  ].join("\n");
  // A tighter cap than the shipped 80, so the caller budget is what binds
  // rather than SECTION_CAPS.code — which is the whole point of the budget.
  const config = { ...CONFIG, maxLines: 40 };
  const result = analyse({ scope: parseScope(scopeBundle(root, ["  M  server/routes.ts"], diff)), adapter: "grep", config });
  assert.ok(result.markdown.split("\n").length <= config.maxLines,
    `impact.md is ${result.markdown.split("\n").length} lines against a cap of ${config.maxLines}`);
  assert.match(result.markdown, /more contracts changed; impact\.json has all of them/);
  assert.ok(result.json.wire.tokens.length > 12, "impact.json still carries every one");
  assert.ok(result.json.counts.caller_files >= 20, "and the symbol callers are really competing for the same budget");
});

test("a consumer that hard-codes the absolute URL is found — it is the cross-service caller", () => {
  // The anchors used to ride the fixed-string pass, which carries `-w` for
  // symbol names. `-w` needs a non-word character before the match, and in
  // `https://api.example.com/api/users/` that character is `m`.
  const root = tree({
    "web/direct.ts": 'export const u = fetch("https://api.example.com/api/users/" + id);\n',
    "web/relative.ts": 'export const v = fetch("/api/users/" + id);\n',
    "server/routes.ts": 'router.get("/api/v2/users/:id", getUser);\n',
  });
  const result = analyse({ scope: parseScope(MONOREPO(root)), adapter: "grep", config: CONFIG });
  assert.deepEqual(result.json.wire.references.map((reference) => reference.file).sort(), ["web/direct.ts", "web/relative.ts"]);
});

test("--adapter none is the ablation: symbols, no reference search", () => {
  const root = tree({ "lib/caller.mjs": "mergeInto();\n" });
  const result = analyse({ scope: parseScope(END_TO_END(root)), adapter: "none", config: CONFIG });
  assert.equal(result.json.adapter, "none");
  assert.equal(result.json.references.length, 0);
  assert.ok(result.json.symbols.length > 0);
});

test("a scope outside git says so in one line and still exits 0", () => {
  const out = mkdtempSync(path.join(tmpdir(), "impact-out-"));
  const scope = path.join(out, "scope.diff");
  writeFileSync(scope, "# self-review scope (not a git repo — full file contents)\n\n==> a.txt <==\nhello\n");
  const run = spawnSync(process.execPath, [SCRIPT, "--scope", scope, "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(readFileSync(path.join(out, "impact.md"), "utf8"), /no repository — no impact analysis/);
  assert.equal(JSON.parse(readFileSync(path.join(out, "impact.json"), "utf8")).repo, null);
});

test("CLI: both files are written, stdout is two lines, bad usage and a missing scope are distinct exits", () => {
  const root = tree({ "lib/thing.mjs": "export function mergeAll() {}\n", "lib/caller.mjs": "mergeInto();\n" });
  const out = path.join(root, "round-1");
  const scope = path.join(root, "scope.diff");
  writeFileSync(scope, END_TO_END(root));
  const run = spawnSync(process.execPath, [SCRIPT, "--scope", scope, "--out", out, "--adapter", "grep"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 2, "stdout is the summary and the path, nothing else");
  assert.match(run.stdout, /^IMPACT \(/);
  assert.match(run.stdout, new RegExp(`written: ${out}/impact\\.md`));
  assert.ok(JSON.parse(readFileSync(path.join(out, "impact.json"), "utf8")).references.length >= 1);

  assert.equal(spawnSync(process.execPath, [SCRIPT, "--scope", scope], { encoding: "utf8" }).status, 2, "--out is required");
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--scope", scope, "--out", out, "--adapter", "nope"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--scope", "/no/such/scope", "--out", out], { encoding: "utf8" }).status, 3);
});

// --- the code-review-graph adapter, against a stub -------------------------
function withStub(body) {
  const bin = mkdtempSync(path.join(tmpdir(), "impact-bin-"));
  const stub = path.join(bin, "code-review-graph");
  writeFileSync(stub, `#!/bin/sh\n${body}\n`);
  chmodSync(stub, 0o755);
  return bin;
}
const CRG_STUB = `
case "$1" in
  --version) echo "code-review-graph 9.9.9" ;;
  update) echo "updated 1 file" ;;
  impact) echo '{"impacted_files":["lib/caller.mjs","lib/other.mjs"],"total_impacted":2,"truncated":false}' ;;
  detect-changes) echo '{"risk_score":0.42,"affected_flows":["checkout"],"test_gaps":[{"name":"mergeAll","file":"lib/thing.mjs"}],"functions_truncated":false}' ;;
esac`;

const crgRun = (root, out, bin, args = []) => spawnSync(
  process.execPath, [SCRIPT, "--scope", path.join(root, "scope.diff"), "--out", out, "--adapter", "crg", ...args],
  { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
);

test("code-review-graph augments: edge-confirmed callers, risk, flows and test gaps", () => {
  const root = tree({ "lib/thing.mjs": "export function mergeAll() {}\n", "lib/caller.mjs": "mergeInto();\n", "lib/other.mjs": "mergeAll();\n" });
  writeFileSync(path.join(root, "scope.diff"), END_TO_END(root));
  const out = path.join(root, "round-1");
  const run = crgRun(root, out, withStub(CRG_STUB));
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(readFileSync(path.join(out, "impact.json"), "utf8"));
  assert.equal(json.adapter, "grep+crg");
  assert.equal(json.graph.risk_score, 0.42);
  assert.equal(json.graph.affected_flows, 1);
  assert.deepEqual(json.graph.test_gaps, ["mergeAll"]);
  assert.ok(json.references.some((r) => r.file === "lib/caller.mjs" && r.graph), "an edge-confirmed reference is marked");
  assert.match(readFileSync(path.join(out, "impact.md"), "utf8"), /- lib\/other\.mjs:1 +→ mergeAll ·graph/);
  assert.ok(!json.references.some((r) => r.file === "scope.diff"), "the work dir inside the repo is not its own blast radius");
});

test("a hanging code-review-graph is capped, and the output is grep-only with the reason in the header", () => {
  const root = tree({ "lib/thing.mjs": "export function mergeAll() {}\n", "lib/caller.mjs": "mergeInto();\n" });
  writeFileSync(path.join(root, "scope.diff"), END_TO_END(root));
  const out = path.join(root, "round-1");
  const run = crgRun(root, out, withStub(`case "$1" in --version) echo v ;; *) sleep 30 ;; esac`), ["--timeout", "1"]);
  assert.equal(run.status, 0, "a failed adapter is a header note, not an exit code");
  const json = JSON.parse(readFileSync(path.join(out, "impact.json"), "utf8"));
  assert.equal(json.adapter, "grep");
  assert.equal(json.graph, null);
  assert.match(json.failures.join(" "), /crg failed/);
  assert.ok(json.references.length >= 1, "grep results survive the adapter's failure");
  assert.match(readFileSync(path.join(out, "impact.md"), "utf8"), /# adapter: .*crg failed/);
});

test("unparseable adapter output is a failure, never a half-trusted graph", () => {
  const root = tree({ "lib/thing.mjs": "export function mergeAll() {}\n" });
  writeFileSync(path.join(root, "scope.diff"), END_TO_END(root));
  const out = path.join(root, "round-1");
  const run = crgRun(root, out, withStub(`case "$1" in --version) echo v ;; update) echo ok ;; *) echo 'not json' ;; esac`));
  assert.equal(run.status, 0);
  const json = JSON.parse(readFileSync(path.join(out, "impact.json"), "utf8"));
  assert.equal(json.graph, null);
  assert.match(json.failures.join(" "), /unparseable JSON/);
});

// --- the line budget -------------------------------------------------------
test("rendering: broken references survive the cap, lower-ranked callers are cut and counted", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    file: `src/caller${i}.ts`, kind: "code", lines: [i + 1], symbols: ["thing"], graph: false, broken: false, score: 60 - i,
  }));
  const brokenRows = Array.from({ length: 25 }, (_, i) => ({ file: `src/broken${i}.ts`, line: i, symbol: "gone", state: "removed", kind: "code" }));
  const markdown = renderMarkdown({
    generated: "2026-08-23T10:00:00Z", adapter: "grep", engine: "rg", elapsedMs: 400, failures: [],
    counts: { changed_files: 2, references: 85, files: 85, test_files: 0, doc_files: 0, config_files: 0, broken: 25 },
    symbols: [{ name: "gone" }], noisy: [], noisyCounts: {}, untested: [], projectHasTests: true,
    rows, brokenRows, notes: [],
  }, { ...CONFIG, maxLines: 40 });
  const lines = markdown.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("- src/broken")).length, 25, "a rename that breaks 25 references shows all 25");
  assert.ok(lines.filter((l) => l.startsWith("- src/caller")).length < 60);
  assert.match(markdown, /lower-ranked caller files cut at 40 lines; impact\.json has all 60/);
});

// --- round-1 regressions ----------------------------------------------------
test("a test added in the same commit as its subject counts as a test, not a gap", () => {
  const root = tree({
    "lib/thing.mjs": "export function mergeAll() {}\n",
    "lib/thing.test.mjs": "import { mergeAll } from './thing.mjs';\nmergeAll();\n",
    "packages/app/node_modules/dep/index.js": "mergeAll();\n",
  });
  const scope = scopeBundle(root, ["  A  lib/thing.mjs", "  A  lib/thing.test.mjs"], [
    "diff --git a/lib/thing.mjs b/lib/thing.mjs",
    "--- /dev/null",
    "+++ b/lib/thing.mjs",
    "@@ -0,0 +1,1 @@",
    "+export function mergeAll() {}",
  ].join("\n"));
  const result = analyse({ scope: parseScope(scope), adapter: "grep", config: CONFIG });
  const tests = result.json.references.filter((r) => r.kind === "test");
  assert.deepEqual([...new Set(tests.map((r) => r.file))], ["lib/thing.test.mjs"], "TDD is not an untested surface");
  assert.ok(!result.json.untested.includes("mergeAll"), "and the tier is not escalated for it");
  assert.ok(!result.json.references.some((r) => r.file.includes("node_modules")), "a nested node_modules is still excluded");
});

test("--symbol survives the cap even when it ranks last", () => {
  const defined = Array.from({ length: 4 }, (_, i) => ({ name: `weighty${i}`, kind: "function", file: "a.mjs", state: "changed", weight: 10 }));
  defined.push({ name: "quiet", kind: "function", file: "a.mjs", state: "changed", weight: 1 });
  const ranked = rankSymbols(defined, [], { ...CONFIG, maxSymbols: 2 }, ["quiet"]);
  assert.ok(ranked.some((s) => s.name === "quiet"), "a human overriding the ranking is not out-ranked");
  assert.equal(ranked.filter((s) => s.name === "quiet").length, 1, "and appears once");
});

test("a config number that cannot be used is refused by name, not passed to spawn", () => {
  const limits = normaliseLimits({ ...CONFIG, timeoutSec: -5, maxSymbols: 0, maxLines: "80" });
  assert.equal(limits.timeoutSec, 20);
  assert.equal(limits.maxSymbols, 30);
  assert.equal(limits.maxLines, 80, "a string is not a number");
  assert.equal(limits.maxRefsPerSymbol, CONFIG.maxRefsPerSymbol, "a usable value is left alone");
});

test("a workflow still calling a deleted script is a broken reference, counted once", () => {
  const root = tree({
    "scripts/build.mjs": "export function buildAll() {}\n",
    ".github/workflows/ci.yml": "  run: node -e \"require('./scripts/build.mjs').runBuild()\"\n",
    "docs/guide.md": "runBuild is the entry point\n",
  });
  const scope = scopeBundle(root, ["  M  scripts/build.mjs"], [
    "diff --git a/scripts/build.mjs b/scripts/build.mjs",
    "--- a/scripts/build.mjs",
    "+++ b/scripts/build.mjs",
    "@@ -1,1 +1,1 @@",
    "-export function runBuild() {}",
    "+export function buildAll() {}",
  ].join("\n"));
  const result = analyse({ scope: parseScope(scope), adapter: "grep", config: CONFIG });
  assert.equal(result.json.counts.broken, 1, "the count tier.mjs escalates on sees the config break");
  const workflowRows = result.markdown.split("\n").filter((line) => line.includes(".github/workflows/ci.yml"));
  assert.equal(workflowRows.length, 1, "shown under Broken references, not again under docs and config");
  assert.match(result.markdown, /## Docs and config that mention the change[\s\S]*docs\/guide\.md/, "a docs mention is still a mention");
});
