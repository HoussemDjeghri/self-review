/**
 * The one walk the graders share, in place of the directory lists they kept.
 *
 * Four lists said which directories this repository checks — `test.sh`'s
 * globs, no-network's `RUNTIME_DIRS`, docs-claims' `TEST_DIRS` and `DOC_DIRS`
 * — and every one of them was a single level deep, so a file in a new
 * subdirectory was not checked, and not checking it was silent. Two had
 * already gone stale on `scripts/lib`: five shipped files that no network scan
 * had ever read. Both were repaired by adding one literal, which repairs the
 * instance; DESIGN §0.1 says the second arrival of a class makes the mechanism
 * the fix. Walking is that mechanism — a directory added tomorrow is covered
 * because nobody has to remember it.
 *
 * The prune list stays a literal, deliberately: its failure direction is the
 * loud one. Forget an entry here and fixture tests run in the gate and the
 * counted total moves, which is a red suite. The lists it replaced failed the
 * other way round, which is why they lasted.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

// Dependencies, tooling state (every dot-directory: `.git`, `.github`, and a
// session's own `.claude`), and the eval corpora — fixture repositories whose
// files are review bait for this plugin, not material this repository checks.
const PRUNE_NAMES = new Set(["node_modules"]);
const PRUNE_PATHS = new Set(["evals/corpora"]);

const isPruned = (name, rel) => name.startsWith(".") || PRUNE_NAMES.has(name) || PRUNE_PATHS.has(rel);

/**
 * Every file under `root`, recursively, as `/`-separated paths relative to it,
 * sorted. Symlinks are neither followed nor returned: a walk that follows them
 * can leave the tree it was asked about, and can loop. Callers filter by
 * extension — the walk's job is to know the tree, not what anyone wants of it.
 */
export function walkFiles(root) {
  const found = [];
  const visit = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (isPruned(entry.name, child)) continue;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  visit("");
  return found.sort();
}
