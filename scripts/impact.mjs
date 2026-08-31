#!/usr/bin/env node
// self-review impact — the blast radius of a change, computed without an LLM.
//
// Usage:
//   impact.mjs --scope round-N/scope.diff --out round-N/ [--base <ref>]
//              [--adapter auto|grep|crg|none] [--symbol NAME]… [--timeout SEC] [--max-lines N]
//
// Reads the scope bundle (never git: finders and impact must see the same
// change), extracts the symbols whose *definitions* moved, and finds what
// still references them. Writes `impact.md` for the briefs and `impact.json`
// for tier.mjs, evals and audit; prints the two-line summary and the path.
//
// The single most valuable row it produces is a **broken reference**: a symbol
// that a hunk removed or renamed and that something else still names. That is
// angle B/C's cross-file bug, found for the price of one grep. A reference in
// a config file counts as broken too — a workflow calling a deleted script is
// the same bug as a caller calling a deleted function.
//
// Two adapters. The grep engine (rg → git grep → grep) always runs: name
// search over the whole tree is the floor, and it has no language support to
// fall outside of. `code-review-graph` augments it when the repo has a built
// graph and the binary is on PATH — it marks edge-confirmed callers `·graph`
// and adds risk, flows and test gaps — and never removes a grep hit. Any
// failure of it leaves grep-only output and a note in the header.
//
// Scope bundles that span repositories are analysed for their first repo only;
// the header says so. Outside git the scope has no repository to search and
// impact says that in one line.
//
// Exit 0 whenever the files were written (a failed adapter is a header note,
// not an exit code); 2 usage; 3 the scope file is unreadable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { FALLBACK, isMain, loadConfig } from "../hooks/lib/config.mjs";
import { parseDiff } from "./lib/diff.mjs";
import { matchWireHits, wireSearchTokens } from "./lib/wire.mjs";
import { classifyPath, isTestPath, matchesAnyGlob, matchesExclude } from "./lib/paths.mjs";

const SCHEMA = 1;

// --- the scope bundle ------------------------------------------------------
const unquote = (p) => {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p); } catch { return p; }
};

// "  M  path", "  ?? path", "  R  old -> new" — porcelain v1 indented by scope.sh.
export function parseStatusLine(line) {
  const match = line.match(/^ {2}(..) (.+)$/);
  if (!match) return null;
  const [, xy, rest] = match;
  let file = rest.trim();
  let status = xy.trim()[0] || "M";
  const rename = file.split(" -> ");
  let from = null;
  // The old path is kept, not dropped: for a file-system router it IS the
  // contract that was removed. Deriving the route from the NEW path searched
  // the tree for consumers of the value the change just introduced and called
  // them stale, while never searching for the old route at all.
  if (rename.length === 2) { from = unquote(rename[0].trim()); file = rename[1]; status = "R"; }
  return { path: unquote(file), status, ...(from ? { from } : {}) };
}

export function parseScope(text) {
  const truncated = /^# TRUNCATED:/m.test(text);
  if (/^# self-review scope \(not a git repo/m.test(text)) return { plain: true, truncated, repos: [] };
  const repos = [];
  let repo = null, section = null;
  for (const line of text.split("\n")) {
    if (line === "# self-review scope") { repo = { root: "", base: "HEAD", files: [], diff: [] }; repos.push(repo); section = null; continue; }
    if (!repo) continue;
    const root = line.match(/^# repo: (.+)$/);
    if (root) { repo.root = root[1].trim(); continue; }
    const base = line.match(/^# branch: .*\bbase: (\S+)/);
    if (base) { repo.base = base[1]; continue; }
    if (/^## Changed files/.test(line)) { section = "files"; continue; }
    if (/^## (Diff vs|Untracked files)/.test(line)) { section = "diff"; continue; }
    if (section === "files") { const entry = parseStatusLine(line); if (entry) repo.files.push(entry); continue; }
    if (section === "diff") repo.diff.push(line);
  }
  return { plain: false, truncated, repos };
}

// --- changed symbols -------------------------------------------------------
// Definition patterns per language (DESIGN §4.3 step 1). Each entry's `kind`
// is either a fixed string or the index of the capture group naming it — the
// finder reads "removed (function)" differently from "removed (const)".
const LANGUAGES = [
  {
    ext: /\.(mjs|cjs|jsx?|tsx?|mts|cts)$/,
    defs: [
      // Column 0 on purpose: an indented `const` is a local, and searching the
      // tree for every local name is what makes a blast radius useless.
      { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, name: 2, kind: 1 },
      { re: /^\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/, name: 1, kind: "export" },
    ],
    lists: [{ re: /^export\s*\{([^}]*)\}/, kind: "export" }],
  },
  {
    ext: /\.py$/,
    defs: [
      { re: /^\s*(?:async\s+)?(def|class)\s+(\w+)/, name: 2, kind: 1 },
      { re: /^([A-Z_][A-Z0-9_]+)\s*=/, name: 1, kind: "const" },
    ],
  },
  {
    ext: /\.go$/,
    defs: [
      { re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, name: 1, kind: "func" },
      { re: /^type\s+(\w+)/, name: 1, kind: "type" },
    ],
  },
  {
    ext: /\.rs$/,
    defs: [{ re: /^\s*(?:pub(?:\(\w+\))?\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/, name: 2, kind: 1 }],
  },
  {
    ext: /\.(sh|bash|zsh)$/,
    defs: [
      { re: /^(?:function\s+)?(\w+)\s*\(\)\s*\{?/, name: 1, kind: "func" },
      { re: /^([A-Z_][A-Z0-9_]*)=/, name: 1, kind: "const" },
    ],
  },
  {
    ext: /\.(rb|java|kt|kts|cs|php|scala|swift)$/,
    defs: [
      { re: /^\s*(?:def|class|module|interface|enum|fun|func)\s+(\w+)/, name: 1, kind: "def" },
      // At least one real modifier: with `\s` as an alternative (DESIGN §4.3's
      // illustrative form) `return helper(x);` also reads as a declaration, and
      // a package-private method is rarer than a return statement.
      { re: /^\s*(?:(?:public|private|protected|internal|static|final|override|abstract|synchronized|suspend)\s+)+[\w<>[\],\s?]+\s+(\w+)\s*\(/, name: 1, kind: "method" },
    ],
  },
];

// Control-flow words the loosest pattern above (the Java/C#/PHP method rule)
// can capture out of an ordinary statement.
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "new", "do", "else", "function", "class", "def", "fun", "func", "elif", "with", "match"]);

export function definitionsIn(line, ext) {
  const language = LANGUAGES.find((entry) => entry.ext.test(ext));
  if (!language) return [];
  const found = [];
  const push = (name, kind) => {
    if (name && !NOT_A_NAME.has(name)) found.push({ name, kind: String(kind).replace(/\s*\*?$/, "").trim() });
  };
  for (const { re, name, kind } of language.defs) {
    const match = line.match(re);
    if (match) push(match[name], typeof kind === "number" ? match[kind] : kind);
  }
  for (const { re, kind } of language.lists ?? []) {
    const match = line.match(re);
    if (!match) continue;
    // `export { a, b as c }` re-exports `a` and `b`; the local names are the
    // ones a reference search can find.
    for (const part of match[1].split(",")) {
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) push(local, kind);
    }
  }
  return found;
}

// A hunk's `@@ … @@ trailing` names the enclosing definition: a second source
// for a symbol whose own definition line is not in the diff.
const contextSymbol = (context, ext) => definitionsIn(context, ext).map((d) => d.name);

/**
 * Walk the bundle's diff text once: which symbols changed, in which file, in
 * which state, and how many changed lines their hunk carried (the ranking).
 */
const GONE = new Set(["removed", "renamed"]);

export function changedSymbols(diffLines) {
  const symbols = new Map();
  const record = (name, kind, file, state, weight) => {
    const previous = symbols.get(name);
    if (!previous) { symbols.set(name, { name, kind, file, state, weight }); return; }
    previous.weight += weight;
    // A name removed here and added there moved rather than vanished, and
    // "changed" is the state that produces no false broken reference. Two
    // flavours of gone stay gone.
    if (previous.state !== state) previous.state = GONE.has(previous.state) && GONE.has(state) ? "removed" : "changed";
  };

  for (const { file, hunks } of parseDiff(diffLines)) {
    const ext = path.extname(file);
    for (const hunk of hunks) {
      const added = new Map(), removed = new Map();
      for (const { sign, text } of hunk.lines) {
        const target = sign === "+" ? added : removed;
        for (const { name, kind } of definitionsIn(text, ext)) if (!target.has(name)) target.set(name, kind);
      }
      const weight = hunk.lines.length;
      const addedOnly = [...added.keys()].filter((name) => !removed.has(name));
      for (const [name, kind] of added) if (removed.has(name)) record(name, kind, file, "changed", weight);
      for (const name of addedOnly) record(name, added.get(name), file, "added", weight);
      // A removed definition next to an added one in the same hunk is a
      // rename: the same consequence as a removal for every remaining
      // reference, but worth saying differently in the report.
      for (const [name, kind] of removed) {
        if (added.has(name)) continue;
        record(name, kind, file, addedOnly.length ? "renamed" : "removed", weight);
      }
      for (const name of contextSymbol(hunk.context, ext)) if (!symbols.has(name)) record(name, "enclosing", file, "changed", weight);
    }
  }
  return [...symbols.values()];
}

const FILE_STATE = { A: "added", D: "removed", R: "renamed", "?": "added" };

/** The changed files themselves are symbols: their basename is what docs, configs and imports name. */
export function fileSymbols(files) {
  return files.map(({ path: file, status }) => ({
    name: path.basename(file), kind: "file", file, state: FILE_STATE[status] ?? "changed", weight: 0,
  }));
}

/**
 * The symbols worth searching for, most-changed first. Defined symbols and
 * file names are capped separately: a large code change must not push the
 * changed file names out of the search (they are what finds the docs and the
 * imports), and a large docs change must not push out the code symbols.
 * `--symbol` always survives — it is a human overriding the ranking.
 */
export function rankSymbols(defined, files, config, extra = []) {
  const stop = new Set(config.stopWords.map((word) => word.toLowerCase()));
  const forced = new Set(extra);
  const byWeight = (a, b) => b.weight - a.weight || a.name.localeCompare(b.name);
  const seen = new Set();
  const take = (list) => list.filter(({ name }) => (seen.has(name) ? false : seen.add(name)));

  const wanted = defined.filter(({ name }) => forced.has(name) || (name.length >= config.minSymbolLength && !stop.has(name.toLowerCase())));
  const ranked = take(wanted.sort(byWeight).slice(0, config.maxSymbols));
  const fileNames = take(files.slice(0, config.maxSymbols));
  const given = [...forced].filter((name) => !seen.has(name)).map((name) => ({ name, kind: "given", file: "", state: "changed", weight: Infinity }));
  return [...ranked, ...fileNames, ...given];
}

// --- the grep engine -------------------------------------------------------
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const available = (binary) => {
  const probe = spawnSync(binary, ["--version"], { stdio: "ignore", timeout: 5000 });
  return !probe.error && probe.status === 0;
};

export function chooseEngine(root) {
  if (available("rg")) return "rg";
  const git = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore", timeout: 5000 });
  return !git.error && git.status === 0 ? "git" : "grep";
}

/** Engine-specific argv for one search. `fixed` searches literal whole words; otherwise the patterns are regexes. */
export function searchArgs(engine, patterns, exclude, { fixed }) {
  if (engine === "rg") {
    const args = ["-n", "--no-heading", "--no-messages", "--color", "never", "--hidden"];
    if (fixed) args.push("-F", "-w");
    for (const entry of exclude.concat(".git")) args.push("-g", `!${entry}`);
    for (const pattern of patterns) args.push("-e", pattern);
    args.push(".");
    return { command: "rg", args };
  }
  if (engine === "git") {
    const args = ["grep", "-n", "-I", "--no-color", "--untracked", fixed ? "-F" : "-E"];
    if (fixed) args.push("-w");
    for (const pattern of patterns) args.push("-e", pattern);
    args.push("--", ".");
    for (const entry of exclude.concat(".git")) args.push(`:!${entry}`);
    return { command: "git", args };
  }
  const args = ["-r", "-n", "-I", fixed ? "-F" : "-E"];
  if (fixed) args.push("-w");
  for (const pattern of patterns) args.push("-e", pattern);
  for (const entry of exclude.concat(".git")) {
    args.push(entry.includes("*") ? `--exclude=${entry}` : `--exclude-dir=${entry}`);
  }
  args.push(".");
  return { command: "grep", args };
}

// A hit line is `path:line:text`; the text is free to contain colons.
export function parseHits(stdout) {
  const hits = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    hits.push({ file: match[1].replace(/^\.\//, ""), line: Number(match[2]), text: match[3] });
  }
  return hits;
}

function runSearch(engine, root, patterns, exclude, options, timeoutMs) {
  if (patterns.length === 0) return { hits: [], failure: null };
  const { command, args } = searchArgs(engine, patterns, exclude, options);
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // Every engine exits 1 for "no matches", which is an answer, not a failure.
  if (result.error) return { hits: [], failure: `${command} failed: ${result.error.message}` };
  if (result.status !== 0 && result.status !== 1) {
    return { hits: parseHits(result.stdout || ""), failure: `${command} exited ${result.status}` };
  }
  return { hits: parseHits(result.stdout || ""), failure: null };
}

/** Patterns for one symbol: the name as a literal, plus the import form for a file. */
export function symbolPatterns(symbol) {
  if (symbol.kind !== "file") return { literals: [symbol.name], regexes: [] };
  const stem = symbol.name.replace(/\.[^.]+$/, "");
  return { literals: [symbol.name], regexes: [`['"][^'"]*/${escapeRegExp(stem)}(\\.[a-z]+)?['"]`] };
}

export function collectReferences({ engine, root, symbols, wireTokens = [], changedFiles, ignorePaths = [], config, timeoutMs }) {
  const literals = [], regexes = [], matchers = [];
  for (const symbol of symbols) {
    const { literals: lit, regexes: res } = symbolPatterns(symbol);
    literals.push(...lit);
    regexes.push(...res);
    matchers.push({
      symbol,
      tests: [new RegExp(`(?:^|[^\\w$])${escapeRegExp(symbol.name)}(?:[^\\w$]|$)`), ...res.map((source) => new RegExp(source))],
    });
  }
  // The wire anchors join the SAME two searches this function already runs —
  // no extra spawn — but the *regex* one, not the fixed-string one. That pass
  // carries `-w` because it was built for symbol names, and `-w` requires a
  // non-word character before the match: it finds `"/api/users/" + id` and
  // `` `${BASE}/api/users/` `` and silently drops
  // `"https://api.example.com/api/users/"`, whose preceding character is `m` —
  // the cross-service caller this whole feature exists to find. Escaped, an
  // anchor is still a literal; it just no longer carries a word boundary.
  for (const token of wireTokens) regexes.push(...token.anchors.map(escapeRegExp));
  const failures = [];
  const hits = [];
  // One budget across both passes: two searches each given the full timeout
  // would let the configured cap be doubled.
  const deadline = Date.now() + timeoutMs;
  for (const [patterns, options] of [[literals, { fixed: true }], [regexes, { fixed: false }]]) {
    const result = runSearch(engine, root, patterns, config.exclude, options, Math.max(deadline - Date.now(), 1));
    if (result.failure) failures.push(result.failure);
    hits.push(...result.hits);
  }

  const changed = new Set(changedFiles);
  const ignored = (file) => ignorePaths.some((entry) => file === entry || file.startsWith(`${entry}/`));
  const perSymbol = new Map(symbols.map((symbol) => [symbol.name, 0]));
  const references = [];
  const seen = new Set();
  for (const hit of hits) {
    // The changed files' own lines are already in the diff the finder reads —
    // except a changed *test* file: a symbol and its first test usually land in
    // the same commit, and dropping those hits reports the symbol untested,
    // which then escalates the tier. The exclude list is re-applied here
    // because the three engines spell exclusion differently enough not to be
    // trusted blind.
    if (changed.has(hit.file) && !isTestPath(hit.file)) continue;
    if (ignored(hit.file) || matchesExclude(config.exclude, hit.file)) continue;
    for (const { symbol, tests } of matchers) {
      if (!tests.some((test) => test.test(hit.text))) continue;
      const key = `${hit.file}:${hit.line}:${symbol.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perSymbol.set(symbol.name, (perSymbol.get(symbol.name) ?? 0) + 1);
      references.push({ file: hit.file, line: hit.line, symbol: symbol.name, kind: "code", graph: false });
    }
  }
  // A name with hundreds of hits is a generic word, not a blast radius: the
  // finder is told it exists and left to grep it if its angle needs it.
  const over = [...perSymbol.entries()].filter(([, count]) => count > config.maxRefsPerSymbol);
  const noisy = over.map(([name]) => name);
  const noisyCounts = Object.fromEntries(over);
  const noisySet = new Set(noisy);
  const wire = matchWireHits(hits.filter((hit) => !ignored(hit.file) && !matchesExclude(config.exclude, hit.file)), wireTokens, {
    maxRefs: config.maxRefsPerSymbol,
  });
  return { references: references.filter((reference) => !noisySet.has(reference.symbol)), noisy, noisyCounts, failures, wire };
}

// --- the code-review-graph adapter ----------------------------------------
export const crgAvailable = (root) => existsSync(path.join(root, ".code-review-graph")) && available("code-review-graph");

function crgJson(args, root, budget, { json = true } = {}) {
  const started = Date.now();
  const result = spawnSync("code-review-graph", args, { cwd: root, encoding: "utf8", timeout: budget.left(), maxBuffer: 32 * 1024 * 1024 });
  budget.spend(Date.now() - started);
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? `timeout after ${budget.seconds}s` : result.error.message;
    return { error: reason };
  }
  if (result.status !== 0) return { error: `${args[0]} exited ${result.status}` };
  if (!json) return { data: null };
  try {
    return { data: JSON.parse(result.stdout) };
  } catch (error) {
    return { error: `${args[0]}: unparseable JSON (${error.message})` };
  }
}

/**
 * Edge-confirmed callers, risk and test gaps. Runs `update` first: `impact`
 * and `detect-changes` read the stored graph, so without it the nodes for
 * files edited this turn are stale. One time cap covers all three calls.
 */
export function runCrg({ root, changedFiles, base, timeoutSec }) {
  let remaining = timeoutSec * 1000;
  const budget = { seconds: timeoutSec, left: () => Math.max(remaining, 1), spend: (ms) => { remaining -= ms; } };
  // `update` prints progress, not JSON; only its failure matters.
  const update = crgJson(["update", "--repo", root], root, budget, { json: false });
  if (update.error) return { failure: `crg failed: ${update.error}` };
  const impact = crgJson(["impact", "--repo", root, "--files", ...changedFiles, "--base", base, "--depth", "2", "--max-results", "200"], root, budget);
  if (impact.error) return { failure: `crg failed: ${impact.error}` };
  const changes = crgJson(["detect-changes", "--repo", root, "--base", base], root, budget);
  if (changes.error) return { failure: `crg failed: ${changes.error}` };
  const files = Array.isArray(impact.data?.impacted_files) ? impact.data.impacted_files.map(String) : [];
  const gaps = Array.isArray(changes.data?.test_gaps) ? changes.data.test_gaps.map((gap) => String(gap?.name ?? gap)) : [];
  return {
    failure: null,
    files,
    graph: {
      risk_score: typeof changes.data?.risk_score === "number" ? changes.data.risk_score : null,
      affected_flows: Array.isArray(changes.data?.affected_flows) ? changes.data.affected_flows.length : 0,
      test_gaps: gaps,
      truncated: Boolean(impact.data?.truncated || changes.data?.functions_truncated),
    },
  };
}

// --- grouping and ranking --------------------------------------------------
const KIND_WEIGHT = { test: 3, code: 2, config: 1.5, docs: 1 };

export function groupByFile(references, { changedFiles, exempt, removedSymbols }) {
  const changedDirs = new Set(changedFiles.map((file) => path.dirname(file)));
  const rows = new Map();
  for (const reference of references) {
    const kind = isTestPath(reference.file) ? "test" : classifyPath(reference.file, exempt);
    const row = rows.get(reference.file) ?? {
      file: reference.file, kind: kind === "asset" ? "docs" : kind, lines: [], symbols: [], graph: false, broken: false,
    };
    row.lines.push(reference.line);
    if (!row.symbols.includes(reference.symbol)) row.symbols.push(reference.symbol);
    row.graph = row.graph || reference.graph;
    row.broken = row.broken || removedSymbols.has(reference.symbol);
    rows.set(reference.file, row);
  }
  for (const row of rows.values()) {
    row.lines.sort((a, b) => a - b);
    row.score = KIND_WEIGHT[row.kind] + Math.min(row.lines.length, 5) * 0.5
      + (changedDirs.has(path.dirname(row.file)) ? 1 : 0)
      + (row.broken && row.kind !== "docs" ? 4 : 0)
      + (row.graph ? 2 : 0);
  }
  return [...rows.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

// --- rendering -------------------------------------------------------------
const positions = (row) => {
  const shown = row.lines.slice(0, 3).join(",");
  return row.lines.length > 3 ? `${shown} +${row.lines.length - 3}` : shown;
};
const referenceRow = (row) => `- ${`${row.file}:${positions(row)}`.padEnd(32)} → ${row.symbols.join(", ")}${row.graph ? " ·graph" : ""}`;

const SECTION_CAPS = { test: 15, code: 40, doc: 15, wire: 24 };

// The summary is one line and the tests row is one row: a change that renames
// forty symbols must not turn either into a paragraph.
const nameList = (names, cap) => (names.length > cap ? `${names.slice(0, cap).join(", ")} +${names.length - cap} more` : names.join(", "));

export function renderMarkdown(model, config) {
  const { counts, symbols, noisy, untested, projectHasTests, adapter, engine, elapsedMs, failures, rows, brokenRows, notes, wire = { tokens: [], references: [] } } = model;
  const summaryParts = [
    `${counts.changed_files} files`, `${symbols.length} symbols`,
    `${counts.references} refs in ${counts.files} files`,
    `tests ${counts.test_files} files`, `docs/config ${counts.doc_files + counts.config_files}`,
  ];
  if (untested.length) summaryParts.push(`untested: ${nameList(untested, 5)}`);
  summaryParts.push(`broken refs: ${counts.broken}`);
  if (counts.wire_broken) summaryParts.push(`wire consumers: ${counts.wire_broken}`);
  if (noisy.length) summaryParts.push(`noisy: ${noisy.join(", ")}`);
  const engineName = adapter === "none" ? "no adapter" : adapter === "grep+crg" ? `${engine} + crg` : engine;
  const head = [
    `IMPACT (${engineName}, ${(elapsedMs / 1000).toFixed(1)}s): ${summaryParts.join(" · ")}`,
    `# Line numbers are current as of ${model.generated}. Read these before asserting anything about callers or tests.`,
  ];
  for (const failure of failures) head.push(`# adapter: ${engine} (${failure})`);

  // One definition of "already printed under Broken references", used by both
  // sections below: a docs file that merely *mentions* a removed name is not a
  // broken reference and still belongs in the prose section.
  const shownAsBroken = (row) => row.broken && (row.kind === "code" || row.kind === "config");
  const tests = rows.filter((row) => row.kind === "test").slice(0, SECTION_CAPS.test);
  const callers = rows.filter((row) => row.kind === "code" && !shownAsBroken(row));
  const prose = rows.filter((row) => (row.kind === "docs" || row.kind === "config") && !shownAsBroken(row)).slice(0, SECTION_CAPS.doc);
  // Callers are the only section trimmed to the line budget: broken references
  // are why the script exists, tests tell the finder what to run, and the docs
  // section is already the smallest. Overhead is a blank line and a heading per
  // section, plus the rows "Not expanded" will carry.
  // Above broken references, because this is the one nothing else in the
  // report can find: no import, no export, no graph edge — just a string that
  // two files both name. Built BEFORE the budget, because it is subtracted
  // from it: bumping `overhead` reserves this section's heading, not its body,
  // and 20 renamed routes with 6 consumers each rendered an 80-line cap as 165
  // lines while still telling the finder the callers were "cut at 80".
  // Capped in LINES, not in contracts: one contract with six consumers is six
  // rows, so a cap on tokens alone still let 20 renamed routes render a
  // 165-line section against an 80-line document.
  const wireLines = [];
  const changedWire = wire.tokens.filter((row) => row.state !== "added");
  let shown = 0;
  for (const token of changedWire) {
    if (wireLines.length >= SECTION_CAPS.wire) break;
    shown += 1;
    const name = token.verb ? `${token.verb} ${token.value}` : token.value;
    const became = token.to ? ` → ${token.to}` : " (removed)";
    const consumers = wire.references.filter((reference) => reference.token === token.key);
    wireLines.push(`- ${`${name}${became}`.padEnd(46)} ${token.file}`);
    if (token.noisy) {
      wireLines.push(`  - ${token.refs + token.weak_refs} consumers — more than the report lists, so the count below is a floor, not a ceiling. A contract this widely named is the change's biggest risk, not noise: grep \`${token.anchors[0]}\` yourself.`);
      continue;
    }
    for (const reference of consumers.slice(0, 6)) {
      const tags = [reference.match === "weak" ? "·weak" : null, reference.generated ? "·generated" : null, reference.kind === "docs" ? "(docs)" : null].filter(Boolean);
      wireLines.push(`  - ${`${reference.file}:${reference.line}`.padEnd(34)} ${reference.fragment} ${tags.join(" ")}`.trimEnd());
    }
    if (consumers.length > 6) wireLines.push(`  - +${consumers.length - 6} more in impact.json`);
    if (consumers.length === 0) {
      wireLines.push(`  - no consumer in this tree — a base-URL constant, a generated client, or a caller outside this repo. Zero found is UNKNOWN, not safe.`);
    }
    if (token.to && token.to_refs === 0) wireLines.push(`  - nothing names the new value either: who serves ${token.to}?`);
    // Named, never resolved. Two same-hunk candidates scoring the same overlap
    // means the only signal there is has run out — printing one of them as
    // `→ x` would be a coincidence asserted as a fact, and wrong half the time.
    if (token.ambiguous) wireLines.push(`  - added in the same hunk: ${token.ambiguous.join(" or ")} — which one this became is for you to say, not the script`);
  }
  const cutWire = changedWire.length - shown;
  if (cutWire > 0) wireLines.push(`  - +${cutWire} more contract${cutWire === 1 ? "" : "s"} changed; impact.json has all of them`);

  const overhead = 2 * 6 + noisy.length + notes.length + (untested.length ? 1 : 0) + 1;
  const budget = config.maxLines - head.length - wireLines.length - brokenRows.length - tests.length - prose.length - overhead;
  const shownCallers = callers.slice(0, Math.max(0, Math.min(SECTION_CAPS.code, budget)));
  const cutCallers = callers.length - shownCallers.length;

  const out = [...head];
  const section = (title, lines) => { if (lines.length) out.push("", title, ...lines); };
  section("## Wire contracts — coupled by a string, not by an import   ← angle C: open each consumer", wireLines);
  section("## Broken references — still reference a removed or renamed symbol   ← angle B/C: check every one",
    brokenRows.map((row) => `- ${`${row.file}:${row.line}`.padEnd(32)} → ${row.symbol} (${row.state})`));
  const testLines = tests.map(referenceRow);
  if (untested.length && projectHasTests) {
    testLines.push(`- ${`untested: ${nameList(untested, 12)}`.padEnd(32)} (no test file names them; project has tests)`);
  }
  section("## Tests that reference the change (run them; a changed symbol with no test is a finding)", testLines);
  section("## Callers and references (code)", shownCallers.map(referenceRow));
  section("## Docs and config that mention the change", prose.map(referenceRow));
  const leftovers = [
    ...noisy.map((name) => `- ${name} — ${model.noisyCounts[name]} references (generic); grep it yourself if your angle needs it`),
    ...(cutCallers ? [`- ${cutCallers} lower-ranked caller files cut at ${config.maxLines} lines; impact.json has all ${callers.length}`] : []),
    ...notes.map((note) => `- ${note}`),
  ];
  section("## Not expanded", leftovers);
  return `${out.join("\n")}\n`;
}

// --- assembly --------------------------------------------------------------
export function analyse({ scope, root: rootOverride, base: baseOverride, adapter: requested, extraSymbols = [], ignorePaths = [], config, now = () => Date.now() }) {
  const started = now();
  const generated = new Date(started).toISOString().replace(/\.\d+Z$/, "Z");
  if (scope.plain || scope.repos.length === 0) {
    return {
      markdown: "IMPACT: no repository — no impact analysis (the scope is plain files; read them from the scope bundle).\n",
      json: { schema: SCHEMA, adapter: "none", engine: null, elapsed_ms: 0, failures: [], repo: null, changed_files: [], symbols: [], references: [], counts: { references: 0, files: 0, caller_files: 0, test_files: 0, doc_files: 0, config_files: 0, broken: 0, changed_files: 0 }, untested: [], project_has_tests: false, noisy: [], graph: null, wire: { tokens: [], references: [], unresolved: [] }, truncated: scope.truncated },
      summary: "IMPACT: no repository — no impact analysis",
    };
  }
  const repo = scope.repos[0];
  const root = rootOverride || repo.root;
  const base = baseOverride || repo.base;
  const notes = scope.repos.length > 1
    ? [`scope spans ${scope.repos.length} repositories; impact covers ${root} only — the others are in the scope bundle`]
    : [];

  const files = repo.files.filter((entry) => entry.status !== "D");
  const changedFiles = files.map((entry) => entry.path);
  const defined = changedSymbols(repo.diff);
  const symbols = rankSymbols(defined, fileSymbols(repo.files), config, extraSymbols);
  if (defined.length > config.maxSymbols) {
    notes.push(`${defined.length - config.maxSymbols} lower-ranked changed symbols not searched (impact.maxSymbols is ${config.maxSymbols})`);
  }
  const removedSymbols = new Set(symbols.filter((symbol) => symbol.state === "removed" || symbol.state === "renamed").map((symbol) => symbol.name));

  // Contracts the diff removed or renamed that couple by a STRING rather than
  // by an import: a route path, an event or topic name, an env var. The symbol
  // pass cannot see these — nothing imports a URL — and neither can a call
  // graph, whose two sides here are disconnected components.
  const wireTokens = wireSearchTokens(parseDiff(repo.diff), repo.files, config.wire ?? {});

  let adapter = requested === "none" ? "none" : "grep";
  let engine = null, references = [], noisy = [], noisyCounts = {}, failures = [], graph = null;
  let wire = { tokens: [], references: [] };
  if (requested !== "none") {
    engine = chooseEngine(root);
    const found = collectReferences({ engine, root, symbols, wireTokens, changedFiles, ignorePaths, config, timeoutMs: config.timeoutSec * 1000 });
    references = found.references;
    noisy = found.noisy;
    noisyCounts = found.noisyCounts;
    failures = found.failures;
    wire = found.wire;
    const wantsCrg = requested === "crg" || (requested === "auto" && crgAvailable(root));
    if (wantsCrg) {
      const crg = runCrg({ root, changedFiles, base, timeoutSec: config.timeoutSec });
      if (crg.failure) failures.push(crg.failure);
      else {
        adapter = "grep+crg";
        graph = crg.graph;
        const impacted = new Set(crg.files);
        for (const reference of references) if (impacted.has(reference.file)) reference.graph = true;
      }
    }
  }

  const exempt = config.exempt ?? { extensions: [], names: [] };
  for (const reference of references) {
    reference.kind = isTestPath(reference.file) ? "test" : classifyPath(reference.file, exempt);
  }
  for (const reference of wire.references) {
    reference.kind = isTestPath(reference.file) ? "test" : classifyPath(reference.file, exempt);
  }
  const rows = groupByFile(references, { changedFiles, exempt, removedSymbols });
  const brokenRows = references
    .filter((reference) => removedSymbols.has(reference.symbol) && (reference.kind === "code" || reference.kind === "config"))
    .map((reference) => ({ ...reference, state: symbols.find((symbol) => symbol.name === reference.symbol).state }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const testedNames = new Set(references.filter((reference) => reference.kind === "test").map((reference) => reference.symbol));
  const projectHasTests = hasTests(root, changedFiles);
  const untested = symbols
    .filter((symbol) => symbol.kind !== "file" && symbol.state !== "removed" && !testedNames.has(symbol.name) && !isTestPath(symbol.file))
    .map((symbol) => symbol.name);
  if (graph) for (const gap of graph.test_gaps) if (!untested.includes(gap)) untested.push(gap);

  const GENERATED = /(^|\/)(generated|__generated__)(\/|$)|\.gen\.|\.generated\./;
  for (const reference of wire.references) reference.generated = GENERATED.test(reference.file);

  const counted = (kind) => new Set(references.filter((reference) => reference.kind === kind).map((reference) => reference.file)).size;
  const counts = {
    references: references.length,
    files: new Set(references.map((reference) => reference.file)).size,
    caller_files: counted("code"), test_files: counted("test"), doc_files: counted("docs"), config_files: counted("config"),
    // brokenRows is already code-or-config: a workflow still calling a deleted
    // script is the same contract break as a caller still calling it, and this
    // count is what fires tier.mjs's escalation.
    broken: brokenRows.length,
    // Consumers FOUND, not contracts changed: gating tier.mjs's marker on a
    // literal having moved would escalate every route edit and mean nothing.
    // Docs mentions and generated clients are reported but do not count — the
    // fix for a generated file is to regenerate it.
    // A floor when a token is `noisy`: its reference list is capped, so this
    // counts what the report can name. It is never zero where consumers exist,
    // which is what the wireBreak marker turns on.
    wire_broken: wire.references.filter((reference) => !reference.generated && reference.kind !== "docs").length,
    changed_files: changedFiles.length,
  };
  const model = {
    generated, adapter, engine, elapsedMs: now() - started, failures, counts, symbols, noisy, noisyCounts,
    untested: projectHasTests ? untested : [], projectHasTests, rows, brokenRows, notes, wire,
  };
  const markdown = renderMarkdown(model, config);
  return {
    markdown,
    summary: markdown.split("\n")[0],
    json: {
      schema: SCHEMA, adapter, engine, elapsed_ms: model.elapsedMs, failures, repo: root,
      changed_files: files.map((entry) => ({ path: entry.path, status: entry.status, kind: classifyPath(entry.path, exempt) })),
      symbols: symbols.map((symbol) => ({
        name: symbol.name, file: symbol.file, kind: symbol.kind, state: symbol.state,
        refs: references.filter((reference) => reference.symbol === symbol.name).length,
        test_refs: references.filter((reference) => reference.symbol === symbol.name && reference.kind === "test").length,
        graph_callers: references.filter((reference) => reference.symbol === symbol.name && reference.graph).length,
      })),
      references, counts, untested: model.untested, project_has_tests: projectHasTests, noisy, graph,
      wire: {
        tokens: wire.tokens,
        references: wire.references,
        // A contract nothing in this tree names is not "safe": the consumer may
        // be a mobile app, a webhook, another repo, or a base URL held in a
        // constant. The brief says so; only the finder can settle it.
        unresolved: wire.tokens.filter((token) => !token.noisy && token.refs === 0 && token.weak_refs === 0)
          .map((token) => (token.verb ? `${token.verb} ${token.key}` : token.key)),
      },
      truncated: scope.truncated,
    },
  };
}

// Does the project have tests at all? Without that, "untested: X" is noise in
// a repo that has no tests to begin with.
function hasTests(root, changedFiles) {
  if (changedFiles.some(isTestPath)) return true;
  const listed = spawnSync("git", ["-C", root, "ls-files", "--", "*test*", "*spec*", "*_test.go"], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) return false;
  return listed.stdout.split("\n").some((file) => file && isTestPath(file));
}

// --- CLI -------------------------------------------------------------------
const ADAPTERS = new Set(["auto", "grep", "crg", "none"]);

// The config layer type-checks but does not range-check, and `timeoutSec`
// reaches spawnSync, where a zero or negative value is an uncaught RangeError.
// A repository is one of the layers, so this is a trust boundary: say which
// value was refused and carry on with the shipped default.
const LIMITS = ["timeoutSec", "maxSymbols", "maxRefsPerSymbol", "maxLines", "minSymbolLength"];

export function normaliseLimits(impact, defaults = FALLBACK.impact) {
  const out = { ...impact };
  for (const key of LIMITS) {
    if (Number.isFinite(out[key]) && out[key] > 0) continue;
    process.stderr.write(`impact.mjs: ignoring impact.${key} (${JSON.stringify(out[key])}) — expected a positive number; using ${defaults[key]}\n`);
    out[key] = defaults[key];
  }
  return out;
}

export function parseArgs(argv) {
  const options = { symbol: [] };
  const flags = ["scope", "out", "base", "adapter", "symbol", "timeout", "max-lines", "root"];
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].startsWith("--") ? argv[i].slice(2).split(/=(.*)/s) : [null, null];
    if (!name || !flags.includes(name)) throw Object.assign(new Error(`unknown argument ${argv[i]}`), { exitCode: 2 });
    const value = inline ?? argv[++i];
    if (value === undefined) throw Object.assign(new Error(`--${name} needs a value`), { exitCode: 2 });
    if (name === "symbol") options.symbol.push(value); else options[name] = value;
  }
  return options;
}

export function main(argv, { log = console.log } = {}) {
  const options = parseArgs(argv);
  const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });
  for (const required of ["scope", "out"]) if (!options[required]) throw usage(`--${required} is required`);
  const adapter = options.adapter ?? "auto";
  if (!ADAPTERS.has(adapter)) throw usage(`--adapter must be one of ${[...ADAPTERS].join(", ")}`);

  const scopeFile = path.resolve(options.scope);
  let scopeText;
  try {
    scopeText = readFileSync(scopeFile, "utf8");
  } catch (error) {
    throw Object.assign(new Error(`cannot read the scope (${scopeFile}): ${error.message}`), { exitCode: 3 });
  }
  const positive = (value, name) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw usage(`--${name} needs a positive number`);
    return number;
  };

  const scope = parseScope(scopeText);
  const root = options.root ? path.resolve(options.root) : scope.repos[0]?.root;
  const config = loadConfig(root);
  const impact = { ...normaliseLimits(config.impact), exempt: config.exempt };
  if (options.timeout) impact.timeoutSec = positive(options.timeout, "timeout");
  if (options["max-lines"]) impact.maxLines = positive(options["max-lines"], "max-lines");

  // The work dir is often inside the repository under review: its own scope
  // bundle and impact.md name every changed symbol, and a reference to them is
  // a reference to this script's own output.
  const outDir = path.resolve(options.out);
  const inside = (target) => {
    const relative = path.relative(root ?? "", path.resolve(target));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
  };
  const ignorePaths = [inside(scopeFile), inside(outDir)].filter(Boolean);

  const result = analyse({ scope, root, base: options.base, adapter, extraSymbols: options.symbol, ignorePaths, config: impact });
  mkdirSync(outDir, { recursive: true });
  const markdownFile = path.join(outDir, "impact.md");
  writeFileSync(markdownFile, result.markdown);
  writeFileSync(path.join(outDir, "impact.json"), `${JSON.stringify(result.json, null, 1)}\n`);
  log(result.summary);
  log(`written: ${markdownFile}`);
  return result;
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`impact.mjs: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
