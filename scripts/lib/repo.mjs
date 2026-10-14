/**
 * Which repository a script is running in.
 *
 * Two scripts asked this question and each answered it with its own copy of the
 * same seven lines. They are two ends of one pipeline — `findings.mjs prior
 * --out` writes the file `brief.mjs --prior` reads — so a drifted answer would
 * mean one script's config layer and the other's memory key disagreed about
 * which repository this is, which is the class of bug `lib/diff.mjs` and
 * `lib/paths.mjs` were split out to prevent.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { realpathOr } from "../../hooks/lib/config.mjs";
import { parseScope } from "../impact.mjs";

/** The repo root, or the working directory when there is no checkout. */
export function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * The repository a review dir belongs to: the first git repo of its round-1
 * scope, which round.sh wrote. Round 1, not round N, so a review keys one
 * memory file across its rounds, as `reviewFromWork` gives it one id. The cwd
 * is never consulted — a cwd fallback is how `record` once wrote one repo's
 * findings into another's memory. A scope in no repository keys on the work
 * dir itself: it has no project memory to share.
 */
export function workRepo(work) {
  const scope = path.join(path.resolve(work), "round-1", "scope.diff");
  let text;
  try {
    text = readFileSync(scope, "utf8");
  } catch {
    throw Object.assign(new Error(`no scope at ${scope} — round.sh writes it; the repo comes from there`), { exitCode: 2 });
  }
  const repo = parseScope(text).repos.find((entry) => !entry.plain && entry.root);
  return repo ? repo.root : realpathOr(path.resolve(work));
}
