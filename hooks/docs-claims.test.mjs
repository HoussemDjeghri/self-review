// Run: node --test plugin/hooks/docs-claims.test.mjs   (or ./test.sh for everything)
//
// DESIGN §1 only allows a claim with a mechanism that enforces it. These are
// the claims whose mechanism can read the tree and decide: the authoritative
// REPO_ADDITIVE list, the CHANGELOG heading release.sh matches, the bash blocks
// SKILL.md tells a model to run. The docs' TEST COUNT is not one of them — it
// is a claim about a run, which a test inside that run cannot observe, so it
// moved to tools/check-doc-claims.mjs, which test.sh calls with the real total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT } from "./lib/config.mjs";
import { walkFiles } from "./lib/tree.mjs";

// Every path below is relative to the repository, not to the plugin: the docs
// this enforces (README, CHANGELOG, docs/) live beside `plugin/`, not inside
// it, and the suite it counts spans both.
const REPO = path.resolve(PLUGIN_ROOT, "..");

// One walk for the three questions below — which files are suites, which are
// documents, which are modules — because the directory lists that used to
// answer them were each one level deep and each went stale on its own
// schedule. `walkFiles` prunes the eval corpora, whose fixture repositories
// hold both `.test.mjs` and `.md` that are review bait, not this suite's.
let tree;
const repoFiles = () => (tree ??= walkFiles(REPO));

// README describes the plugin as it is, so *every* count in it has to be
// current — the first version of this test checked one phrasing and sat green
// beside a second, stale one twenty lines below. STATUS keeps a section per
// phase, where an earlier count is what the suite was then: history, not a
// stale fact, so only its last claim is live.
// The same class of stale claim arrived twice — README in 0.2.2, DESIGN §3 and
// STATUS in 0.3.0 — and DESIGN §0.1 says the second arrival makes the mechanism
// the fix, not the sentence. These are the keys a repository has NOT been able
// to set since REPO_ADDITIVE (0.2.2); the CHANGELOG is exempt because its old
// entries are a record of what those versions shipped.
const REPO_DOCS = ["README.md", "docs/DESIGN.md", "docs/STATUS.md", "plugin/skills/self-review/SKILL.md",
  "plugin/skills/self-review/references/briefs.md", "plugin/skills/self-review/references/angles.md"];

// The one place the docs are allowed to state what a repository may set. An
// earlier version of this test sniffed all six docs for English sentences that
// offered a closed key; three rounds found three ways prose escaped it (a
// second line, a backwards mention, a hard wrap), because "no sentence anywhere
// claims X" is not something a regex can decide. This checks the claim that is
// authoritative, exactly, and that there is only one of it. Prose elsewhere is
// unchecked — deliberately, and it must defer to this line rather than restate it.
const ANCHOR = /`REPO_ADDITIVE` = ([^.]*(?:\.[a-zA-Z][^.]*)*?),? appended/;

export function statedAdditive(text) {
  const found = text.match(ANCHOR);
  return found ? [...found[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : null;
}

test("the docs state REPO_ADDITIVE in exactly one place, and it is the true set", async () => {
  const { REPO_ADDITIVE } = await import("./lib/config.mjs");
  const stated = REPO_DOCS
    .map((file) => [file, statedAdditive(readFileSync(path.join(REPO, file), "utf8"))])
    .filter(([, keys]) => keys);
  assert.deepEqual(stated.map(([file]) => file), ["docs/DESIGN.md"],
    "exactly one doc may carry the authoritative list; the others defer to it");
  assert.deepEqual(stated[0][1], [...REPO_ADDITIVE],
    `docs/DESIGN.md states ${stated[0][1].join(", ")}; the code allows ${[...REPO_ADDITIVE].join(", ")}`);
});

test("the anchor reads the list, not the sentence around it", () => {
  assert.deepEqual(statedAdditive("x `REPO_ADDITIVE` = `tier.riskPaths`, `tier.riskContent`, appended never substituted. More prose."),
    ["tier.riskPaths", "tier.riskContent"]);
  assert.deepEqual(statedAdditive("`REPO_ADDITIVE` = `a.b` appended"), ["a.b"], "one key, no comma");
  assert.equal(statedAdditive("REPO_ADDITIVE is the closed set of keys."), null, "a mention is not the statement");
});

test("CHANGELOG.md's first heading is the one tools/release.sh looks for", () => {
  // `release.sh` finds the hand-written body by `^## <version> — unreleased$`
  // and, on a miss, silently drafts notes from commit subjects and prepends a
  // new section ABOVE the section it did not recognise — which is then orphaned
  // out of the release notes forever. A plain `## Unreleased` shipped two
  // rounds' worth of entries that way before a reviewer caught it, and nothing
  // in the suite noticed, so the heading's shape is now enforced.
  const first = readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8").match(/^## .*$/m);
  assert.ok(first, "CHANGELOG.md has no `## ` heading at all");
  assert.match(first[0], /^## \d+\.\d+\.\d+ — (unreleased|\d{4}-\d{2}-\d{2})$/,
    `the first heading is ${JSON.stringify(first[0])}; release.sh greps "^## <version> — unreleased$" (em dash), and a released section carries its date`);
});

// SKILL.md's commands are copied out and run by a model, so a block that does
// not parse is a defect in the skill, not a typo in a doc. Two checks, because
// substitution hides the one that bit: `--review <session id>` parsed fine once
// the placeholder was replaced, but as written the shell reads `<session` and
// `id>` as redirections and silently eats the *next* flag as a filename.
const bashBlocks = (text) =>
  [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => ({ code: m[1], line: text.slice(0, m.index).split("\n").length }));

test("every bash block in SKILL.md parses, and no placeholder in one holds a space", () => {
  const text = readFileSync(path.join(REPO, "plugin/skills/self-review/SKILL.md"), "utf8");
  const blocks = bashBlocks(text);
  assert.ok(blocks.length >= 5, `found ${blocks.length} bash blocks — the fence pattern has gone stale`);
  for (const { code, line } of blocks) {
    const spaced = [...code.matchAll(/<[^>\n]*>/g)].map((m) => m[0]).filter((ph) => /\s/.test(ph));
    assert.deepEqual(spaced, [], `SKILL.md:${line} — a placeholder with a space is two words to the shell`);
    const parsed = spawnSync("bash", ["-n"], { input: code.replace(/<[^>\n]*>/g, "PLACEHOLDER"), encoding: "utf8" });
    assert.equal(parsed.status, 0, `SKILL.md:${line} does not parse:\n${parsed.stderr}`);
  }
});

// A duplicated section is invisible to every other check here: the counts still
// match, the anchored claim still parses, and the file still reads correctly
// until the two copies drift. One arrived from a bad slice edit (an insertion
// whose end offset landed before its start), which re-emitted 75 lines
// including a heading, and the stale copy contradicted the live one about what
// had just been decided.
test("no document repeats a section heading", () => {
  const offenders = [];
  for (const file of REPO_DOCS) {
    const seen = new Map();
    readFileSync(path.join(REPO, file), "utf8").split("\n").forEach((line, index) => {
      if (!/^#{2,3} \S/.test(line)) return;
      const heading = line.trim();
      if (seen.has(heading)) offenders.push(`${file}:${index + 1} repeats "${heading}" from line ${seen.get(heading)}`);
      else seen.set(heading, index + 1);
    });
  }
  assert.deepEqual(offenders, [], "a repeated heading is usually half of a duplicated section");
});

// `new URL(import.meta.url).pathname` is a URL component, so it keeps the
// percent-encoding: under a directory named `cold run` it hands back
// `cold%20run`, and every path built on it fails ENOENT on a directory that is
// plainly there. Eleven files resolved their own root that way, which meant the
// plugin was broken for anyone whose checkout, home directory or plugin cache
// had a space in it — and the cold run, whose own work directory is called
// `cold run`, failed every entry point for a whole round while the suite here
// stayed green, because this repository's path happens to have no space.
// `fileURLToPath` is the decoding counterpart and the only correct spelling.
test("no module resolves its own path through URL.pathname", () => {
  // This file states the bad spelling twice — in the comment above and in the
  // regex below — for the same reason no-network.test.mjs exempts test files:
  // the scanner has to be allowed to name what it is looking for.
  const self = path.relative(REPO, fileURLToPath(import.meta.url));
  const offenders = repoFiles()
    .filter((file) => file.endsWith(".mjs") && file !== self)
    .filter((file) => /new URL\(\s*import\.meta\.url\s*\)\.pathname/.test(readFileSync(path.join(REPO, file), "utf8")));
  assert.deepEqual(offenders, [], "use fileURLToPath(import.meta.url): .pathname keeps %20 and breaks on any path with a space");
});

// The reason the rule above exists, asserted rather than described: the two
// spellings agree until the path has a space in it, and then only one is a path.
test("URL.pathname and fileURLToPath disagree exactly where it matters", () => {
  const spaced = new URL("file:///tmp/cold run/x.mjs");
  assert.equal(spaced.pathname, "/tmp/cold%20run/x.mjs", "the URL component keeps the encoding");
  assert.equal(fileURLToPath(spaced), "/tmp/cold run/x.mjs", "and this is the one that is a filesystem path");
});

// The property this repository's layout exists to create, which until now was
// stated once in CLAUDE.md and enforced nowhere — the same unenforced-claim
// shape that produced docs-claims.test.mjs and no-network.test.mjs in the first
// place. It fails in two directions and neither is loud: a dev-only file under
// `plugin/` ships to every install (the 2.9 MB this split removed), and a
// runtime file back at an old top-level path ships to nobody, and test.sh's
// walk starts at `plugin` and `tools` and never reaches it. Directory granularity is deliberate:
// `skills/` legitimately holds markdown and `*.test.mjs` legitimately ships, so
// the rule is where a file lives, not what it is named. Adding a runtime
// directory therefore means editing this list on purpose.
// README.md is runtime by the same argument as LICENSE: it is the public
// repository's whole front page, and the release copies the folder verbatim,
// so the file a visitor reads has to be the file that lives here.
const PLUGIN_TOP = [".claude-plugin", "agents", "config", "hooks", "scripts", "skills", "LICENSE", "README.md"];
const MOVED_OUT = [".claude-plugin", "agents", "config", "hooks", "scripts", "skills"];

test("only runtime material lives under plugin/, and no runtime directory came back", () => {
  const strays = readdirSync(PLUGIN_ROOT).filter((name) => !PLUGIN_TOP.includes(name));
  assert.deepEqual(strays, [], "everything under plugin/ is downloaded by every install; development material is not runtime");

  const resurrected = MOVED_OUT.filter((dir) => existsSync(path.join(REPO, dir)));
  assert.deepEqual(resurrected, [], "a runtime directory at the repository root is shipped to nobody");
});
