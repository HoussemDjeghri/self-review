/**
 * Path classification shared by impact.mjs and tier.mjs.
 *
 * The gate's exempt lists (config `exempt.extensions`, `exempt.names`) answer
 * one question — "does this file need a review?" — and both phase-3 scripts
 * need the next one: which *kind* of non-code it is, because a docs finder and
 * a config finder read different angles. The lists are therefore split here
 * rather than re-typed: docs and asset extensions are named, everything else
 * the gate exempts is configuration, and anything the gate would gate is code.
 * Keeping the split in one module is what keeps `tier.json`'s `kinds` and
 * `impact.md`'s sections describing the same file the same way.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

/** Exported: the wire scan needs the same answer, and a second copy diverged. */
export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf"]);
// The exempt *names* that are prose; the rest of that list (dotfiles like
// .gitignore, .npmrc) is configuration.
const DOC_NAMES = new Set(["license", "licence", "copying", "notice", "readme", "changelog", "authors", "contributors"]);
// Configuration whatever the extension says: CI, containers, IaC.
const CONFIG_PATTERNS = [
  ".github/workflows/**", ".gitlab-ci*", "Dockerfile*", "Containerfile*", "docker-compose*",
  "*.tf", "*.tfvars", "**/terraform/**", "**/k8s/**", "**/helm/**", "**/ansible/**",
];

// Globs, as much of them as the config lists actually use: `**/` spans
// directories, `*` and `?` stay inside one segment. A pattern with no slash
// matches the basename (`*.min.*`, `RUNBOOK*`), so a user does not have to
// write `**/` in front of every file-name rule.
export function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") { i += 1; source += "(?:[^/]*/)*"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern, filePath) {
  const target = pattern.includes("/") ? filePath : path.basename(filePath);
  return globToRegExp(pattern).test(target);
}

export const matchesAnyGlob = (patterns, filePath) => patterns.some((p) => matchesGlob(p, filePath));

/**
 * Exclusion entries as `rg -g '!x'`, `git grep :!x` and `grep --exclude-dir=x`
 * read them: a bare name excludes that path segment at any depth, so
 * `node_modules` also covers `packages/app/node_modules/y.js`. Anything with a
 * slash or a star is an ordinary glob.
 */
export function matchesExclude(patterns, filePath) {
  const segments = filePath.split("/");
  return patterns.some((pattern) => (/[*?/]/.test(pattern) ? matchesGlob(pattern, filePath) : segments.includes(pattern)));
}

// Test files are recognised by path, not by content: tier.mjs must not depend
// on preflight.sh having run (DESIGN §4.2), and impact.mjs ranks a hit in a
// test file above one in a caller because it tells the finder what to run.
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.|_test\.go$/;
export const isTestPath = (filePath) => TEST_PATH.test(filePath);

/**
 * "code" | "docs" | "config" | "asset" for one repo-relative path.
 * `exempt` is the gate's config block; passing it keeps a user who added an
 * extension to the exemption list from getting a file reviewed as code here.
 */
export function classifyPath(filePath, exempt = { extensions: [], names: [] }) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (ASSET_EXTENSIONS.has(ext)) return "asset";
  if (DOC_EXTENSIONS.has(ext)) return "docs";
  if (matchesAnyGlob(CONFIG_PATTERNS, filePath)) return "config";
  const exemptExt = new Set(exempt.extensions.map((e) => e.toLowerCase()));
  const exemptName = new Set(exempt.names.map((n) => n.toLowerCase()));
  // A dotfile has no extension to Node (`extname(".env") === ""`), which is
  // why the name list is consulted only when there is no extension — the same
  // rule the gate applies.
  if (ext) return exemptExt.has(ext) ? "config" : "code";
  if (DOC_NAMES.has(base)) return "docs";
  return exemptName.has(base) ? "config" : "code";
}

/**
 * Is this directory a self-review work dir? Matched on CONTENTS, never on name:
 * the work dir that cost the 2026-08-30 reporter ~3M tokens was called
 * `scratchpad/self-review/`, and the next one will be called something else.
 *
 * Two signatures, both needing two halves present together:
 *   - `intent.md` beside a `round-N` child — the work dir itself;
 *   - a `round-N` directory holding both `scope.diff` and `tier.json`.
 *
 * The halves are the point. A lone `impact.json`, `state/` or `intent.md` is a
 * plausible path in a real project, and a false match here does not cost a
 * refusal — it drops a real change out of review without saying so.
 */
export function isReviewPaperwork(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const hasRoundChild = entries.some((entry) => entry.isDirectory() && ROUND_DIR.test(entry.name));
  if (files.has("intent.md") && hasRoundChild) return true;
  return ROUND_DIR.test(path.basename(dir)) && files.has("scope.diff") && files.has("tier.json");
}
const ROUND_DIR = /^round-\d+$/;

/**
 * The repo-relative paperwork directory `filePath` sits under, or null.
 * Outermost match wins: that is the directory a user removes, and the one the
 * refusal message names.
 */
export function reviewPaperworkRoot(root, filePath) {
  const segments = filePath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const relative = segments.slice(0, depth).join("/");
    if (isReviewPaperwork(path.join(root, relative))) return relative;
  }
  return null;
}
