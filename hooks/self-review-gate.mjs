#!/usr/bin/env node
/**
 * Self-review gate (Stop hook).
 *
 * A skill only runs when the model decides to invoke it, and "review your
 * own work before you stop" is exactly the instruction a model under momentum
 * skips. The harness does not skip: this hook runs at every Stop, and when the
 * turn changed files but the self-review loop never converged it refuses to
 * let the turn end — the block reason tells the model to run the `self-review`
 * skill and come back with the marker. Settings entry: hooks.Stop.
 *
 * WHAT COUNTS AS A CHANGE (all from the transcript, main chain only):
 *   - Write / Edit / MultiEdit / NotebookEdit tool calls, by file_path
 *   - Bash commands that write files: redirects (not /dev/null or fd dups),
 *     sed -i, tee, cp/mv/rm/ln/patch/rsync at command position, git rm/mv/
 *     apply, package-manager add/remove, and scripted writes (python open(w),
 *     fs.writeFile...). Heredoc bodies and quoted strings are masked first, so
 *     `grep ">"` and a Python body with `a > b` do not trigger. Heuristic by
 *     nature — the dedicated tools are the precise signal.
 *   - Synchronous Agent tool results whose toolStats show file edits. An
 *     async subagent's edits are invisible here (its launch result carries no
 *     stats, and its completion carries only its report) — the reviewer
 *     agents are read-only by instruction (their prompt forbids writes; they keep
 *     Bash to run tests), so this gap only matters for a
 *     background agent told to edit, whose author must scope its work itself.
 *   Paths under tmp, the session scratchpad, and Claude's own runtime state
 *   (~/.claude/projects, plans, todos, …) are ignored: scratch is not work.
 *   Prose, config and data files (.md, .json, .yaml, .txt, images, …) are
 *   ignored too: the gate arms for code only. Measured 2026-08-22 over 17
 *   reviews — the loop earned its cost on code with tests (real blockers)
 *   and produced churn on docs, settings and memory notes (7 "fixes" to
 *   memory notes in one round), with 40% of reviewer spend going to its own
 *   tooling. Docs still get a review on demand (`/self-review <path>`).
 *
 * WHAT CLEARS IT: a Bash command that INVOKES skills/self-review/scripts/
 * converged.sh — the script path at command position, not merely mentioned
 * in an echo or a grep — whose OUTPUT starts a line with the convergence
 * token, later in the turn than the last change. The output check is what
 * makes `cat converged.sh` or a failed run not count. An edit after the
 * marker re-arms the gate — that edit was never reviewed.
 *
 * IN-FLIGHT AGENTS: while an async Agent launched this turn has not finished
 * — no completion for it, no TaskStop — the stop is ALLOWED. Two completion
 * shapes exist: an unnamed agent's <task-notification> (a user message, or an
 * attachment when it lands mid-turn) citing its task-id or tool-use id; a
 * named agent's <teammate-message> idle notification naming it — and a
 * SendMessage to an idle named agent re-arms it, since a message resumes the
 * agent from its transcript. The harness wakes the model either way; ending the turn is the only wait that costs
 * nothing. Blocking here is what produced a session of ~85 ListAgents polls
 * at 430k context (2026-08-21): told "the turn cannot end", the model had no
 * other way to wait. The review is still enforced — the wake-up re-enters the
 * turn and the next Stop sees the same changes. An agent that dies without
 * any completion keeps the release open until it ages out (two human prompts
 * after its launch); each release says so in its notice.
 *
 * LOOP SAFETY: the turn boundary is the last real human prompt, so work from
 * earlier turns never re-triggers. Notifications, messages from other agents
 * and local slash commands are not boundaries — the work before them is still
 * this turn's, and treating one as a boundary is exactly what hid six pending
 * finders from this gate on 2026-08-22. Change detection uses that boundary;
 * pending-agent detection deliberately does not — a review launched before a
 * human interjection is still running, so it is scanned over the whole window
 * and aged out PENDING_INTERJECTION_LIMIT human prompts after each launch.
 * Reminders are counted per turn
 * (since the last marker): after MAX_REMINDERS unanswered blocks the gate
 * releases with a visible notice instead of fighting the model forever.
 * Claude Code itself force-ends a turn after 8 consecutive blocks; this stays
 * well under. Interrupted turns are never gated. SELF_REVIEW_GATE=off
 * disables it.
 *
 * A gate must never break the session: every failure path is a silent exit 0.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runHook } from "./lib/hook.mjs";
import { CONVERGED_SCRIPT, LOG_DIR, loadConfig, skillName } from "./lib/config.mjs";
import { NA_REASONS, formatSummary, validateMarker } from "./lib/marker.mjs";
import { deliveredText, hasToolResult, idleAgentNames, intEnv, isHumanPrompt, isInterrupt, isTaskNotification, readMainChain, textOf, toolUses } from "./lib/transcript.mjs";
import { SHELL_INTERPRETERS, afterBacktick, afterDoubleQuoted, afterPrefixes, afterSingleQuoted, afterSubstitution, commandOf, inlineShell, words } from "./lib/shell.mjs";

const GATE_TAG = "[self-review-gate]";
const CONFIG = loadConfig();
const SKILL_NAME = skillName();
// Two marker forms. The script — this plugin's own copy, matched by resolved
// path, so a same-named script anywhere else is not it — prints a token the
// gate matches in the command OUTPUT (so mentioning or printing the script
// never counts); the file form is a Write of <scratch>/self-review/
// CONVERGED.json holding the typed record ({"outcome": …, "rounds": …}) — a
// scratch write needs no permission rule, which is what makes the plugin
// portable. A write there that does not validate is refused, not ignored.
const MARKER_TOKEN_RE = /^SELF-REVIEW CONVERGED\b/m;
const MARKER_FILE_RE = /(^|\/)self-review\/CONVERGED\.json$/;
const MARKER_COMMAND = CONVERGED_SCRIPT;
// What to PRINT when telling the model to run it. The gate's message is copied
// into a Bash call verbatim, so an install path holding a space arrived as two
// words: the command failed, and the marker the gate was waiting for could not
// be produced at all — the turn could not end however correct the work was.
// Single quotes because that is the only shell quoting with no escapes inside,
// and the path is not the shell's to expand.
const MARKER_INVOCATION = /[^\w.\-/]/.test(MARKER_COMMAND)
  ? `'${MARKER_COMMAND.replace(/'/g, "'\\''")}'`
  : MARKER_COMMAND;
// Two launch phrasings exist, both opening the tool result: unnamed agents ("Async agent
// launched successfully … agentId: x") and named ones ("Spawned successfully … agent_id:
// name@session-x"). Anchored so a result that merely quotes the phrase is not a launch.
const LAUNCHED_RE = /^\s*(?:Async agent launched successfully|Spawned successfully)[\s\S]*?agent(?:Id|_id):\s*([^\s(]+)/;
const TASK_REF_RE = /<(?:task-id|tool-use-id)>([^<]+)<\//g;
// The two ways to write the record, spelled once. Both are copied verbatim out
// of a block reason into a tool call, so they carry no placeholders a model has
// to resolve except the numbers themselves.
const MARKER_BODY = `Write {"outcome":"converged","rounds":2,"fixed":3,"dismissed":1,"open":0} (your real counts) to <your scratchpad>/self-review/CONVERGED.json (a scratch write needs no permission rule), or run: ${MARKER_INVOCATION} --converged --rounds 2 --fixed 3 --dismissed 1 --open 0`;
const NA_BODY = `Write {"outcome":"not-applicable","reason":"user-declined"} to that same path, or run: ${MARKER_INVOCATION} --not-applicable user-declined`;
const MAX_REMINDERS = intEnv("SELF_REVIEW_GATE_MAX_REMINDERS", CONFIG.gate.maxReminders);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const HOME = homedir();
const SCRATCH_PREFIXES = [
  tmpdir(), "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/dev/null",
  ...["projects", "plans", "todos", "shell-snapshots", "paste-cache", "file-history", "session-env",
    "telemetry", "cache", "statsig", "sessions", "tasks", "teams", "jobs", "downloads", "ide", "daemon",
    "self-review", "backups", "history.jsonl"].map((d) => path.join(HOME, ".claude", d)),
].map((p) => (p.endsWith("/") || p.endsWith(".jsonl") || p === "/dev/null" ? p : p + "/"));
// Files that are never code: prose, structured config/data, assets — by extension,
// or by whole name for the extensionless conventions (LICENSE, .gitignore). Listed
// as exemptions so an unknown extension or name (Makefile, bin/deploy) still
// counts: failing toward a review costs a round, failing open costs a bug.
const EXEMPT_EXTENSIONS = new Set(CONFIG.exempt.extensions.map((e) => e.toLowerCase()));
const EXEMPT_NAMES = new Set(CONFIG.exempt.names.map((n) => n.toLowerCase()));

function toolResultText(entry) {
  const parts = [];
  for (const block of entry.message?.content ?? []) if (block?.type === "tool_result") parts.push(textOf(block.content));
  if (typeof entry.toolUseResult?.stdout === "string") parts.push(entry.toolUseResult.stdout);
  return parts.join("\n");
}

function toolResultsById(turn) {
  const byId = new Map();
  for (const entry of turn) {
    if (entry.type !== "user" || !hasToolResult(entry)) continue;
    const text = toolResultText(entry);
    for (const block of entry.message.content) if (block?.type === "tool_result") byId.set(block.tool_use_id, text);
  }
  return byId;
}

// ---------- what changed ----------

function isScratchPath(p) {
  if (typeof p !== "string" || !p) return false;
  const expanded = expandHome(p);
  if (!expanded.startsWith("/")) return false; // relative: cannot tell, so it counts
  const resolved = path.resolve(expanded);
  return SCRATCH_PREFIXES.some((prefix) => resolved === prefix.replace(/\/$/, "") || resolved.startsWith(prefix));
}

// A write the gate does not arm for: scratch, or a file that is not code. A
// dotfile has no extension to Node (`extname(".env") === ""`), so an
// extensionless file is keyed by its whole name; a directory operand (trailing
// slash kept by analyzeShell) is never exempt by name — `cp -r src site.json/`
// writes code under it.
function isExempt(p) {
  if (isScratchPath(p)) return true;
  if (p.endsWith("/")) return false;
  const ext = path.extname(p).toLowerCase();
  return ext ? EXEMPT_EXTENSIONS.has(ext) : EXEMPT_NAMES.has(path.basename(p).toLowerCase());
}

const REDIRECT_RE = /(^|[^<>&0-9])>{1,2}(?!&)\s*(?!\/dev\/null)\S/; // to a file, not /dev/null or an fd
const TEE_RE = /\btee\b/;
// Writers whose targets are their path arguments: at command position (behind
// `VAR=value`, wrappers and a subshell's `(`) …
// Every path operand counts, the read source of a cp/mv included: telling
// source from destination means modelling GNU's `-t`/`--target-directory` and
// its getopt_long prefixes, rsync's unrelated `-t`, BSD's lack of both — a
// deny-list that lost four rounds of review for the one case it bought
// (`cp a.mjs docs/a.md` gating). Over-inclusive fails toward a review.
const COMMAND_WRITERS = new Set(["cp", "mv", "rm", "rmdir", "ln", "install", "truncate", "dd", "rsync", "patch"]);
// … or anywhere in the segment.
const ARG_WRITE_PATTERNS = [
  /\bsed\b(?=[^|;&\n]*(?:\s-[A-Za-z]*i\b|--in-place))/, // sed in place
  /\bgit\s+(rm|mv|apply|am)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(?:(?:i|install|add)\b(?:\s+-\S+)*\s+[^-\s]|(?:remove|rm|uninstall|un|init|link|update|up)\b)/,
  /\bcargo\s+(add|remove|init|new)\b|\bgo\s+(get|mod\s+(tidy|edit|init))\b|\b(poetry|uv)\s+(add|remove|init)\b/,
];
// Matched with quotes intact: these live inside quoted -c/-e snippets and code
// heredocs, where the target is computed by the script and unknowable here.
const SCRIPT_WRITE_PATTERNS = [
  /\bopen\(\s*[^)]*,\s*(?:mode\s*=\s*)?(['"])[wax]\+?b?\1/, // python open() for writing
  /\.write_text\(|\.write_bytes\(|\bshutil\.(copy\w*|move|rmtree)\(|\bos\.(remove|unlink|rename|replace)\(/,
  /\b(?:fs\.|fsp\.|fs\.promises\.)?(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync)\(/,
  /\bSet-Content\b|\bOut-File\b/,
];

// Matched against the command word alone: `cat > scope.sh <<EOF` must not read as `sh`.
const INTERPRETER_RE = /^(python[\d.]*|node|deno|bun|ruby|perl|php|bash|sh|zsh|osascript)$/;
// Starts at the `<<` itself: a leading `[^\n]*` made every long line without a
// heredoc quadratic (14 s for a 100k-character command).
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;

// A heredoc body is data when it feeds cat/tee/a file and code when it feeds an
// interpreter (`python3 - <<EOF`). Data bodies are dropped — a README that
// mentions `sed -i` is not a write. Code bodies are lifted out and analysed as
// code, so a script that opens a file for writing is still seen.
function separateHeredocs(cmd) {
  const scripts = [];
  const text = cmd.replace(/\r\n?/g, "\n"); // a CRLF heredoc terminates all the same
  const shell = text.replace(HEREDOC_RE, (whole, _quote, _word, offset) => {
    const head = whole.slice(0, whole.indexOf("\n"));
    const line = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
    const lead = line.slice(line.lastIndexOf("(") + 1); // `X=$(python3 - <<EOF` feeds python3 too
    const interpreter = commandOf(words(lead)).match(INTERPRETER_RE)?.[1];
    if (interpreter) scripts.push({ interpreter, body: whole.slice(head.length + 1, whole.lastIndexOf("\n")) });
    return head;
  });
  return { shell, scripts };
}

// Replaces quoted strings — and bare `$( … )` or backtick bodies, which
// splitSegments judges on their own — with Q's of the same length, so operators inside them are not
// read as shell syntax and positions still line up with the raw text. A scanner
// rather than a regex because a double-quoted string may hold
// a $( … ) substitution that itself holds quotes — `echo "n: $(jq '…"…"…' f)"`
// is a common shape, and a regex loses phase at its inner quote, exposing a `>`
// inside <task-notification> as a redirect.
function maskQuotes(cmd) {
  let out = "";
  for (let i = 0; i < cmd.length;) {
    const ch = cmd[i];
    const end = ch === "'" ? afterSingleQuoted(cmd, i + 1) : ch === '"' ? afterDoubleQuoted(cmd, i + 1)
      : ch === "`" ? afterBacktick(cmd, i + 1) : ch === "$" && cmd[i + 1] === "(" ? afterSubstitution(cmd, i + 2) : 0;
    if (end) { out += "Q".repeat(end - i); i = end; }
    else { out += ch; i++; }
  }
  return out;
}

// `S=/tmp/x; … > "$S/out"` is the common shape of scratch writes (long paths
// get a variable). Substituting the command's own assignments lets the scratch
// check see the real target instead of an opaque `$S`. Each reference takes
// the assignment most recently made before it — a name reused later in the
// command must not rewrite an earlier target.
function expandLocalAssignments(cmd) {
  const assignments = [...cmd.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)]
    .map((m) => ({ at: m.index, name: m[1], value: m[2].replace(/^["']|["']$/g, "") }));
  return cmd.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name, at) => {
    const latest = assignments.findLast((a) => a.name === name && a.at < at);
    return latest ? latest.value : whole;
  });
}

// The bodies of `$( … )` and backtick substitutions, outside single quotes: the
// shell runs each as a command list of its own, so `RESULT=$(mv a b)` and
// `echo "$(cp a b)"` move and copy all the same. Inside "…" an apostrophe is
// text, so `echo "it's $(rm x)"` still yields `rm x`.
function substitutionBodies(cmd) {
  const bodies = [];
  let quoted = false; // inside "…"
  for (let i = 0; i < cmd.length;) {
    if (cmd[i] === "\\") i += 2; // an escaped character opens nothing
    else if (cmd[i] === '"') { quoted = !quoted; i++; }
    else if (cmd[i] === "'" && !quoted) i = afterSingleQuoted(cmd, i + 1);
    else if (cmd[i] === "`") {
      const end = afterBacktick(cmd, i + 1);
      bodies.push(cmd.slice(i + 1, cmd[end - 1] === "`" ? end - 1 : end));
      i = end;
    } else if (cmd[i] === "$" && cmd[i + 1] === "(") {
      const end = afterSubstitution(cmd, i + 2);
      bodies.push(cmd.slice(i + 2, cmd[end - 1] === ")" ? end - 1 : end));
      i = end;
    } else i++;
  }
  return bodies;
}

// Split a command into simple commands at newlines, `;`, `|`, `&` outside quotes,
// so that `grep "a|b" f && cat > g` is judged per segment: only the second writes.
// Substitution bodies become segments of their own, so a writer at the head of
// a `$( … )` is at command position somewhere.
function splitSegments(cmd) {
  const segments = [];
  let current = "", quote = null, escapes = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      if (ch === "\\" && escapes) current += cmd[++i] ?? ""; // keep the pair in source order
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch; escapes = ch === '"' || (ch === "'" && cmd[i - 1] === "$"); current += ch; // "…" and $'…' honour backslashes
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      segments.push(current); current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  for (const body of substitutionBodies(cmd)) segments.push(...splitSegments(body));
  return segments.map((seg) => seg.trim()).filter(Boolean);
}

const expandHome = (p) => (p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p.replace(/^\$HOME\//, HOME + "/").replace(/^\$\{?TMPDIR\}?/, tmpdir()));


// The word that starts at `at` in the raw segment — the target after a redirect
// or tee found in the masked text, whose positions line up.
const wordAt = (segment, at) => words(segment.slice(at))[0] ?? "";

// Path-like: not a flag, carrying a `/` or an extension so bare words (a mode,
// a package name) are skipped.
const pathLike = (t) => !t.startsWith("-") && /[\/.]/.test(t);

// sed's script is its first non-flag operand unless every script came through
// -e/--expression; the files follow. Skipped by position, not by shape: scripts
// take too many forms (s///, /re/d, 1,3p) to recognise by their text.
function sedFileOperands(ws) {
  const files = [];
  let scripts = 0;
  for (let i = ws.indexOf("sed") + 1; i < ws.length; i++) {
    const w = ws[i];
    if (w === "-e" || w === "--expression") { i++; scripts++; }
    else if (w.startsWith("--expression=")) scripts++;
    else if (w.startsWith("-")) continue;
    else if (scripts === 0) scripts++;
    else files.push(w);
  }
  return files;
}

// The path operands of a writer: after its command word (sed: after its script).
function pathOperands(ws) {
  return (ws.includes("sed") ? sedFileOperands(ws) : ws.slice(afterPrefixes(ws) + 1)).filter(pathLike);
}

// What one shell segment (and its words) writes: `null` when it does not write,
// otherwise the target paths — exact for redirects and tee, the path operands
// for cp/mv/sed/…, and empty when an inline script computes them (unknown is
// not scratch).
function segmentWriteTargets(segment, ws) {
  const masked = maskQuotes(segment);
  if (REDIRECT_RE.test(masked) || TEE_RE.test(masked)) {
    const after = (re) => [...masked.matchAll(re)].map((m) => wordAt(segment, m.index + m[0].length));
    return [...after(/(?:^|[^<>&0-9])>{1,2}(?!&)\s*/g), ...after(/\btee\b(?:\s+-\w+)*\s+/g)].filter((p) => p && p !== "/dev/null");
  }
  if (COMMAND_WRITERS.has(commandOf(ws)) || ARG_WRITE_PATTERNS.some((re) => re.test(masked))) return pathOperands(ws);
  if (INTERPRETER_RE.test(commandOf(ws)) && SCRIPT_WRITE_PATTERNS.some((re) => re.test(segment))) return [];
  return null;
}

// Walks shell text segment by segment, tracking `cd` so relative targets resolve
// against the directory the command was actually in.
function analyzeShell(text, dir, acc) {
  for (const segment of splitSegments(expandLocalAssignments(text))) {
    const ws = words(segment);
    const inline = inlineShell(ws);
    if (inline !== null) { analyzeShell(inline, dir, acc); continue; } // its own shell: a cd inside stays inside
    const at = afterPrefixes(ws);
    if (ws[at] === "cd" || ws[at] === "pushd") {
      const target = ws.slice(at + 1).find((w) => !w.startsWith("-")); // `cd -` is unknowable
      if (target) dir = path.resolve(dir, expandHome(target));
    }
    const found = segmentWriteTargets(segment, ws);
    if (found === null) continue;
    acc.writes = true;
    if (found.length === 0) acc.unknown = true;
    acc.targets.push(...found.map((t) => path.resolve(dir, expandHome(t)) + (t.endsWith("/") ? "/" : "")));
  }
  return dir;
}

// Returns the gated paths the command writes (empty when unknowable), or null
// when the command does not write or writes only exempt files.
function bashWriteTargets(command, cwd) {
  if (typeof command !== "string") return null;
  const acc = { writes: false, unknown: false, targets: [] };
  const { shell, scripts } = separateHeredocs(command);
  const dir = analyzeShell(shell, cwd, acc);
  for (const { interpreter, body } of scripts) {
    if (SHELL_INTERPRETERS.has(interpreter)) analyzeShell(body, dir, acc);
    else if (SCRIPT_WRITE_PATTERNS.some((re) => re.test(body))) { acc.writes = true; acc.unknown = true; }
  }
  if (!acc.writes) return null;
  if (acc.unknown) return [...new Set(acc.targets.filter((p) => !isScratchPath(p)))]; // an unknowable write gates; name what is known
  if (acc.targets.length > 0 && acc.targets.every(isExempt)) return null;
  return [...new Set(acc.targets.filter((p) => !isExempt(p)))];
}

/**
 * The paths in `git status --porcelain=v1 -z` output.
 *
 * `-z` is why this is a parser and not a one-liner, and it is deliberate: in
 * the line-based format git C-quotes any path that is not plain ASCII
 * (`?? "caf\303\251.txt"`), and JSON.parse — which this used to borrow to
 * unquote — throws on an octal escape. The path then stayed quoted, statSync
 * missed it, and a write to a non-ASCII filename left no evidence at all. With
 * `-z` there is no quoting to undo: one NUL-terminated record per entry,
 * `XY path`, and a rename adds a second record holding the old path with no
 * status prefix. The new path is the one that exists to be reviewed.
 */
function statusPaths(stdout) {
  const records = stdout.split("\0");
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    if (/^[RC]/.test(record.slice(0, 2))) i += 1; // skip the old path that follows
    files.push(record.slice(3));
  }
  return files;
}

/**
 * The turn's writes by EVIDENCE rather than by command shape: the files git
 * reports as changed whose mtime is at or after the turn's first message.
 *
 * Returns a file list, or the REASON there is nothing to ask — which is a
 * different answer from "nothing was written", and the reason is which of the
 * three it was. It used to return a bare null and the caller named the third
 * cause for all of them, so a transcript whose turn has no parseable timestamp
 * reported "no git repository" from inside a checkout.
 *
 * This is the fallback for a write whose target the command parser cannot
 * resolve: a heredoc into an interpreter, a project script at command position.
 * Extending the parser to "know" more tools is the wrong layer — the script
 * that motivated this was one the gate could never have heard of — and every
 * extension is another heuristic to keep.
 */
function writesSince(cwd, since) {
  if (!cwd) return "no working directory to ask git about";
  if (!Number.isFinite(since)) return "no timestamp for the start of this turn";
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { encoding: "utf8" });
  if (status.status !== 0 || typeof status.stdout !== "string") return "no git repository";
  const files = [];
  for (const rel of statusPaths(status.stdout)) {
    const file = path.resolve(cwd, rel);
    // A deleted file has no mtime and nothing to review. It is also not what
    // this fallback is for: the question is what the turn WROTE.
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (stat.mtimeMs >= since) files.push(file);
  }
  return files;
}

function agentEdited(entry) {
  const stats = entry.toolUseResult?.toolStats;
  return !!stats && ((stats.editFileCount ?? 0) > 0 || (stats.linesAdded ?? 0) > 0 || (stats.linesRemoved ?? 0) > 0);
}

function collectChanges(turn, cwd, since) {
  const changes = [];
  // One git call per Stop at most, and only when a command shape needs it.
  let evidence;
  const witnessed = () => (evidence === undefined ? (evidence = writesSince(cwd, since)) : evidence);
  turn.forEach((entry, index) => {
    for (const use of toolUses(entry)) {
      if (EDIT_TOOLS.has(use.name)) {
        const file = use.input?.file_path ?? use.input?.notebook_path;
        if (file && !isExempt(file)) changes.push({ index, kind: "file", file });
      } else if (use.name === "Bash") {
        const targets = bashWriteTargets(use.input?.command, cwd);
        if (!targets) continue;
        // A resolvable target decides on its own: it may be outside the repo,
        // where git has nothing to say about it.
        if (targets.length) { changes.push({ index, kind: "bash", files: targets }); continue; }
        const written = witnessed();
        if (!Array.isArray(written)) { changes.push({ index, kind: "bash", files: [], unresolved: written }); continue; }
        const gated = written.filter((file) => !isExempt(file));
        if (gated.length) { changes.push({ index, kind: "bash", files: gated }); continue; }
        // Every file the turn touched is exempt: prose, config, scratch. That
        // is a real answer — the artifact was looked at — so no change is
        // recorded. An empty list is not: the command wrote something the
        // evidence cannot account for, and the gate falls back to blocking.
        if (!written.length) changes.push({ index, kind: "bash", files: [], unresolved: "nothing in the working tree changed since this turn began" });
      }
    }
    if (entry.type === "user" && agentEdited(entry)) {
      changes.push({ index, kind: "agent", agentType: entry.toolUseResult.agentType ?? "subagent" });
    }
  });
  return changes;
}

// The marker script at command position — `cd x && /abs/converged.sh "…"` is an
// invocation; `echo '…converged.sh…'` and `grep converged.sh …` only mention it.
function commandWord(segment) {
  const ws = words(segment), inline = inlineShell(ws);
  if (inline !== null) return commandWord(inline);
  const i = afterPrefixes(ws);
  return (SHELL_INTERPRETERS.has(ws[i]) ? ws[i + 1] : ws[i]) ?? "";
}
// Data heredocs are dropped first: prose in a ledger appended beside the marker
// can hold an apostrophe, which would otherwise read as an unclosed quote.
function invokesMarkerScript(command, cwd) {
  const { shell, scripts } = separateHeredocs(command);
  const texts = [shell, ...scripts.filter((s) => SHELL_INTERPRETERS.has(s.interpreter)).map((s) => s.body)];
  return texts.some((text) => splitSegments(text).some((segment) => isMarkerScript(commandWord(segment), cwd)));
}

// The command word names the plugin's converged.sh: absolute, `~`-prefixed, or
// relative to the turn's cwd (a `cd` earlier in the same command is not
// followed — the gate's own message gives the absolute path). Symlinked
// install paths are compared by real path when both sides resolve.
function isMarkerScript(word, cwd) {
  if (!word || !word.endsWith("converged.sh")) return false;
  const candidate = path.resolve(cwd ?? "", expandHome(word));
  if (candidate === MARKER_COMMAND) return true;
  try { return realpathSync(candidate) === realpathSync(MARKER_COMMAND); } catch { return false; }
}

// The file marker counts only under a scratch prefix (a CONVERGED.json inside
// the project is a file the model could be asked to write, and it is exempt
// as .json — so it would clear the gate while leaving no trace), only when the
// Write succeeded, and only with the documented JSON body.
//
// The body is the typed record (lib/marker.mjs), not `{"summary": "…"}`: a
// string inside JSON is the double encoding that let 14 prose markers and nine
// unparseable counts into the log. A write at this path that does not validate
// is not "no marker" — it is a REJECTED one, and it returns its problems so the
// block can say which, rather than repeating the generic reminder.
//
// Returns null (not a marker attempt), {record, summary}, or {problems}.
function fileMarkerSummary(use, results) {
  const file = use.input?.file_path ?? "";
  if (use.name !== "Write" || !MARKER_FILE_RE.test(file) || !isScratchPath(file)) return null;
  if (!/successfully/i.test(results.get(use.id) ?? "")) return null;
  let body;
  try {
    body = JSON.parse(use.input?.content ?? "");
  } catch {
    return { problems: ["the file is not valid JSON."] };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { problems: ["the file must contain a JSON object."] };
  }
  if (typeof body.summary === "string") {
    return { problems: ['`summary` is no longer a string: name the fields instead, so the record cannot be mistyped.'] };
  }
  const { record, problems } = validateMarker(body);
  return record ? { record, summary: formatSummary(record) } : { problems };
}

// Index of the last marker of either form, the last REJECTED file marker, and
// — for the accepted file form — what to log. A rejection only speaks when it
// is the later of the two: a bad write followed by a good one is a corrected
// mistake, not an open problem.
function lastMarker(turn, results, cwd) {
  let at = -1, fileMarker = null, rejectedAt = -1, rejected = null;
  turn.forEach((entry, index) => {
    for (const use of toolUses(entry)) {
      if (use.name === "Bash" && invokesMarkerScript(use.input?.command ?? "", cwd) && MARKER_TOKEN_RE.test(results.get(use.id) ?? "")) {
        at = index; fileMarker = null;
        continue;
      }
      const outcome = fileMarkerSummary(use, results);
      if (outcome === null) continue;
      if (outcome.problems) { rejectedAt = index; rejected = outcome.problems; continue; }
      at = index; fileMarker = { id: use.id, summary: outcome.summary };
    }
  });
  return { at, fileMarker, rejected: rejectedAt > at ? rejected : null };
}

// converged.sh logs its own run; the file form is logged here, once per marker:
// the gate runs at every Stop of a turn, and the log is shared by every session,
// so the guard is the marker id anywhere in the file, not just its last line.
// Best effort: a logging failure must never hold the turn hostage.
function logFileMarker({ id, summary }, cwd) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, "log.jsonl");
    let logged = "";
    try { logged = readFileSync(file, "utf8"); } catch { /* no log yet */ }
    if (logged.includes(`"marker":"${id}"`)) return;
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), cwd, summary, marker: id }) + "\n");
  } catch (err) {
    process.stderr.write(`self-review-gate: could not log convergence: ${err.message}\n`);
  }
}

const countReminders = (turn, since) =>
  turn.filter((e, i) => i > since && e.type === "user" && e.isMeta && textOf(e.message?.content).includes(GATE_TAG)).length;

// ---------- in-flight agents ----------

// Async Agent launches this turn that have not finished: no task notification
// citing their task-id or tool-use id (read from the notification's header,
// not from the <result> the agent authored), no idle message naming them, no
// TaskStop. Any agent type counts: a model waiting on any subagent has the
// same single cheap option, and the gate re-applies when the wake-up lands.
// How many human prompts may land after a launch before a still-silent agent is
// presumed dead rather than slow. A review waits by ending turns, so normally no
// human prompt lands while it runs; one is an interjection (the user typing mid-
// review) and the agent is still going; by the second the user has moved on and a
// crashed reviewer must stop holding the gate open. Scoping pending to the current
// turn hid a review launched before an interjection — a live false block
// (2026-08-22); scoping to the whole window with no age-out would let a crashed
// agent hold the gate open forever. Two is the seam between those two failures.
const PENDING_INTERJECTION_LIMIT = 2;

function pendingAgents(entries, results) {
  const launchedAt = new Map(); // agentId -> entry index of its latest launch
  const useIdOf = new Map();    // agentId -> its launch tool_use id
  const events = [];            // {index, key, resume} — a completion, or a SendMessage that resumes one
  const humanAt = [];
  entries.forEach((entry, index) => {
    if (isHumanPrompt(entry)) humanAt.push(index);
    for (const use of toolUses(entry)) {
      if (use.name === "Agent") {
        const match = LAUNCHED_RE.exec(results.get(use.id) ?? "");
        if (match) { launchedAt.set(match[1], index); useIdOf.set(match[1], use.id); }
      } else if (use.name === "TaskStop" && typeof use.input?.task_id === "string") {
        events.push({ index, key: use.input.task_id, resume: false });
      } else if (use.name === "SendMessage" && typeof use.input?.to === "string") {
        events.push({ index, key: use.input.to.replace(/\s*\[.*$/, ""), resume: true });
      }
    }
    if (isTaskNotification(entry)) {
      const header = deliveredText(entry).split("<result>")[0];
      for (const match of header.matchAll(TASK_REF_RE)) events.push({ index, key: match[1].trim(), resume: false });
    }
    for (const name of idleAgentNames(entry)) events.push({ index, key: name, resume: false });
  });
  let pending = 0;
  for (const [agentId, at] of launchedAt) {
    // A named agent's id is name@session-…; its idle message carries the bare name.
    const keys = new Set([agentId, useIdOf.get(agentId), agentId.split("@")[0]]);
    // Only events AFTER this launch speak for it, so a stale completion for a
    // reused agent name from an earlier round cannot mark a live relaunch done;
    // the last such event wins (an idle then a SendMessage means working again).
    const own = events.filter((e) => e.index > at && keys.has(e.key));
    const done = own.length > 0 && !own[own.length - 1].resume;
    const interjections = humanAt.filter((i) => i > at).length;
    if (!done && interjections < PENDING_INTERJECTION_LIMIT) pending++;
  }
  return pending;
}

// ---------- decision ----------

function evaluate(entries, cwd) {
  const lastMessage = [...entries].reverse().find((e) => e.type === "user" || e.type === "assistant");
  if (!lastMessage || isInterrupt(lastMessage)) return null;

  const boundary = entries.map(isHumanPrompt).lastIndexOf(true);
  const turn = entries.slice(boundary + 1);
  // When the turn began, by the transcript's own clock: the cutoff for
  // "this turn wrote it" in writesSince().
  const since = Date.parse(entries[boundary]?.timestamp ?? turn[0]?.timestamp ?? "");
  const changes = collectChanges(turn, cwd, since);
  if (changes.length === 0) return null;

  // Keyed by tool_use id, so a window-wide map serves both the turn-scoped
  // marker lookup and the window-wide pending scan below.
  const results = toolResultsById(entries);
  const { at: markerAt, fileMarker, rejected } = lastMarker(turn, results, cwd);
  const lastChangeAt = Math.max(...changes.map((c) => c.index));
  if (markerAt > lastChangeAt) {
    if (fileMarker) logFileMarker(fileMarker, cwd);
    return null;
  }

  // Pending is scanned over the whole window, not just this turn: a reviewer
  // launched before a human interjection is still running, and turn-scoping made
  // exactly those finders invisible (a live false block). Age-out inside
  // pendingAgents keeps a crashed agent from holding the gate open forever.
  const pending = pendingAgents(entries, results);
  if (pending > 0) {
    return {
      systemMessage: `self-review gate: ${pending} subagent(s) still running — turn released so their results can arrive; the gate re-checks at the next stop`,
    };
  }

  const reminders = countReminders(turn, markerAt);
  if (reminders >= MAX_REMINDERS) {
    return {
      systemMessage: `self-review gate: released without a convergence marker after ${reminders} reminders — the review may be incomplete. (SELF_REVIEW_GATE=off disables the gate.)`,
    };
  }
  const beside = markerAt !== -1 && markerAt === lastChangeAt
    ? "\nThe marker did run, but in the same message as a change — the gate orders by transcript entry, so give it a message of its own and run it again."
    : "";
  // A rejected marker gets its own reason. Repeating the generic reminder for a
  // model that DID mark, and was refused on the record's shape, is how three
  // sequential single-defect rejections cost ~600k tokens once already: say
  // every defect and the exact body to write, in one message.
  if (rejected) {
    return {
      decision: "block",
      reason: rejectionReason(rejected),
      systemMessage: `self-review gate: the convergence marker was refused — ${rejected.length} problem(s) with the record`,
    };
  }
  return {
    decision: "block",
    reason: blockReason(changes, reminders, cwd) + beside,
    systemMessage: `self-review gate: ${describeChanges(changes, cwd)} — running the review loop before the turn ends`,
  };
}

function shortPath(file, cwd) {
  if (cwd && file.startsWith(cwd + "/")) return file.slice(cwd.length + 1);
  return file.startsWith(HOME + "/") ? "~" + file.slice(HOME.length) : file;
}

function describeChanges(changes, cwd) {
  const files = [...new Set(changes.flatMap((c) => c.kind === "file" ? [c.file] : c.kind === "bash" ? c.files : []).map((f) => shortPath(f, cwd)))];
  const bash = changes.filter((c) => c.kind === "bash");
  const agents = changes.filter((c) => c.kind === "agent").length;
  const parts = [];
  if (files.length) parts.push(`${files.slice(0, 6).join(", ")}${files.length > 6 ? ` (+${files.length - 6} more)` : ""}`);
  // Named when the artifact could be resolved; when it could not, the reason
  // says so rather than implying a count of files nobody identified — and it
  // counts the blind commands, not all of them, so a mixed turn (one target
  // named, one not) does not read as though nothing was identified.
  const blind = bash.filter((c) => c.unresolved);
  if (bash.length) {
    const caveat = blind.length === bash.length ? `could not determine which files — ${blind[0].unresolved}`
      : blind.length ? `${blind.length} of them could not be resolved — ${blind[0].unresolved}` : "";
    parts.push(`${bash.length} shell command(s) that write files${caveat ? ` (${caveat})` : ""}`);
  }
  if (agents) parts.push(`${agents} subagent(s) that edited files`);
  return parts.join(" · ");
}

function blockReason(changes, reminders, cwd) {
  const lead = reminders > 0
    ? `Second reminder: no converged marker has appeared since your last edit. `
    : "";
  return [
    `${GATE_TAG} Files changed this turn but the self-review loop has not converged, so the turn cannot end yet.`,
    `Changed: ${describeChanges(changes, cwd)}`,
    `${lead}Now: invoke the Skill tool with skill "${SKILL_NAME}" and follow it to convergence — fresh reviewer subagents, verify each candidate, fix what survives, re-review until a round is clean. Finish by marking convergence in a message of its own, AFTER your last edit: ${MARKER_BODY} — the marker is what clears this gate — and only then write your final summary.`,
    `After spawning reviewers, END YOUR TURN with a one-line status: while subagents are running this gate lets the turn end, and their completion (a task notification, or an idle notification for a named agent — read its report with the skill's salvage.mjs) wakes you. Never poll with ListAgents or TaskOutput — each check is a full-context turn that tells you nothing new.`,
    `If the review genuinely does not apply, mark that outcome rather than skipping the marker — but name it, because it is a different claim: ${NA_BODY}. Reasons: ${NA_REASONS.join(", ")} (note required for "other").`,
  ].join("\n");
}

// A refused marker. Every defect at once, and the exact body to write — the
// model is one message away from ending the turn, and a partial correction
// costs another full-context Stop cycle to reject again.
function rejectionReason(problems) {
  return [
    `${GATE_TAG} A convergence marker was written, but the record does not validate, so it does not clear the gate.`,
    ...problems.map((problem) => `  - ${problem}`),
    `Write it again, in a message of its own, with every field: ${MARKER_BODY}`,
    `If the review does not apply: ${NA_BODY}. Reasons: ${NA_REASONS.join(", ")} (note required for "other").`,
  ].join("\n");
}

runHook("SELF_REVIEW_GATE", "self-review-gate", (payload) => {
  if (typeof payload.transcript_path !== "string") return null;
  return evaluate(readMainChain(payload.transcript_path), payload.cwd ?? process.cwd());
});
