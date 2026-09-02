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

/** The repo root, or the working directory when there is no checkout. */
export function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}
