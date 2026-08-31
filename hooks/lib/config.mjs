/**
 * Plugin-relative paths and the merged configuration: config/defaults.json
 * under the plugin root, overridden by the user's ~/.claude/self-review/config.json
 * (or $SELF_REVIEW_CONFIG). Objects deep-merge; arrays replace, so a user can
 * shorten an exemption list, not only extend it. The hooks read CONFIG at module
 * scope, before their fail-open wrapper runs, so nothing here may throw: a user
 * file that cannot be read or parsed is ignored whole, an override whose type
 * does not match the default is ignored per key, and a missing or corrupt
 * defaults.json falls back to FALLBACK — which gates every file, so a broken
 * install costs a review rather than silently skipping one. Each case is
 * reported on stderr, which Claude Code shows under --debug.
 *
 * A third layer applies only when a caller passes a repo root: `.self-review.json`
 * at that root, default closed — see REPO_ADDITIVE. A repository is untrusted
 * input and is reviewed by whoever clones it, so it may only *add* marker words
 * (`addPatterns`), never substitute a list or reach any other setting, and what
 * it adds is escaped to a literal unconditionally: a checked-in `(a+)+$` would
 * otherwise hang every review of that repo.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONVERGED_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "converged.sh");
export const LOG_DIR = process.env.SELF_REVIEW_LOG_DIR || path.join(homedir(), ".claude", "self-review");

const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");
// Also the key schema: merge() refuses any key not present here, so a new
// config key ships in this object and in config/defaults.json together.
// Exported so a script can ask what a setting is *supposed* to be when a
// config layer hands it something unusable.
export const FALLBACK = {
  exempt: { extensions: [], names: [] },
  gate: { maxReminders: 2 },
  pollGuard: { maxChecks: 2 },
  brief: { maxTokens: 2800, impactMaxLines: 80, priorMaxLines: 10 },
  preflight: { skip: [] },
  // Angle X refuses to execute anything on a host that cannot reach FULL
  // containment — seatbelt or bubblewrap. Denying only the network is not
  // enough. This key turns that refusal off, buying best-available execution
  // rather than none. It is deliberately reachable only from the USER's config:
  // it is not in REPO_ADDITIVE, so a checked-in `.self-review.json` cannot set
  // it, and no reviewing agent writes that file — the point of the whole
  // containment design is that the decision to run unknown code with real
  // credentials belongs to a person, held by a mechanism rather than by a
  // sentence in a prompt.
  coldRun: { uncontained: false },
  impact: {
    adapter: "auto", timeoutSec: 20, maxSymbols: 30, maxRefsPerSymbol: 200, maxLines: 80,
    minSymbolLength: 3, stopWords: [], exclude: [], fullFor: [], docsFor: [],
    wire: { minSegments: 2, minLiteralChars: 3 },
  },
  tier: {
    s: { maxLines: 15, docsMaxLines: 40 },
    l: { minLines: 300, minFiles: 8, minCallerFiles: 20, graphRisk: 0.7 },
    riskPaths: { auth: [], payments: [], migration: [], infra: [] },
    riskContent: { destructive: [], security: [], concurrency: [] },
    instructional: [],
    executable: [],
    executableExclude: [],
    ignore: [],
    finders: { maxPerRound: 6, callsCode: 40, callsDocs: 25, callsConfig: 25, callsCold: 20, roundsCap: { S: 2, M: 2, L: 6 } },
  },
};

// What a checked-in `.self-review.json` may set — **default closed**, and
// additive only.
//
// This was four whole keys (`tier`, `impact`, `preflight`, `brief`), on the
// reasoning that a repository should be able to tune its own review. Seven
// review rounds took that apart. Locking the one key they kept attacking
// (`tier.markerDeclaring`, since deleted) left every neighbour reaching the
// same outcome more directly: `{"tier":{"ignore":
// ["**"]}}` reviewed zero files, `riskContent` lists set to `[]` silenced every
// marker, and thresholds calling any diff small dropped tier L to one
// author-verified finder. The attacker in this threat model *is* the
// repository, so no setting that can make the review weaker is its to make.
//
// What remains is the one thing that is safe from an untrusted source because
// it can only ever add work: extra *words* for the risk markers. They are
// appended to the shipped and user lists, never substituted — an override that
// can shorten a list is an override that can switch a marker off. They are also
// escaped into literals: a repo says which words mark risk ("billing" instead
// of "payments"), it does not get to ship a regex, because a checked-in
// `(a+)+$` is a denial-of-service primitive against everyone who reviews a diff
// in that repo (measured: 0.045s -> still running after 4s). The user's own
// config keeps regex power.
export const REPO_ADDITIVE = new Set(["tier.riskPaths", "tier.riskContent"]);

// One repo cannot hand every reviewer an unbounded alternation to compile.
const REPO_MAX_PATTERNS = 200;
export const REPO_CONFIG_FILE = ".self-review.json";

const warn = (message) => process.stderr.write(`self-review: ${message}\n`);
const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// Override a default with the user's value when the types agree; objects
// recurse. A default that is itself an object never accepts a scalar or null
// in its place, and every list in the config is a list of strings, so an array
// with anything else in it is refused whole — which is what keeps
// `CONFIG.gate.maxReminders` and `CONFIG.exempt.extensions.map(...)` safe.
function merge(base, over, trail = "") {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key.startsWith("$")) continue; // $comment, $schema: annotations, not settings
    const name = trail + key;
    // `hasOwn`, not `in`: `in` walks the prototype chain, so a config holding
    // `{"tier": {"__proto__": …}}` would pass the guard and then assign through
    // `out[key]`, which for that name is a setter that replaces the object's
    // prototype. The question this guard asks is whether the shipped schema
    // declares the key as its own, and that is the one `in` cannot answer.
    if (!Object.hasOwn(base, key)) { warn(`config: ignoring unknown key ${name}`); continue; }
    const expected = kind(base[key]);
    if (kind(value) !== expected) { warn(`config: ignoring ${name} — expected ${expected}, got ${kind(value)}`); continue; }
    if (expected === "array" && !value.every((item) => typeof item === "string")) { warn(`config: ignoring ${name} — expected an array of strings`); continue; }
    out[key] = expected === "object" ? merge(base[key], value, name + ".") : value;
  }
  return out;
}

function readJson(file) {
  // A byte-order mark is how the file was encoded, not something it says, and
  // JSON.parse refuses one. Stripping it is what makes a config saved by an
  // editor that writes BOMs mean what it looks like it means — it widens what
  // parses, never what a layer may set, and the repo layer stays additive-only.
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const MAX_REPO_CONFIG_BYTES = 1024 * 1024;

// `.self-review.json` is the one file in this boundary whose path a reviewed
// repository controls, so it is contained before it is opened rather than
// after. A committed symlink `.self-review.json -> /dev/zero` is nine bytes of
// ordinary git and made every entry point read an endless stream: 7.3 GB
// resident in four seconds, no output, no error — the review never reached the
// risk markers at all, which is worse than reaching them with a wrong tier. A
// symlink out of the repo is the other half: a JSON parse error quotes the text
// it choked on, so `-> /etc/passwd` prints that file's first line as a warning.
// Both sides are realpath'd because a macOS temp dir resolves through /private.
// The checks themselves are the deleted `declaringFiles()`'s — it applied them
// to the files this file *names*, never to this file.
function repoConfigPath(repoRoot) {
  const file = path.join(repoRoot, REPO_CONFIG_FILE);
  let target;
  try {
    target = realpathSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") warn(`ignoring ${file} (${err.message}); using user config`);
    return null;
  }
  const base = realpathOr(repoRoot);
  if (target !== base && !target.startsWith(base + path.sep)) {
    warn(`ignoring ${file} — it resolves to ${target}, outside the repository`);
    return null;
  }
  const stats = statSync(target);
  if (!stats.isFile()) { warn(`ignoring ${file} — not a regular file`); return null; }
  if (stats.size > MAX_REPO_CONFIG_BYTES) { warn(`ignoring ${file} — larger than ${MAX_REPO_CONFIG_BYTES} bytes`); return null; }
  return target;
}

export const realpathOr = (dir) => { try { return realpathSync(dir); } catch { return dir; } };

// One file URL, symlinks resolved and characters encoded, so two spellings of
// the same file compare equal.
const canonical = (file) => pathToFileURL(realpathOr(file)).href;

/**
 * Whether the module at `metaUrl` is the process's entry point.
 *
 * Every helper here used to write this as ``import.meta.url === `file://${process.argv[1]}` ``,
 * which is wrong twice over. Node resolves the ESM main entry to its
 * **realpath**, so a plugin reached through a symlink — macOS's `/var/folders`,
 * a `~/.claude` kept in a dotfiles repo — hands `import.meta.url` the resolved
 * path and `process.argv[1]` the typed one, the strings differ, and the CLI
 * block below the guard silently does not run. That is not theoretical: inside
 * the eval sandbox all four helpers exited 0 producing no output and no files,
 * and the review that called them carried on computing its tier by hand.
 * Interpolation is also not URL encoding, so a path holding a space or a
 * non-ASCII character never matched either. Canonicalising both sides fixes
 * both, and keeps working under `--preserve-symlinks-main`, where the main
 * entry is *not* pre-resolved.
 */
export const isMain = (metaUrl) =>
  Boolean(process.argv[1]) && canonical(fileURLToPath(metaUrl)) === canonical(process.argv[1]);

// The repo layer (DESIGN §3), applied last and default-closed: see
// REPO_ADDITIVE. Missing file: the common case, silent.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One group of marker lists, with the repo's words appended to what the trusted
// layers already carry. A name the group does not already have is unknown, not
// new: the marker names are the tool's, not the repo's.
function addPatterns(base, group, trail) {
  const out = { ...base };
  for (const [name, list] of Object.entries(group)) {
    if (name.startsWith("$")) continue;
    const where = `${trail}.${name}`;
    if (!Object.hasOwn(base, name)) { warn(`${REPO_CONFIG_FILE}: ignoring unknown key ${where}`); continue; }
    if (kind(list) !== "array" || !list.every((item) => typeof item === "string")) {
      warn(`${REPO_CONFIG_FILE}: ignoring ${where} — expected an array of strings`);
      continue;
    }
    const added = [...new Set(list.map(escapeRegExp))].filter((pattern) => !out[name].includes(pattern));
    if (out[name].length + added.length > REPO_MAX_PATTERNS) {
      warn(`${REPO_CONFIG_FILE}: ignoring ${where} — more than ${REPO_MAX_PATTERNS} patterns`);
      continue;
    }
    out[name] = [...out[name], ...added];
  }
  return out;
}

function mergeRepo(config, repoRoot) {
  const file = repoConfigPath(repoRoot);
  if (!file) return config;
  let repo;
  try {
    repo = readJson(file);
  } catch (err) {
    warn(`ignoring ${file} (${err.message}); using user config`);
    return config;
  }
  if (kind(repo) !== "object") { warn(`ignoring ${file} (expected an object, got ${kind(repo)})`); return config; }
  const out = { ...config };
  for (const [key, value] of Object.entries(repo)) {
    if (key.startsWith("$")) continue;
    if (kind(value) !== "object") { warn(`${REPO_CONFIG_FILE}: ignoring ${key} — expected an object, got ${kind(value)}`); continue; }
    for (const [name, group] of Object.entries(value)) {
      if (name.startsWith("$")) continue;
      const leaf = `${key}.${name}`;
      if (!REPO_ADDITIVE.has(leaf)) { warn(`${REPO_CONFIG_FILE}: ignoring ${leaf} — a repository may only add to ${[...REPO_ADDITIVE].join(" and ")}`); continue; }
      if (kind(group) !== "object") { warn(`${REPO_CONFIG_FILE}: ignoring ${leaf} — expected an object, got ${kind(group)}`); continue; }
      out[key] = { ...out[key], [name]: addPatterns(out[key][name], group, leaf) };
    }
  }
  return out;
}


/**
 * The merged configuration. Pass the repo root to add the `.self-review.json`
 * layer (scripts do; the hooks do not, so hook behaviour never depends on the
 * repository being reviewed).
 */
export function loadConfig(repoRoot) {
  let defaults;
  try {
    defaults = merge(FALLBACK, readJson(DEFAULTS_PATH), "defaults.json: ");
  } catch (err) {
    warn(`cannot read ${DEFAULTS_PATH} (${err.message}); gating every file`);
    return FALLBACK;
  }
  const userPath = process.env.SELF_REVIEW_CONFIG || path.join(homedir(), ".claude", "self-review", "config.json");
  let user;
  try {
    user = readJson(userPath);
  } catch (err) {
    if (err.code !== "ENOENT") warn(`ignoring ${userPath} (${err.message}); using defaults`);
    return repoRoot ? mergeRepo(defaults, repoRoot) : defaults;
  }
  if (kind(user) !== "object") { warn(`ignoring ${userPath} (expected an object, got ${kind(user)}); using defaults`); user = {}; }
  const config = merge(defaults, user);
  return repoRoot ? mergeRepo(config, repoRoot) : config;
}

// "self-review" when the files run from a plain skill directory, "<plugin>:self-review"
// when they run from an installed plugin — the name the Skill tool expects.
export function skillName() {
  try {
    const { name } = readJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
    return name ? `${name}:self-review` : "self-review";
  } catch {
    return "self-review";
  }
}
