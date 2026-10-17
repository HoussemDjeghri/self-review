#!/usr/bin/env node
/**
 * branch-debt.mjs — this repository's id, and where its branch review stands.
 *
 * Usage:
 *   branch-debt.mjs --id [--repo <dir>]   print the id to opt the repository in under
 *   branch-debt.mjs [--repo <dir>]        print the opt-in, the branch, its baselines and its debt
 *
 * Opting in is a user-config entry, never a repository file:
 *   { "repos": { "<id>": { "branchDebt": { "maxLines": 500 } } } }
 * in ~/.claude/self-review/config.json (or $SELF_REVIEW_CONFIG).
 *
 * Read-only: it writes no ref, adopts nothing and prunes nothing — the Stop
 * gate is the only writer of `refs/self-review-reviewed/`. The debt counts the
 * paths the gate's extension and name exemptions call code; the gate also drops
 * the user's `exempt.paths`, so this figure can only be the higher of the two.
 */
import path from "node:path";
import { branchDebtFor, isMain, loadConfig } from "../hooks/lib/config.mjs";
import { repoId } from "../hooks/lib/repo-id.mjs";
import { REVIEWED_NS, baselines, branchOf, commitOf, mainCovered, mainOf, reviewedRefs, riskPathTest, smallestDebt, topOf, treeOf, worktreeTree } from "../hooks/lib/branch-debt.mjs";

const USAGE = `usage: branch-debt.mjs --id [--repo <dir>]   the id to opt the repository in under
       branch-debt.mjs [--repo <dir>]        the opt-in, the branch, its baselines and its debt
opt in from your user config (~/.claude/self-review/config.json or $SELF_REVIEW_CONFIG):
  { "repos": { "<id>": { "branchDebt": { "maxLines": 500 } } } }
`;

export function codeTest(config) {
  const exts = new Set(config.exempt.extensions.map((e) => e.toLowerCase()));
  const names = new Set(config.exempt.names.map((n) => n.toLowerCase()));
  return (rel) => {
    const ext = path.extname(rel).toLowerCase();
    return ext ? !exts.has(ext) : !names.has(path.basename(rel).toLowerCase());
  };
}

export function status(dir) {
  const top = topOf(dir);
  if (!top) return { error: `${dir} is not inside a git repository` };
  const config = loadConfig(top);
  const id = repoId(top);
  const opt = branchDebtFor(top, config);
  const out = { id, top, optedIn: Boolean(opt), maxLines: opt?.maxLines ?? null };
  if (!opt) return out;
  const main = mainOf(top, opt.main);
  const branch = branchOf(top);
  const refs = reviewedRefs(top) ?? [];
  Object.assign(out, { main: main?.name ?? null, branch, reviewed: refs.map((r) => `${REVIEWED_NS}${r.branch} ${r.commit.slice(0, 12)}`) });
  if (!main || !branch) return { ...out, debt: null, why: !main ? "main does not resolve" : "HEAD is detached" };
  const onMain = branch === main.local;
  // On main the gate judges the committed tree; uncommitted work there stays
  // under the per-turn rule.
  // The gate's first check on main, shared rather than copied: a head equal to,
  // or merged cleanly from, reviewed trees is covered, whatever one diff says.
  if (onMain) {
    const head = commitOf(top, "HEAD");
    if (head && mainCovered(top, refs, main.local, head)) return { ...out, onMain, debt: { lines: 0, files: 0, risky: [], base: head, from: "a reviewed tree (covered)" } };
  }
  const tree = onMain ? treeOf(top, "HEAD") : worktreeTree(top);
  const debt = tree && smallestDebt(top, baselines(top, refs, main, { onMain }), tree, { counts: codeTest(config), risky: riskPathTest(config.tier.riskPaths) });
  return { ...out, onMain, debt: debt && { lines: debt.lines, files: debt.files, risky: debt.risky, base: debt.base.commit, from: debt.base.label } };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--repo");
  const dir = at === -1 ? process.cwd() : args[at + 1];
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); process.exit(0); }
  const unknown = args.filter((a, i) => a !== "--id" && a !== "--repo" && args[i - 1] !== "--repo");
  if (unknown.length || (at !== -1 && !dir)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const top = topOf(dir);
  if (!top) { process.stderr.write(`branch-debt: ${dir} is not inside a git repository\n`); process.exit(1); }
  if (args.includes("--id")) { process.stdout.write(`${repoId(top)}\n`); process.exit(0); }
  const s = status(dir);
  const rows = [`id: ${s.id}`, `opted in: ${s.optedIn ? `yes, up to ${s.maxLines} lines` : "no — add repos.<id>.branchDebt.maxLines to your user config"}`];
  if (s.optedIn) {
    rows.push(`branch: ${s.branch ?? "(detached)"}${s.onMain ? " (main — defers nothing)" : ""}`, `main: ${s.main ?? "(unresolved)"}`);
    rows.push(...(s.reviewed.length ? s.reviewed.map((r) => `reviewed: ${r}`) : ["reviewed: none yet — the next Stop adopts main"]));
    if (s.debt) {
      rows.push(`debt: ${s.debt.lines} code lines in ${s.debt.files} files, from ${s.debt.from}`, `review from: round.sh --new-review --base ${s.debt.base}`);
      if (s.debt.risky.length) rows.push(`tier-L paths: ${s.debt.risky.join(", ")}`);
    } else {
      rows.push(`debt: not measurable${s.why ? ` — ${s.why}` : ""}`);
    }
  }
  process.stdout.write(rows.join("\n") + "\n");
}
