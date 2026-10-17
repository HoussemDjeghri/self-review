/**
 * Which repository this is, as one stable key: the findings memory files its
 * records under it, and the Stop gate looks a user's per-repo settings up by it
 * (`repos.<id>` in the user config). One function for both, so the id a user
 * copies from `branch-debt.mjs --id` is the id their findings live under.
 *
 * Under `hooks/lib` because the gate imports it, and a hook must not import
 * across into `scripts/` (see `marker.mjs`'s header).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

const realpathOr = (dir) => { try { return realpathSync(dir); } catch { return dir; } };

/**
 * `git@github.com:Owner/Repo.git`, `https://github.com/Owner/Repo` and
 * `ssh://git@github.com/Owner/Repo/` are one project, so they hash to one file:
 * scheme, credentials, the scp colon, `.git` and trailing slashes are noise,
 * and the host is case-insensitive. The path is not — plenty of forges are
 * case-sensitive, and two paths differing only in case are two repositories
 * until one of them proves otherwise.
 */
export function normaliseRemote(url) {
  const raw = String(url).trim();
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutUser = withoutScheme.replace(/^[^/@]*@/, "");
  // `git@host:path` is scp syntax, which git only accepts without a scheme —
  // so after a scheme a colon is a port, and folding it into the path gave
  // `ssh://git@host:2222/o/r` a different id from `https://host/o/r`.
  const scp = withoutScheme === raw ? withoutUser.match(/^([^/:]+):(?!\/)(.*)$/) : null;
  const rest = scp ? `${scp[1]}/${scp[2]}` : withoutUser.replace(/^([^/]+):\d+(?=\/|$)/, "$1");
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash);
  return `${host.toLowerCase()}${tail}`.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

// One answer per root per process: the gate asks up to three times a Stop,
// and each ask is a git spawn the Stop hook's timeout has to cover.
const ORIGINS = new Map();
const originUrl = (repoRoot) => {
  if (!ORIGINS.has(repoRoot)) ORIGINS.set(repoRoot, readOrigin(repoRoot));
  return ORIGINS.get(repoRoot);
};
const readOrigin = (repoRoot) => {
  try {
    // GIT_* removed: a repository's settings `env` (GIT_DIR, GIT_CONFIG_*) could
    // otherwise name another repository's origin and take its per-repo settings.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    return execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 3_000 }).trim() || null;
  } catch {
    return null;
  }
};

/**
 * The memory key: the hashed origin, so clones and worktrees of one project
 * remember together instead of each starting cold; the hashed realpath when
 * there is no remote, which keeps a scratch repo's findings out of everyone
 * else's file. Hashed either way because it is a stable, filesystem-safe key
 * for a string full of `/` and `:` — not because it hides anything: the records
 * beside it quote the repository's own paths and code.
 */
export function repoId(repoRoot) {
  const remote = originUrl(repoRoot);
  return createHash("sha256").update(remote ? normaliseRemote(remote) : realpathOr(repoRoot)).digest("hex");
}

