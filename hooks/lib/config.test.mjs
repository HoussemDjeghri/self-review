// Run: node --test plugin/hooks/lib/config.test.mjs   (or ./test.sh for everything)
// The repo layer only. The user layer and the merge rules are covered where
// they are enforced, in hooks/self-review-gate.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMain, loadConfig, PLUGIN_ROOT, REPO_CONFIG_FILE } from "./config.mjs";

const repoWith = (contents) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-review-repo-"));
  writeFileSync(path.join(root, REPO_CONFIG_FILE), typeof contents === "string" ? contents : JSON.stringify(contents));
  return root;
};
const noUserConfig = () => { process.env.SELF_REVIEW_CONFIG = path.join(tmpdir(), "config-test-no-such-config.json"); };

test("a byte-order mark is encoding, not content", () => {
  noUserConfig();
  const defaults = loadConfig();
  // Editors on Windows write one by default. Before this, JSON.parse choked on
  // it and the repository's additions were dropped with a warning that named a
  // character the author could not see.
  const root = repoWith(`\uFEFF${JSON.stringify({ tier: { riskContent: { destructive: ["wipe-tenant"] } } })}`);
  assert.ok(loadConfig(root).tier.riskContent.destructive.includes("wipe-tenant"));
  assert.deepEqual(loadConfig(root).tier.riskContent.security, defaults.tier.riskContent.security, "and nothing else moves");
});

test("a repository adds marker words and nothing else", () => {
  noUserConfig();
  const defaults = loadConfig();
  const root = repoWith({ tier: { s: { maxLines: 40 }, riskPaths: { payments: ["subscriptions"] } }, brief: { maxTokens: 1200 } });
  const config = loadConfig(root);
  assert.deepEqual(config.tier.riskPaths.payments, [...defaults.tier.riskPaths.payments, "subscriptions"],
    "its own word for payments is appended — a replaced list is a list it could empty");
  assert.equal(config.tier.s.maxLines, defaults.tier.s.maxLines, "a threshold that would call any diff small is not its to set");
  assert.equal(config.brief.maxTokens, defaults.brief.maxTokens, "nor the budget the finders read the diff with");
});

test("a repository's added words are deduped, and the cap counts distinct ones", () => {
  noUserConfig();
  const defaults = loadConfig();
  const root = repoWith({ tier: { riskPaths: { payments: ["subscriptions", "subscriptions", "dunning"] } } });
  const added = loadConfig(root).tier.riskPaths.payments.slice(defaults.tier.riskPaths.payments.length);
  assert.deepEqual(added, ["subscriptions", "dunning"],
    "a word repeated in one file must not spend the pattern budget three times");
});

test("a repository cannot make its own review weaker, by any door", () => {
  noUserConfig();
  const defaults = loadConfig();
  // Every one of these was a working bypass at some point in the review of this
  // very change: `ignore: ["**"]` reviewed zero files, empty marker lists
  // silenced every marker, and the rest switch off the machinery outright.
  const root = repoWith({
    tier: { ignore: ["**"], riskContent: { destructive: [] }, finders: { maxPerRound: 1 }, l: { minLines: 999999 } },
    gate: { maxReminders: 0 },
    exempt: { extensions: [".ts"] },
    pollGuard: { maxChecks: 99 },
    impact: { maxLines: 20 },
    preflight: { skip: ["tests"] },
  });
  const config = loadConfig(root);
  assert.deepEqual(config.tier.ignore, defaults.tier.ignore, "it cannot hide files from the scan");
  assert.deepEqual(config.tier.riskContent.destructive, defaults.tier.riskContent.destructive, "nor empty a marker list");
  assert.equal(config.tier.finders.maxPerRound, defaults.tier.finders.maxPerRound, "nor cut the finders");
  assert.equal(config.tier.l.minLines, defaults.tier.l.minLines, "nor raise the bar for L out of reach");
  assert.equal(config.gate.maxReminders, defaults.gate.maxReminders);
  assert.deepEqual(config.exempt.extensions, defaults.exempt.extensions);
  assert.equal(config.pollGuard.maxChecks, defaults.pollGuard.maxChecks);
  assert.equal(config.impact.maxLines, defaults.impact.maxLines);
  assert.deepEqual(config.preflight.skip, defaults.preflight.skip, "nor skip the checks that run before the finders");
});

test("no repo file, a broken one, or no root at all: the user's config stands", () => {
  noUserConfig();
  const defaults = loadConfig();
  assert.deepEqual(loadConfig(mkdtempSync(path.join(tmpdir(), "self-review-empty-"))), defaults);
  assert.deepEqual(loadConfig(repoWith("{ not json")), defaults);
  assert.deepEqual(loadConfig(repoWith(["tier"])), defaults, "an array is not a config object");
  assert.deepEqual(loadConfig(), defaults);
});

test("a repository's risk patterns are literals: a checked-in catastrophic regex cannot hang the review", () => {
  noUserConfig();
  const root = repoWith({ tier: { riskContent: { security: ["(a+)+$", "sudo("] }, riskPaths: { auth: ["src/auth/"] } } });
  const config = loadConfig(root);
  const [nested, call] = config.tier.riskContent.security.slice(-2);
  const started = Date.now();
  assert.equal(new RegExp(nested).test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"), false, "no backtracking: it is a literal now");
  assert.ok(Date.now() - started < 500, "and it says so in milliseconds");
  assert.ok(new RegExp(nested).test("a line containing (a+)+$ verbatim"), "the literal still matches itself");
  assert.ok(new RegExp(call).test("sudo(payload)"), "an ordinary keyword is unaffected");
  assert.ok(new RegExp(config.tier.riskPaths.auth.at(-1)).test("src/auth/session.ts"));
});

test("the repo's own config file is contained before it is opened", () => {
  // Found by the boundary finder in round 8, reproduced against the live tool:
  // a committed `.self-review.json -> /dev/zero` (nine bytes of ordinary git)
  // made every entry point read an endless stream — 7.3 GB resident in four
  // seconds, no output and no error, so the review never reached the risk
  // markers at all. The checks are the deleted `declaringFiles()`'s; what was
  // missing is that they were never applied to this file.
  noUserConfig();
  const defaults = loadConfig();
  const link = (target) => {
    const root = mkdtempSync(path.join(tmpdir(), "self-review-repo-"));
    symlinkSync(target, path.join(root, REPO_CONFIG_FILE));
    return root;
  };

  const started = Date.now();
  assert.deepEqual(loadConfig(link("/dev/zero")).tier, defaults.tier, "a character device is not a config file");
  assert.ok(Date.now() - started < 1000, "and it is refused without being read");

  const outside = mkdtempSync(path.join(tmpdir(), "self-review-outside-"));
  const escape = path.join(outside, "elsewhere.json");
  writeFileSync(escape, JSON.stringify({ tier: { riskPaths: { auth: ["from-outside"] } } }));
  assert.deepEqual(loadConfig(link(escape)).tier.riskPaths.auth, defaults.tier.riskPaths.auth,
    "a symlink out of the repository is refused — a parse error would quote the file it read");

  const dir = mkdtempSync(path.join(tmpdir(), "self-review-repo-"));
  mkdirSync(path.join(dir, REPO_CONFIG_FILE));
  assert.deepEqual(loadConfig(dir).tier, defaults.tier, "nor is a directory");

  const big = mkdtempSync(path.join(tmpdir(), "self-review-repo-"));
  writeFileSync(path.join(big, REPO_CONFIG_FILE), " ".repeat(1024 * 1024 + 1) + "{}");
  assert.deepEqual(loadConfig(big).tier, defaults.tier, "nor a file too big to be a word list");
});

test("a key inherited from Object.prototype is not a key the schema declares", () => {
  // Found by the boundary finder in round 8, against the live tool: `name in
  // base` was true for `__proto__`, so a 48-byte checked-in config crashed
  // every entry point that loads config — the reviewed repository turning off
  // its own reviewer by making it throw.
  //
  // Every payload here is a raw JSON string on purpose: `{__proto__: x}` in a
  // JS object literal sets the prototype instead of adding the key, so a test
  // written with literals would stringify to `{}` and pass against the bug.
  noUserConfig();
  const defaults = loadConfig();
  for (const key of ["__proto__", "constructor", "toString"]) {
    const root = repoWith(`{"tier": {"riskPaths": {"${key}": ["pwn"]}, "riskContent": {"security": ["sudo("]}}}`);
    const config = loadConfig(root);
    assert.deepEqual(config.tier.riskPaths[key], defaults.tier.riskPaths[key], `${key} is not a marker list`);
    assert.equal(Object.getPrototypeOf(config.tier.riskPaths), Object.prototype, `${key} did not reassign a prototype`);
    assert.equal(config.tier.riskContent.security.at(-1), "sudo\\(", "the honest key beside it still lands");
  }

  // The same guard sits in merge(), on the user's own config, and takes a
  // different payload: merge() type-checks against `base[key]`, and for
  // `__proto__` that is an object, so an object-valued payload gets past the
  // kind() check that rejects the repo-layer one and reaches an assignment
  // that invokes the inherited setter.
  const userConfig = path.join(mkdtempSync(path.join(tmpdir(), "self-review-user-")), "config.json");
  writeFileSync(userConfig, '{"tier": {"riskPaths": {"__proto__": {"auth": ["x"]}}}}');
  process.env.SELF_REVIEW_CONFIG = userConfig;
  const merged = loadConfig();
  assert.deepEqual(merged.tier.riskPaths.auth, defaults.tier.riskPaths.auth, "the user layer is guarded the same way");
  assert.equal(Object.getPrototypeOf(merged.tier.riskPaths), Object.prototype, "and nothing reassigned a prototype");
  noUserConfig();
});

test("a repository cannot excuse itself from the scan, but its words still land", () => {
  noUserConfig();
  const root = repoWith({ tier: { ignore: ["**"], riskContent: { security: ["sudo("] } } });
  const config = loadConfig(root);
  assert.deepEqual(config.tier.ignore, loadConfig().tier.ignore, "the ignore list is not its to write");
  assert.equal(config.tier.riskContent.security.at(-1), "sudo\\(", "the word it added is appended, still escaped");
});

// isMain, and the bug it exists for. Every helper's CLI block used to sit
// behind `import.meta.url === \`file://${process.argv[1]}\``; Node resolves the
// ESM main entry to its realpath, so reaching a script through a symlink made
// the two sides differ and the whole CLI silently did not run — exit 0, no
// output, no files. It was found in the eval sandbox, whose temp dirs live
// under macOS's /var → /private/var symlink, after every review run there had
// quietly computed its tier by hand.
test("a script reached through a symlink still runs its CLI", () => {
  const at = mkdtempSync(path.join(tmpdir(), "self-review-link-"));
  const link = path.join(at, "plugin");
  symlinkSync(PLUGIN_ROOT, link);

  const args = ["--scope", "/dev/null", "--out", at, "--round", "1"];
  const result = spawnSync(process.execPath, [path.join(link, "scripts", "tier.mjs"), ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The silent no-op was exit 0 with empty output, so only the output falsifies it.
  assert.match(result.stdout, /^tier [SML] · round 1/, "the CLI block did not run through the symlink");
});

test("isMain matches a path that URL-encoding would change, and rejects another file", () => {
  const at = mkdtempSync(path.join(tmpdir(), "self-review main "));   // a space, which `file://${path}` never encoded
  const script = path.join(at, "entry.mjs");
  writeFileSync(script, "");
  const argv = process.argv[1];
  try {
    process.argv[1] = script;
    assert.equal(isMain(pathToFileURL(script).href), true);
    assert.equal(isMain(pathToFileURL(path.join(at, "other.mjs")).href), false);
  } finally { process.argv[1] = argv; }
});

// The finding this test exists for: the first fix migrated the five helpers in
// scripts/ and left the same guard live in evals/run.mjs and evals/merge.mjs —
// including the one test.sh invokes, i.e. the tool that measures the fix. Two
// reviewers found it independently, which says the defect is a class and not a
// site. Grepping is the only check that covers a file nobody has written yet.
// evals/corpora/ is excluded on purpose: those are sample apps the plugin
// reviews, not code it runs, and one of them carries the pattern as fixture text.
test("no CLI in this repo still spells its main-guard the broken way", () => {
  // Three levels, not two: this file is `plugin/hooks/lib/`, and the scan has
  // to reach the whole checkout. Two stops at `plugin/`, which silently drops
  // `evals/` — where the two files that motivated this test actually live.
  const root = path.resolve(PLUGIN_ROOT, "..");
  // Walked rather than `git grep`ed: the two files the reviewers caught were
  // new and untracked, which is exactly what git grep cannot see and exactly
  // when this rule is easiest to break.
  // Assembled, not written out, so this file does not match its own rule; SELF
  // skips it anyway for the copy of the needle in the comment above.
  const NEEDLE = "if (import.meta.url " + "===";
  const SELF = fileURLToPath(import.meta.url);
  const offenders = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "corpora"].includes(entry.name)) continue;   // corpora holds sample apps the plugin reviews, not code it runs
      const at = path.join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(at, name);
      // The `if (` is what separates a guard from the prose in this very file,
      // which quotes the broken spelling to explain why it is broken.
      else if (entry.name.endsWith(".mjs") && at !== SELF && readFileSync(at, "utf8").includes(NEEDLE)) offenders.push(name);
    }
  };
  walk(root, "");
  assert.deepEqual(offenders, [], "use isMain(import.meta.url) instead");
});
