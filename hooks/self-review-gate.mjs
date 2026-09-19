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
 *     Bash to run tests), so the gap would matter for any background agent
 *     told to edit.
 *   - The LAUNCH of a self-review-applier or a self-review-orchestrator — the
 *     agent types whose dispatch implies they were told to edit. The launch
 *     stands in for the edit evidence an async result does not carry; the
 *     applier section further down says why arming on the launch alone is the
 *     point rather than a compromise. The orchestrator is additionally review
 *     evidence, under a clause of its own — see `reviewerState`.
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
 * AND `converged` MUST HAVE A READER BEHIND IT. A marker whose outcome is
 * `converged` claims an independent reader looked at the final state, so it is
 * refused unless a plugin reviewer — `self-review-finder`,
 * `self-review-cold-grader` or `self-review-orchestrator`, never a verifier,
 * which presupposes findings the author generated — COMPLETED after the last
 * change and before the marker. An orchestrator satisfies this alone, under a
 * clause of its own, because it ran the loop: see `reviewerState`.
 * 29 of the first 112 real markers claimed a converged review with no rounds
 * at all, and one review spawned zero finders while billing 24.3M tokens: the
 * main session read the whole scope and reviewed itself, which is the one
 * thing this loop exists to prevent. Three transcript indices decide it and
 * the report is never opened — grading the review from the main chain is the
 * pattern this plugin rejects. Only an affirmative `converged` is gated:
 * `not-converged` and `not-applicable` are honest claims that need no reader,
 * and an outcome that cannot be read passes, because a block bought with a
 * guess is worse than the hole. There is no matching exception for a launch
 * whose text did not parse: one stood there and took a finding from each
 * direction in a single round — a failed Agent call is indistinguishable from a
 * reworded one, so it let `converged` through with zero reviewers, and it was
 * defeated by any other agent that did parse, falsely blocking a real review.
 * Harness drift is handled by the bound instead: two refusals and the gate
 * releases with a notice. A bound is cheaper than a hole. Known limits, in this
 * header's style: a
 * reviewer whose SCOPE predates the edits it completed after is admitted —
 * this holds "a reader of the final state existed by the transcript's clock",
 * and scope is the review's property, not the transcript's; and the gate fires
 * at Stop, so a model that reads 200k into its own context and never tries to
 * stop is refused after the spend, not interrupted. This refusal carries its
 * OWN reminder count, because a model refused here has marked, and a
 * since-the-marker count would reset on every re-mark and never release.
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
 * agent detection deliberately does not — a review launched before a human
 * interjection is still running, so agents are scanned over the whole window.
 * The PENDING_INTERJECTION_LIMIT age-out applies to PENDING only: it exists to
 * release a crashed agent, and a reviewer that satisfies `converged` has by
 * definition completed, so ageing that one out would refuse a slow but real
 * finder that ground through a big scope across two interjections.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runHook } from "./lib/hook.mjs";
import { CONVERGED_SCRIPT, LOG_DIR, loadConfig, skillName } from "./lib/config.mjs";
import { NA_REASONS, formatSummary, validateMarker } from "./lib/marker.mjs";
import { deliveredText, hasToolResult, idleAgentNames, intEnv, isHumanPrompt, isInterrupt, isTaskNotification, readMainChain, textOf, toolUses } from "./lib/transcript.mjs";
import { findAgentFiles, isOwnTranscript, readAgent, resolveSubagentsDir } from "./lib/agents.mjs";
import { INTERPRETER_RE, SHELL_INTERPRETERS, afterPrefixes, commandOf, inlineShell, maskQuotes, separateHeredocs, splitSegments, words } from "./lib/shell.mjs";

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
// One optional `review-<k>/` segment: a lead running several reviews in one
// session keeps each in its own work dir (review-identity ruling D1). Only that
// shape — any other directory between would let an arbitrary file count.
const MARKER_FILE_RE = /(^|\/)self-review\/(?:review-\d+\/)?CONVERGED\.json$/;
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
// The reviewer types that satisfy `converged` (F10a′ ruling 2). A plugin
// agent's type carries a `plugin:` prefix, hence the optional leading segment —
// the same shape tree-guard.mjs matches. The VERIFIER is deliberately absent: a
// verifier presupposes findings, so if the main session generated them it
// reviewed itself. One finder is the floor on purpose, because tier S *is* one
// finder with an all-angles brief.
const REVIEWER_TYPES = /(?:^|:)self-review-(?:finder|cold-grader)$/;
// The verifier, matched on EITHER half of what SKILL.md §2d names it by. It is
// absent from REVIEWER_TYPES above and must stay absent: verifying findings the
// session generated itself is not an independent read. This is the opposite
// question — not "did anyone read the code" but "did anyone but the author rule
// on the verdicts" — and the two conditions sit on the same marker without
// touching. See `verifierState`.
//
// The trailing `(?:-|$)` is `tree-guard.mjs`'s REVIEWER boundary, and it has to
// be: a name this gate reads as a verifier but that guard does not read as a
// reviewer is an UNGUARDED shell in the author's tree that also clears the
// marker. Verified live on 2026-09-07 — `self-review-verifier2` and
// `self-review-verifiers-r2` were accepted here and matched by nothing there,
// and the refusal text below authorises exactly that spelling. The suffix a
// real verifier carries is the round and batch (`self-review-verifier-r2-b1`),
// which the `-` admits. `general-purpose` — the §2b substitute — is admitted
// through the name alone, which is the only evidence that agent carries.
const VERIFIER_TYPE = /(?:^|:)self-review-verifier(?:-|$)/;
const VERIFIER_NAME = /^self-review-verifier(?:-|$)/;
const isVerifier = (agent) => VERIFIER_TYPE.test(agent.type) || VERIFIER_NAME.test(agent.name);
// The one agent type whose LAUNCH implies it was told to edit. That implication
// is what the arm substitutes for the edit evidence async agent results do not
// carry, so it holds by construction for exactly this type and no other: the
// plugin authors the applier's definition (write tools, no Bash) and the skill
// authors its launch. It is hardcoded rather than configured on purpose —
// arrays replace on config merge, so a user overriding a neighbouring list
// could silently empty this one and disarm the gate; and a name convention
// (`*-applier`) would arm on another plugin's agent this one knows nothing
// about, which is a block bought with a guess.
const APPLIER_TYPE = /(?:^|:)self-review-applier$/;
// The orchestrator runs the whole post-setup protocol in a fresh context and
// spawns the finders, the verifier and the applier ITSELF, so the lead pays one
// spawn and one wake instead of a dozen turns against a 200k context. That makes
// it both sides of this gate's comparison at once: it causes writes, through an
// applier the main chain cannot see, AND its completion is the evidence that a
// review ran. The two are kept apart by which FIELDS each side reads — see
// `reviewerState` and `externalChangeAt`. Hardcoded for the same reasons as the
// applier above.
const ORCHESTRATOR_TYPE = /(?:^|:)self-review-orchestrator$/;
// The ticket validator: the one reader of the intent that ran BEFORE the code
// existed. It is the only evidence the marker's `intent=validated` can have,
// and the gate checks its ORDERING, never its verdict — a `revise` the session
// acted on is as valid as a `sound`, and grading the ticket here would make
// this the stamp the whole feature exists not to be. Hardcoded for the same
// reasons as the two above.
const TICKET_VALIDATOR_TYPE = /(?:^|:)self-review-ticket-validator$/;
// "An agent told to edit is a change source, anchored at its last dispatch or
// completion" is ONE rule over two types, not two rules. Keeping it one is what
// makes the mixed session — a failed orchestrator and a main-chain applier in
// the same window — compose instead of needing a third case.
//
// Composed from the two constants rather than a third regex re-spelling their
// union: a name spelled in two places is a name that can drift in one of them,
// and this file has already taken two rounds of findings for exactly that, on
// its prose lists. `isEditor` is where a third editing type would be added.
const isEditor = (type) => APPLIER_TYPE.test(type) || ORCHESTRATOR_TYPE.test(type);
// The outcome token inside a script-form marker's output line. The record is
// `outcome=… rounds=…`, so the first whitespace-delimited word after the `=` is
// the whole value.
//
// It is read out of the LAST marker line, not out of the whole result. One Bash
// call can print two of them — `converged.sh --not-applicable …; converged.sh
// --converged …` is a single tool result holding both — and a search over the
// combined text returns the FIRST `outcome=`, which is the superseded one. That
// scored the effective `converged` as `not-applicable` and released the turn
// with no reviewer behind it: the exact hole this rule exists to close, entered
// through the parser.
const MARKER_LINE_RE = /^SELF-REVIEW CONVERGED\b.*$/gm;
// Any one field of that last line. `outcome` was the only reader until `intent`
// arrived; a second hand-written regex over the same string is the drift this
// file has already paid for twice, so both go through here.
function scriptField(text, field) {
  const lines = text.match(MARKER_LINE_RE);
  if (!lines) return null;
  return new RegExp(`\\b${field}=(\\S+)`).exec(lines[lines.length - 1])?.[1] ?? null;
}
// The two ways to write the record, spelled once. Both are copied verbatim out
// of a block reason into a tool call, so they carry no placeholders a model has
// to resolve except the numbers themselves.
//
// `intent` is spelled `author` rather than left as a placeholder for the same
// reason, and the direction of the error is deliberate: a session that copies
// this without thinking under-claims, which is honest, while `validated` is the
// one value the gate checks and would be refused anyway. A body the gate hands
// out must validate — this text and `validateMarker` are one contract, and the
// version that omitted `intent` told the session to write a record the very
// next call refused.
const MARKER_BODY = `Write {"outcome":"converged","rounds":2,"fixed":3,"dismissed":1,"open":0,"intent":"author"} (your real counts; intent is validated, author or skipped) to <your scratchpad>/self-review/CONVERGED.json (a scratch write needs no permission rule), or run: ${MARKER_INVOCATION} --converged --rounds 2 --fixed 3 --dismissed 1 --open 0 --intent author`;
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
  const file = stripAtomicSuffix(p);
  const ext = path.extname(file).toLowerCase();
  return ext ? EXEMPT_EXTENSIONS.has(ext) : EXEMPT_NAMES.has(path.basename(file).toLowerCase());
}

// `notes.md.new` is written and then renamed over `notes.md`: the file is what
// sits under the suffix, so it is judged as that file — `README.new` as
// `README`, and a bare `build.new` as `build`, which nothing exempts.
const ATOMIC_SUFFIX_RE = /\.(?:new|tmp)$/i;
const stripAtomicSuffix = (p) => p.replace(ATOMIC_SUFFIX_RE, "");

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

// `S=/tmp/x; … > "$S/out"` is the common shape of scratch writes (long paths
// get a variable). Substituting the command's own assignments lets the scratch
// check see the real target instead of an opaque `$S`. Each reference takes
// the assignment most recently made before it — a name reused later in the
// command must not rewrite an earlier target.
// A value this pattern cannot capture WHOLE must not be substituted in part.
// `[^\s;&|]+` stops at the space inside `$(ls x)`, so `f=$(ls x)` was recorded
// as `$(ls` and every later `$f` became that fragment — unbalanced syntax
// injected into the command. `maskQuotes` then lost phase on the unclosed
// `$(`, and a `>` inside a later quoted string read as a redirect: a read-only
// pipeline was reported as writing to whatever word followed it. So a value
// holding a substitution is OPAQUE — the reference is left as written, which
// is what an unknown value has always meant here.
const OPAQUE_VALUE = /\$\(|`/;

function expandLocalAssignments(cmd) {
  const assignments = [...cmd.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)]
    .map((m) => ({ at: m.index, name: m[1], raw: m[2], value: m[2].replace(/^["']|["']$/g, "") }));
  return cmd.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name, at) => {
    const latest = assignments.findLast((a) => a.name === name && a.at < at);
    if (!latest || OPAQUE_VALUE.test(latest.raw)) return whole;
    return latest.value;
  });
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

// What a command writes: null when it writes nothing, otherwise `named` — every
// target it resolved, exempt ones included — and `gated`, the non-exempt subset.
// `unknown` says some write's target could not be named at all.
//
// An unknowable write gates, and the known targets are only the NAMES it is
// reported under — so they are filtered the same way every other path in this
// file is. Filtering them by scratch alone was the narrower rule, and it let a
// prose-only turn block: one command that both wrote a doc through a heredoc
// and ran an interpreter whose target could not be resolved named the .md as
// the change. When nothing non-exempt is left to name, an empty list is the
// honest answer and collectChanges falls through to the git evidence, which
// decides on what the turn actually wrote rather than on what was parseable.
function bashWrites(command, cwd) {
  if (typeof command !== "string") return null;
  const acc = { writes: false, unknown: false, targets: [] };
  const { shell, scripts } = separateHeredocs(command);
  const dir = analyzeShell(shell, cwd, acc);
  for (const { interpreter, body } of scripts) {
    if (SHELL_INTERPRETERS.has(interpreter)) analyzeShell(body, dir, acc);
    else if (SCRIPT_WRITE_PATTERNS.some((re) => re.test(body))) { acc.writes = true; acc.unknown = true; }
  }
  if (!acc.writes) return null;
  const named = [...new Set(acc.targets)];
  return { named, gated: named.filter((p) => !isExempt(p)), unknown: acc.unknown };
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
  // Porcelain paths are relative to the repository's top, never to the cwd, so
  // from a subdirectory they used to resolve to files that do not exist: the
  // stat below missed every one and the evidence came back silently empty.
  // `--show-cdup` is the way up in the cwd's own spelling, which is the one
  // every parsed target is resolved in — `--show-toplevel` returns a realpath,
  // and on macOS `/private/var/…` never matches a target written as `/var/…`.
  const cdup = spawnSync("git", ["-C", cwd, "rev-parse", "--show-cdup"], { encoding: "utf8" });
  if (cdup.status !== 0 || typeof cdup.stdout !== "string") return "no git repository";
  const top = path.resolve(cwd, cdup.stdout.trim());
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { encoding: "utf8" });
  if (status.status !== 0 || typeof status.stdout !== "string") return "no git repository";
  const files = [];
  for (const rel of statusPaths(status.stdout)) {
    const file = path.resolve(top, rel);
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

/**
 * Every write the transcript itself reports in `(from, to)`, in order, as
 * `{ index, kind, ... }`. One enumerator, two callers: the generic block asks
 * WHETHER this turn changed code, the intent check asks WHEN this task first
 * did, and they must not disagree about what a write is.
 *
 * They did. The intent check was directed to share this branch and was written
 * as a second loop instead, and the copy dropped one of `bashWriteTargets`'
 * three answers — it collapsed "a write I cannot name" into "no write". A code
 * write through an interpreter then armed the gate and skipped the ordering
 * check, accepting `intent=validated` with provably zero validators. That is
 * what a duplicated enumerator costs, and it is why there is now one.
 *
 * `unresolved` is not a guess and not a git fallback: it is the parser's own
 * report that a write happened at this index whose non-exempt targets it could
 * not name. Only `collectChanges` asks git, and only to learn WHICH files.
 *
 * A write that touched only exempt paths is yielded too, as kind `exempt`: it is
 * never a change, but the paths it names (`explains`, with the tool_use `id` so
 * a caller can ask whether the call succeeded) are what the git evidence must
 * not credit to an unresolved write. The explained paths come from here rather
 * than from a second walk for the reason the paragraph above gives.
 */
function* writeEvents(entries, from, to, cwd) {
  for (let index = from + 1; index < to; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    for (const use of toolUses(entry)) {
      if (EDIT_TOOLS.has(use.name)) {
        const file = use.input?.file_path ?? use.input?.notebook_path;
        if (!file) continue;
        yield isExempt(file)
          ? { index, kind: "exempt", id: use.id, explains: [file] }
          : { index, kind: "file", id: use.id, file, explains: [file] };
      } else if (use.name === "Bash") {
        const writes = bashWrites(use.input?.command, cwd);
        if (!writes) continue;
        // Three answers, kept as three: an exempt-only write is no change, an
        // empty `targets` is a write whose targets did not resolve, a list names
        // them. A writer with no path operand at all resolved nothing either.
        const blind = writes.unknown || writes.named.length === 0;
        yield blind || writes.gated.length
          ? { index, kind: "bash", id: use.id, targets: writes.gated, unresolved: writes.gated.length === 0, explains: writes.named }
          : { index, kind: "exempt", id: use.id, explains: writes.named, shell: true };
      }
    }
    if (entry.type === "user" && agentEdited(entry)) {
      yield { index, kind: "agent", agentType: entry.toolUseResult.agentType ?? "subagent" };
    }
  }
}

// The first write of `(from, to)`, as the event rather than its index: the
// refusal text needs to say whether the gate could name what was written.
function firstWriteEvent(entries, from, to, cwd) {
  for (const event of writeEvents(entries, from, to, cwd)) if (event.kind !== "exempt") return event;
  return null;
}

// The tool calls whose result came back without an error. A failed or denied
// call wrote nothing, so it explains nothing — and a denied Edit is the likeliest
// reason a session falls back to a heredoc in the first place.
function succeededToolUses(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry.type !== "user" || !hasToolResult(entry)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "tool_result" && block.is_error !== true) ids.add(block.tool_use_id);
    }
  }
  return ids;
}

function collectChanges(turn, cwd, since) {
  const changes = [];
  const events = [...writeEvents(turn, -1, turn.length, cwd)];
  // One git call per Stop at most, and only when a command shape needs it.
  let evidence;
  const witnessed = () => (evidence === undefined ? (evidence = writesSince(cwd, since)) : evidence);
  // The git evidence covers the whole turn but the verdict is per event, so a
  // file some other successful call already accounts for — exempt ones included,
  // wherever in the turn it landed — cannot clear an unresolved write. Crediting
  // it did exactly that: a heredoc rewrote a hook outside the repo, git saw only
  // the two `.md` files a Write and a redirect had made, and the all-exempt rule
  // below read that as "the artifact was prose" (unresolved-write ruling §1).
  const succeeded = succeededToolUses(turn);
  const explained = new Set(events.filter((e) => e.explains && succeeded.has(e.id))
    .flatMap((e) => e.explains.map((p) => path.resolve(p))));
  const unexplainedCode = (written) => written.filter((file) => !explained.has(file) && !isExempt(file));
  // The working tree's veto over a Bash write the parser read as prose-only.
  // Five fixes in a row were the same defect — the parser said scratch or prose
  // and the file was code (TMPDIR, mktemp, an atomic `.tmp` suffix, a quoted
  // mktemp, a truncation) — and each passed silently, because an exempt verdict
  // never asked git. So the tree gets one job: it can overrule "nothing gated".
  // The parser keeps deciding alone wherever it named a gated target.
  //
  // Narrowed to evidence BESIDE what the command named — the same directory, or
  // the same stem (`gen.mjs.tmp` → `gen.mjs`). Replayed over 352 turns the gate
  // passes today that hold such a write: no true hit is observable, while 8
  // could arm falsely — another session's edit in the same window, or a `git
  // reset --hard` / `stash pop` rewriting tracked code. The ruling
  // (resolved-write-shape-answer.md) makes that the case for narrowing before
  // shipping. What stays invisible: a mis-parse whose real target is outside
  // the repo, ignored, or unrelated to anything it named.
  const vetoExempt = (event) => {
    const written = witnessed();
    if (!Array.isArray(written)) return;
    const named = event.explains.map((p) => path.resolve(p));
    const beside = unexplainedCode(written).filter((file) =>
      named.some((n) => path.dirname(n) === path.dirname(file) || (stem(n) !== "" && stem(n) === stem(file))));
    if (beside.length) changes.push({ index: event.index, kind: "bash", files: beside, vetoed: true });
  };
  for (const event of events) {
    if (event.kind === "exempt") { if (event.shell) vetoExempt(event); continue; }
    if (event.kind === "file") { changes.push({ index: event.index, kind: "file", file: event.file }); continue; }
    if (event.kind === "agent") { changes.push({ index: event.index, kind: "agent", agentType: event.agentType }); continue; }
    // A resolvable target decides on its own: it may be outside the repo,
    // where git has nothing to say about it.
    if (!event.unresolved) { changes.push({ index: event.index, kind: "bash", files: event.targets }); continue; }
    const written = witnessed();
    if (!Array.isArray(written)) { changes.push({ index: event.index, kind: "bash", files: [], unresolved: written }); continue; }
    const unexplained = written.filter((file) => !explained.has(file));
    const gated = unexplainedCode(written);
    if (gated.length) { changes.push({ index: event.index, kind: "bash", files: gated }); continue; }
    // Every unexplained file is exempt: prose, config, scratch. That is a real
    // answer — the artifact was looked at — so no change is recorded. An empty
    // remainder is not: the command wrote something the evidence cannot account
    // for, and the gate falls back to blocking. The two empty cases get two
    // texts, because "nothing changed" is the one leads have learned to answer
    // with `not-applicable`, and here something did change — just not visibly.
    if (!written.length) changes.push({ index: event.index, kind: "bash", files: [], unresolved: "nothing in the working tree changed since this turn began" });
    else if (!unexplained.length) changes.push({ index: event.index, kind: "bash", files: [], unresolved: "every file changed in the working tree is accounted for by another tool call, so this one wrote somewhere git cannot see from here — outside this repository, or into a file another call also wrote" });
  }
  return changes;
}

// `gen.mjs.tmp`, `gen.mjs` and `gen.test.mjs` share one: everything before the first dot.
const stem = (file) => path.basename(file).split(".")[0];

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

// The three verdict counts off a marker of either form, or `null` when any one
// of them cannot be read as a non-negative integer. `validateMarker` requires
// all three for `converged`, so a null here is a marker that did not go through
// it — a script form whose line was reworded, say — and the verifier check
// below treats that as no evidence rather than as zero. Zero would be a claim.
//
// One reader for both forms, deliberately: the file form hands over numbers and
// the script form hands over the strings it printed, and two hand-written
// parsers over the same four fields is the drift `scriptField` was written to
// stop.
function countsFrom(read) {
  const counts = {};
  for (const key of ["fixed", "dismissed", "open"]) {
    const value = read(key);
    const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isInteger(n) || n < 0) return null;
    counts[key] = n;
  }
  return counts;
}

// Index of the last marker of either form, the last REJECTED file marker, the
// accepted marker's `outcome`, and — for the accepted file form — what to log.
// A rejection only speaks when it is the later of the two: a bad write followed
// by a good one is a corrected mistake, not an open problem.
//
// `outcome` is what the reviewer-ran check keys on, so it is read from the
// record in the file form and parsed out of the printed token line in the
// script form. It is null when it cannot be read — a marker whose outcome is
// unknown is never gated, because refusing on a value we failed to parse is a
// block bought with a guess.
function lastMarker(turn, results, cwd) {
  let at = -1, fileMarker = null, rejectedAt = -1, rejected = null, outcome = null, intent = null, counts = null;
  turn.forEach((entry, index) => {
    for (const use of toolUses(entry)) {
      const text = results.get(use.id) ?? "";
      if (use.name === "Bash" && invokesMarkerScript(use.input?.command ?? "", cwd) && MARKER_TOKEN_RE.test(text)) {
        at = index; fileMarker = null;
        outcome = scriptField(text, "outcome");
        intent = scriptField(text, "intent");
        counts = countsFrom((key) => scriptField(text, key));
        continue;
      }
      const written = fileMarkerSummary(use, results);
      if (written === null) continue;
      if (written.problems) { rejectedAt = index; rejected = written.problems; continue; }
      at = index; fileMarker = { id: use.id, summary: written.summary };
      outcome = written.record.outcome;
      intent = written.record.intent ?? null;
      counts = countsFrom((key) => written.record[key]);
    }
  });
  return { at, fileMarker, outcome, intent, counts, rejected: rejectedAt > at ? rejected : null };
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

// One predicate, four users. A gate reminder is a meta user entry this hook
// wrote, identified by the sentence it carries — and "identified by its
// sentence" is the property that must not drift between the four counters,
// because each obligation's refusal embeds only its own tag and cross-counting
// would release a gate that was never satisfied.
const isReminderFor = (e, tag) =>
  e.type === "user" && e.isMeta && textOf(e.message?.content).includes(tag);

// The three obligation counters below are built from this; `countReminders`
// cannot be, because its bound is a CALL-time value (`markerAt`) rather than a
// construction-time one — which is exactly the difference the comment above
// UNREVIEWED_TAG exists to explain, so it stays visible in the signature.
const reminderCounter = (tag) => (turn) => turn.filter((e) => isReminderFor(e, tag)).length;

// The two refusals this counter bounds, named by the sentence each already
// prints. `GATE_TAG` is on all five refusal messages by construction, so
// counting it here pooled five obligations into one budget of two: a stale
// `intent=validated` refusal plus a single no-marker block released the turn
// with neither obligation at its own cap (reproduced live 2026-09-07). That is
// the same class the `describeChanges` guard already refuses — a message
// carrying a counter's sentence driving that counter's release — reached
// without any forgery.
//
// BOTH, not just the no-marker one: a rejected marker does not move `at` in
// `lastMarker`, so `markerAt` stays behind it and `countReminders` is the only
// bound the malformed-record refusal has. Narrowing to the no-marker sentence
// alone would leave a model writing bad markers blocked forever, which is the
// deadlock MAX_REMINDERS exists to prevent.
const UNMARKED_TAG = "the self-review loop has not converged";
const REJECTED_TAG = "does not validate, so it does not clear the gate";
// Pooled with the two above rather than counted apart: it is the same
// obligation — a marker that postdates the last change — asked in the words
// that fit an honest marker overtaken by an editor's completion.
const REMARK_TAG = "your marker was written before an editing subagent finished";
const countReminders = (turn, since) =>
  turn.filter((e, i) => i > since
    && [UNMARKED_TAG, REJECTED_TAG, REMARK_TAG].some((tag) => isReminderFor(e, tag))).length;

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

// One scan, two questions. `pending` answers "is something still running", and
// `doneAt` + `type` answer "did an independent reader of this state exist"
// (F10a′ ruling 2) — two filters over one array rather than two scans, so the
// interjection seam below is documented in one place and cannot drift.
//
function scanAgents(entries, results) {
  const launchedAt = new Map(); // agentId -> entry index of its latest launch
  const useIdOf = new Map();    // agentId -> its launch tool_use id
  const typeOf = new Map();     // agentId -> its subagent_type, as launched
  // agentId -> the `name` it was launched under. SKILL.md §2d makes the NAME
  // load-bearing for the verifier ("must start with self-review-verifier"),
  // because the substitute a missing reviewer type sends the lead to is a
  // `general-purpose` agent whose registered type says nothing. So a check that
  // reads only `subagent_type` misses exactly the verifier that was hardest to
  // spawn — see `isVerifier`.
  const nameOf = new Map();
  const events = [];            // {index, key, resume} — a completion, or a SendMessage that resumes one
  const humanAt = [];
  entries.forEach((entry, index) => {
    if (isHumanPrompt(entry)) humanAt.push(index);
    for (const use of toolUses(entry)) {
      if (use.name === "Agent") {
        const match = LAUNCHED_RE.exec(results.get(use.id) ?? "");
        if (match) {
          launchedAt.set(match[1], index);
          useIdOf.set(match[1], use.id);
          typeOf.set(match[1], String(use.input?.subagent_type ?? ""));
          nameOf.set(match[1], String(use.input?.name ?? ""));
        }
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
  const agents = [];
  for (const [agentId, at] of launchedAt) {
    // A named agent's id is name@session-…; its idle message carries the bare name.
    const keys = new Set([agentId, useIdOf.get(agentId), agentId.split("@")[0]]);
    // Only events AFTER this launch speak for it, so a stale completion for a
    // reused agent name from an earlier round cannot mark a live relaunch done;
    // the last such event wins (an idle then a SendMessage means working again).
    const own = events.filter((e) => e.index > at && keys.has(e.key));
    const last = own[own.length - 1];
    const done = own.length > 0 && !last.resume;
    // A resume is a fresh dispatch of work, so the record has to move FORWARD
    // on one. Without this, `doneAt` reverting to -1 walks an applier's anchor
    // backward, behind a marker already written — see editorAnchor.
    const resumes = own.filter((e) => e.resume);
    const interjections = humanAt.filter((i) => i > at).length;
    agents.push({
      id: agentId,
      type: typeOf.get(agentId) ?? "",
      name: nameOf.get(agentId) ?? "",
      launchedAt: at,
      doneAt: done ? last.index : -1,
      resumedAt: resumes.length ? resumes[resumes.length - 1].index : -1,
      // The age-out belongs to PENDING only. A qualifying reviewer has by
      // definition completed, so it cannot be the crashed agent the limit
      // exists to release — ageing one out would refuse a slow but real
      // reviewer that ground through a big scope across two interjections.
      pending: !done && interjections < PENDING_INTERJECTION_LIMIT,
      // Kept, not just consumed by `pending`: "how many human prompts landed
      // since this launch" is what separates a slow agent in THIS task (zero)
      // from a crashed one left over from an earlier task (one — the prompt
      // that started the new task). `pending` alone cannot tell them apart.
      interjections,
    });
  }
  return agents;
}

// ---------- a notice that lands after the marker ----------
//
// `doneAt` is where the harness DELIVERED an agent's completion notice, and the
// skill tells the lead not to wait on those: wait.mjs reads the reviewer's own
// transcript, and on 2026-09-03 notices trailed finished transcripts by 2h49m.
// So a lead that followed the skill exactly could read a report, write the
// marker, and be refused — "late" for a finder, "none" for a verifier — because
// the notice came afterwards, with an identical re-mark as the only way out.
//
// Consulted only when the notice-based answer would not pass, so every verdict
// that passes today is untouched. For each reviewer or verifier with no
// completion before the marker, its own transcript — harness-written, like the
// notice — is read; if it ends in a report timestamped before the marker, the
// completion moves to the first lead entry at or after that time, and the
// ordering rules (fresh, vouches, the verifier window) judge it exactly as they
// judge a notice. Ruled C by a Fable subagent on 2026-09-19, after the draft
// existed (ask.sh was refused): docs/design-notes/questions/late-notice-answer.md.
//
// KNOWN LIMIT: the transcript proves the report existed before the marker, not
// that the lead read it — which is also all a delivered notice ever proved.
function settleFromTranscripts(agents, entries, markerAt, transcriptPath) {
  const msOf = (entry) => Date.parse(entry?.timestamp ?? "");
  const markerMs = msOf(entries[markerAt]);
  const dir = resolveSubagentsDir(transcriptPath);
  return agents.map((a) => {
    const unsettled = a.doneAt === -1 || a.doneAt > markerAt;
    if (!unsettled || !(REVIEWER_TYPES.test(a.type) || isVerifier(a))) return a;
    const finishedMs = reportFinishedMs(a, dir, msOf(entries[a.launchedAt]));
    if (!(finishedMs < markerMs)) return a;
    const doneAt = entries.findIndex((e, i) => i > a.launchedAt && msOf(e) >= finishedMs);
    return doneAt !== -1 && doneAt < markerAt ? { ...a, doneAt, pending: false } : a;
  });
}

// When this agent's own transcript says it finished its report, or NaN when it
// does not say so: no transcript, only an earlier launch's under the same name,
// or a last entry that is not a report. A named agent's file carries the name
// the harness GAVE it — the launch's `name` gains a `-2` on a collision, and the
// id (`<name>@session-…`) is what carries the result — and only its exact
// `<name>-<hex>` file counts: a longer stem is another agent. An unnamed agent's
// file carries its id, which is checked for shape before it becomes a path.
function reportFinishedMs(agent, dir, launchMs) {
  const [given, session] = agent.id.split("@");
  const files = session !== undefined
    ? findAgentFiles(dir, given, launchMs).filter((file) => isOwnTranscript(file, given))
    : [path.join(dir, `agent-${agent.id}.jsonl`)].filter((file) => /^[\w-]+$/.test(agent.id) && existsSync(file));
  for (const file of files) {
    let read;
    // Unreadable is no evidence, and no evidence leaves the refusal standing;
    // letting it throw would fail the hook open, which releases the turn.
    try { read = readAgent(file); } catch { continue; }
    if (read.startedMs >= launchMs) return read.endsWithReport ? read.lastMs : NaN;
  }
  return NaN;
}

// ---------- did an independent reader exist? ----------

// A pending agent releases the turn instead of blocking it, because ending the
// turn is how this loop waits. But "pending" is window-wide with a two-prompt
// age-out (PENDING_INTERJECTION_LIMIT), so a crashed agent from an ALREADY-MARKED
// earlier task is still `pending` throughout the whole of the next task — one
// human prompt is the task boundary itself, which is inside the limit. Reproduced
// live 2026-09-07 in both `reviewerState` and `verifierState`: a crashed verifier
// from task 1 released every converged marker in task 2, dismissals unruled, and
// re-marking never cleared it because re-marking adds no human prompt.
//
// The seam the age-out was placed on (comment at PENDING_INTERJECTION_LIMIT) is
// between a slow reviewer and one that crashed and holds the gate OPEN. This is
// the third case it did not have in view: a crashed agent holding the gate DOWN.
//
// Two clauses, and both are load-bearing:
//   launchedAt > prevMarkerAt — the agent was launched for the claim being made
//     now, so it is this marker's business however long it takes. This is what
//     keeps the 2026-08-22 case working: a real reviewer interjected into
//     mid-review still counts as running.
//   interjections === 0 — no human prompt has landed since the launch, so it
//     cannot be a leftover from a previous task. This is what keeps a re-mark
//     inside the same task from blocking: the release message tells the model to
//     re-mark after the agent lands, and re-marking one stop early must not then
//     demand a second agent over the same scope.
const stillRunningFor = (a, prevMarkerAt) =>
  a.pending && (a.launchedAt > prevMarkerAt || a.interjections === 0);

// F10a′ ruling 2, as scoped on 2026-09-02: `converged` claims a review ran, so
// refuse it when no plugin reviewer COMPLETED after the last change and before
// the marker. Three transcript indices; the report is never opened. Grading
// would read what the reviewer said — this asks only whether the sequence of
// events can constitute the claim.
//
// Both bounds are load-bearing. Without the lower one, "reviewer finishes →
// you edit → you mark converged" passes, which is the same failure as
// launch-without-completion with the order flipped, and is the state SKILL.md
// §3 forbids in those words ("you never declare done right after fixing").
// Without the upper one, "launched, marked, stopped, results arrived later"
// passes.
//
// KNOWN LIMIT, in the header's style: a reviewer whose *scope* predates the
// edits it completed after is admitted. This holds "a reader of the final state
// existed by the transcript's clock" — scope is the review's property, not the
// transcript's, and reading it would be grading.
//
// Returns "ok", "running", "late", "stale" or "none". The last three block; the
// four are separated because they take four different actions, and one message
// telling a model to launch a finder when one is already running buys a
// duplicate review of the same scope.
function reviewerState(agents, externalChangeAt, changeAt, markerAt, prevMarkerAt) {
  const orchestrators = orchestratorsIn(agents);
  // Readers UNION orchestrators. A finished orchestrator has read everything it
  // was launched over, so "late" and "stale" have to see it too — otherwise a
  // session whose only reviewer was an orchestrator reads as "none" and the
  // message tells the model to launch a finder it already delegated. Not
  // "running": an orchestrator is an editor, so a pending one is intercepted by
  // the "applying" branch below and never reaches that line.
  const finders = agents.filter((a) => REVIEWER_TYPES.test(a.type));
  const reviewers = [...finders, ...orchestrators];
  // A finder's scope is frozen when it is LAUNCHED, not when it reports: one
  // launched before a change and completing after it read the tree the change
  // replaced (unresolved-write ruling, second half). Background finders notify
  // one at a time, so fixing what one found while another still reads is the
  // ordinary shape of a round, not a corner. A SendMessage resume does not
  // refresh this — the skill's premise is a reader who has not seen the code.
  const fresh = finders.filter((a) => a.launchedAt > changeAt);
  // An applier still running cannot have been read by anyone, whatever the
  // finders did: its edits are not a fixed set yet, so no completion can be
  // "after the last change". Checked before "ok" because a finder that
  // completed after the last MAIN-CHAIN change would otherwise satisfy the
  // condition while the tree is still moving.
  if (editorsIn(agents).some((a) => a.pending)) return "applying";
  if (fresh.some((a) => a.doneAt !== -1 && a.doneAt < markerAt)) return "ok";
  // The orchestrator's own clause, and the reason it is a SEPARATE line rather
  // than a wider `reviewers` filter: its anchor is IN `changeAt`, because it is
  // a change source, so the line above can never admit it. One index on both
  // sides of a strict `>` is a permanent block — which is the failure mode that
  // gets a gate deleted, not merely worked around.
  //
  // What makes it evidence instead is that it is compared to changes it did NOT
  // make. `externalChangeAt` is the lead's own writes plus any MAIN-CHAIN
  // applier; an orchestrator launched after all of those vouches for the tree it
  // was given. An orchestrator launched BEFORE a main-chain applier does not,
  // and this is what refuses it.
  //
  // A SIBLING orchestrator's anchor belongs in that baseline too, and leaving it
  // out was a hole a reviewer reproduced live against the real gate: o1 launches,
  // a lead edit lands, o2 launches and finishes, o1 reports only afterwards. o1
  // is correctly stale against the edit, but o2 cleared the whole session,
  // because `externalChangeAt` excludes every orchestrator rather than only the
  // one being judged — and o1's edits are a fixed set at ITS completion, which
  // o2 had already stopped reading before. The baseline is therefore per-agent:
  // everything THIS orchestrator did not do, siblings included. That is the
  // ruling's own wording — "launched after every change it did not make".
  const vouches = (o) => o.launchedAt > Math.max(externalChangeAt,
    ...orchestrators.filter((x) => x !== o).map(editorAnchor));
  if (orchestrators.some((o) => o.doneAt !== -1 && o.doneAt < markerAt && vouches(o))) return "ok";
  // Still running is not missing. Blocking here would tell the model to spawn a
  // second finder over the same scope, or to poll — and ending the turn is how
  // this loop waits. So this one releases: the completion wakes the model, and
  // the next Stop sees "late" and asks for the re-mark. `stillRunningFor` is
  // what stops a finder crashed in an earlier task from releasing every marker
  // in this one.
  if (reviewers.some((a) => stillRunningFor(a, prevMarkerAt))) return "running";
  // Completed, but after the marker was written: nothing had read the result
  // when the claim was made. Only the mark needs redoing.
  // Only a reader whose scope covers the last change can be late — a finder
  // launched after it, an orchestrator launched after every change it did not
  // make: re-marking on a mid-flight reader's report would clear an edit it
  // never saw.
  if ([...fresh, ...orchestrators.filter(vouches)].some((a) => a.doneAt > markerAt)) return "late";
  // Completed before the last change, or launched before it: the edit behind
  // it was read by nobody.
  return finders.some((a) => a.doneAt !== -1 && a.launchedAt <= changeAt) ||
    orchestrators.some((a) => a.doneAt !== -1 && a.doneAt < changeAt) ? "stale" : "none";
}

// ---------- did an outsider rule on the verdicts? ----------

// Field report 2026-09-07, measured over 8 loops / 24 rounds / 76 candidates:
// THREE verifier agents ran in total. The loop was delivering "fresh readers
// file claims and the author decides" — most of the value, but not the claim on
// the tin, because the author's DISMISSALS went unchecked, and that is exactly
// where author blindness lives.
//
// The cause was not a missing rule. SKILL.md §2d already said to spawn a
// verifier when "dismissals in the round reach three in total" — but it was
// PROSE the session lead had to obey about its own behaviour, and nothing
// counted anything. At a measured ~3.2 candidates per round, three dismissals
// in one round was also near-unreachable, so the one clause that could have
// fired was written above the ceiling of the rounds it governed.
//
// Ruled 2026-09-07 (fresh Fable session at xhigh; question and answer in
// docs/design-notes/), owner-approved with the cost: a verifier is REQUIRED
// when either
//
//   dismissals >= 1                      — the threshold is one, not three,
//     because a wrong FIX is visible in the diff and a wrong DISMISSAL is
//     invisible: the dismissed ledger enters every later finder's brief as a
//     do-not-refile list and `findings.mjs` records it against the repository,
//     so one wrong dismissal suppresses rediscovery in this loop AND in every
//     future loop over those files.
//
//   fixed + dismissed + open > 4         — kept against this file's author's
//     own lean, for the reason that decided it: a dismissal trigger has a COST
//     GRADIENT and a candidate trigger has none. If dismissing costs a verifier
//     spawn and fixing costs nothing, a cost-disciplined lead fixes phantoms.
//     The candidate count is fixed before any verdict is chosen, so nothing the
//     lead decides can move it.
//
// The counts are the marker's own, which is what makes this need no filesystem:
// every one of them is required for `outcome=converged`, they are on the same
// line the outcome is read from, and their sum is this loop's candidate total.
// It is a LOOP total, not the per-round count §2d speaks of — a wider net than
// the ruling's, in the direction the owner paid for.
const CANDIDATE_TRIGGER = 4;
function verifierNeed(counts) {
  if (!counts) return null;
  if (counts.dismissed >= 1) return "dismissed";
  return counts.fixed + counts.dismissed + counts.open > CANDIDATE_TRIGGER ? "candidates" : null;
}

// Did a verifier COMPLETE between the previous marker and this one? "Since the
// last marker" is the frame because that is the span the marker's counts are a
// claim about — a verifier from the loop before it ruled on other findings.
//
// Deliberately NOT ordered against `changeAt` the way `reviewerState` is. A
// verifier rules on candidate FINDINGS, not on the final state of the files, so
// a fix landing after it is the loop working: the whole point of a verdict is
// that something is done about it. Reading a verifier as "stale" because the
// fix it authorised came afterwards would refuse every correctly-run round.
//
// Returns "ok", "running" or "none" — three, not `reviewerState`'s six, because
// the two blocking cases there ("late", "stale") are both orderings this
// question does not ask.
function verifierState(agents, prevMarkerAt, markerAt) {
  const verifiers = agents.filter(isVerifier);
  if (verifiers.some((a) => a.doneAt > prevMarkerAt && a.doneAt < markerAt)) return "ok";
  if (verifiers.some((a) => stillRunningFor(a, prevMarkerAt))) return "running";
  return "none";
}

// ---------- the applier arms the gate (F10b) ----------
//
// An async Agent result is spawn metadata: `toolUseResult.toolStats`, the only
// edit evidence the transcript carries for an agent, is on SYNCHRONOUS results
// only — a real review session made 16 main-chain launches, all async, and none
// carried it. So an applier subagent's edits are invisible to `collectChanges`,
// and the review requirement would disappear exactly when something other than
// the main session is doing the writing.
//
// The launch itself is the evidence, and it is the right kind: an `Agent` call
// names its `subagent_type` in the MAIN CHAIN, which is harness-written, raw,
// and cannot be silently absent. A file the gate writes and later reads was
// tried first and cut — it was authored by the agent under check, absent
// exactly when it mattered, and unbounded.
//
// ARMING IS UNCONDITIONAL. Requiring proof that the applier edited something is
// the hole restated, and the feared cost of arming on a no-op is mispriced:
// what an arm demands is a MARKER, not a review round, and the applier only
// ever launches inside a loop whose every exit path already writes one. An
// applier that edited nothing, or only prose, arms anyway — knowing what it
// touched would mean reading its self-report, which is the manifest shape this
// plugin has already refused twice.
//
// THE ANCHOR IS COMPLETION, NOT LAUNCH. Edits land any time up to completion,
// so a finder that finished between launch and completion read a tree that was
// still moving under it — it would satisfy the letter of "a reviewer completed
// after the last change" while the change was still happening. Completion is
// the earliest index at which the applier's edits are a fixed set. An applier
// that never completed anchors at its launch and stays armed; that is not a
// deadlock, because a `--not-converged` marker discharges it honestly.
//
// AND IT IS MONOTONIC, because this is the only index in the gate that could
// otherwise move BACKWARD. A SendMessage that resumes the applier sets `done`
// false, so `doneAt` reverts to -1 and a launch-or-completion anchor drops back
// to the launch — behind a marker written while the applier was in flight. That
// flips `markerAtW > changeAtW` from false to true and turns a block into a
// silent pass, and it is the accidental-disarm shape: resuming the agent is the
// first thing a model debugging the block reaches for. Reproduced live — adding
// one SendMessage to a blocking fixture released it, the same fixture without
// the resume still blocked. The max also states the honest thing: a resume is a
// fresh dispatch of edit work, so it needs a marker after it, not before it.
const editorAnchor = (a) => Math.max(a.launchedAt, a.resumedAt ?? -1, a.doneAt);
// Its counterpart, and the reason there are two. `editorAnchor` is an upper
// bound because the reviewer check asks when an editor's edits STOPPED being
// able to move; the intent check asks when they could first have STARTED, which
// is the launch and never the completion. Feeding one index to both accepted a
// validator that finished while an applier was already editing — the exact
// claim `intent=validated` exists to deny. A resume does not lower it: the
// launch is still the earliest byte this editor could have written.
const editorStart = (a) => a.launchedAt;
// Whole-window indices, like every other agent record.
const appliersIn = (agents) => agents.filter((a) => APPLIER_TYPE.test(a.type));
const editorsIn = (agents) => agents.filter((a) => isEditor(a.type));
const orchestratorsIn = (agents) => agents.filter((a) => ORCHESTRATOR_TYPE.test(a.type));

// This branch needs a bound of its OWN. `countReminders` counts feedback since
// the last marker, which works for the generic block because a blocked model has
// not marked — but a model refused here HAS marked, and re-marking moves
// `markerAt` past every reminder, so that count resets to zero on each attempt
// and nothing ever releases. So these reminders are counted by their own
// sentence, over the whole turn, and MAX_REMINDERS releases the same way.
const UNREVIEWED_TAG = "outcome=converged claims a review ran";
const countUnreviewed = reminderCounter(UNREVIEWED_TAG);

// The same self-resetting-counter problem as above, one sentence of its own: a
// model refused here HAS marked, so re-marking moves `markerAt` past every
// reminder and a count anchored on it would never reach the release.
const UNVALIDATED_TAG = "intent=validated claims a fresh reader saw the ticket";
const countUnvalidated = reminderCounter(UNVALIDATED_TAG);

// Third of the same shape, and it needs its own sentence for the same reason
// the second did: three refusals sharing one counter would release the gate
// after two attempts at three different problems.
const UNVERIFIED_TAG = "these counts need a verifier behind them";
const countUnverified = reminderCounter(UNVERIFIED_TAG);

// The refusal. It names WHICH trigger fired, because the two want different
// batches: `dismissed` wants the dismissed candidates specifically, and
// `candidates` wants the round's whole set.
function unverifiedReason(need, counts) {
  const total = counts.fixed + counts.dismissed + counts.open;
  const why = need === "dismissed"
    ? [`This marker reports ${counts.dismissed} dismissal${counts.dismissed === 1 ? "" : "s"}, and no self-review-verifier completed since the previous marker.`,
      `A wrong fix is visible in the diff. A wrong dismissal is not — it enters the dismissed ledger, every later finder is briefed not to refile it, and \`findings.mjs\` records it against this repository, so it suppresses rediscovery in future loops too. That is the author bias this loop exists to counter, and the author cannot be the one who rules on it.`,
      `Spawn a verifier over the dismissed candidates (batches of <= 8, one message, then wait.mjs on their names), take its verdicts, and re-mark with your real counts.`]
    : [`This marker reports ${total} candidates (fixed ${counts.fixed}, dismissed ${counts.dismissed}, open ${counts.open}) — more than ${CANDIDATE_TRIGGER} — and no self-review-verifier completed since the previous marker.`,
      `The trigger is the candidate count and not the verdicts on purpose: it is fixed before you choose any of them, so a loop cannot get under it by fixing what it would otherwise have dismissed.`,
      `Spawn a verifier over this round's candidates (batches of <= 8, one message, then wait.mjs on their names), take its verdicts, and re-mark with your real counts.`];
  return [
    `${GATE_TAG} The converged marker was refused: ${UNVERIFIED_TAG}.`,
    ...why,
    // The verifier's name is the containment, not housekeeping: the harness puts
    // a named agent's NAME into the `agent_type` that PreToolUse hooks receive,
    // so `tree-guard` matches on the name. An off-convention verifier has a
    // shell in the author's working tree that no guard is watching — and this
    // gate would not see it either, which is the second reason to say so here.
    `Name it starting with \`self-review-verifier\` (\`self-review-verifier-r2-b1\`), whatever type you spawn it as — that prefix is what tree-guard matches and what this gate reads.`,
    `Then: ${MARKER_BODY}`,
    `If the numbers are wrong, fix the numbers rather than the review — but a dismissal you cannot show a quoted counter-proof for is an open finding, not a dismissed one.`,
  ].join("\n");
}

/**
 * The whole of `intent=validated`: did a ticket validator COMPLETE inside THIS
 * TASK's window, before the first change of that same window?
 *
 * Ordering, and nothing else. The verdict is not read — a `revise` the session
 * acted on is as good as a `sound`, and a gate that graded the ticket would be
 * the rubber stamp the field exists not to be. Completion rather than launch,
 * for the same reason the reviewer check uses it: a validator still running
 * when the first edit landed did not read a ticket the code had not yet
 * contradicted.
 *
 * Both bounds are the task window's, not the whole session's. `taskStart` is
 * the lower one: a validator that finished for an earlier, unrelated task never
 * satisfies this one, and reading the whole window let a single validator
 * anywhere in a session unlock `validated` for every later turn. `firstChange`
 * is the upper one — the earliest change of ANY kind inside the same window,
 * the lead's own edit or an editing subagent's launch, because "before the
 * code" means before the first byte of it, whoever wrote it — its launch, not
 * its completion, because completion is when its edits stopped moving and this
 * question is about when they could have started.
 */
const validatedBeforeCoding = (agents, taskStart, firstChange) =>
  agents.some((a) => TICKET_VALIDATOR_TYPE.test(a.type) && a.doneAt !== -1
    && a.doneAt > taskStart && a.doneAt < firstChange);

function unvalidatedReason(unnamedAt = null) {
  return [
    `${GATE_TAG} The marker was refused: ${UNVALIDATED_TAG}, but no self-review-ticket-validator completed before this task's first code change.`,
    "",
    ...(unnamedAt === null ? [] : [
      `The first change in this task is a shell command at entry ${unnamedAt} whose write target the gate could not resolve. It wrote something; the gate cannot say what. If it wrote only prose, config or scratch, the third exit below applies.`,
      "",
    ]),
    "`intent=validated` is a claim about ORDER, not about quality: a fresh reader saw the intent while it could still change the code. Nothing here reads the validator's verdict — a `revise` you acted on counts exactly as much as a `sound`.",
    "",
    "Three honest ways forward, and each ends the turn:",
    "",
    "  - You wrote the intent yourself and no one else read it before you coded. That is `--intent author`, and it is never refused.",
    "  - You decided the task did not need a validator. That is `--intent skipped`.",
    '  - Your validator did finish before your first edit — in this turn or an earlier turn of this task — and this refusal is a late idle notice. That is `--intent author --note "validator <name> completed before the first edit; idle notice landed late"` — the note is the only free text the marker has, so it is where that record goes.',
    "",
    "Re-run the marker with one of those, in a message of its own. Do not spawn a validator now: it would read a ticket the code has already answered, which is the one thing this field is here to make visible.",
  ].join("\n");
}

// `midFlight`: the reviewer that ran was launched before the last change and
// reported after it, so "landed after it finished" would be false — and the
// model, which saw the completion arrive after its edit, would not believe it.
function unreviewedReason(state, changes, lastChangeAt, cwd, { hasOrchestrator, midFlight }) {
  // Named through describeChanges, which is the one place that knows a change
  // may be a file, a shell command whose targets did not resolve, or a
  // subagent's edit — reading `.file` off it directly prints "undefined" for
  // two of the three kinds.
  const latest = describeChanges(changes.filter((c) => c.index === lastChangeAt), cwd);
  const spawn = `launch one self-review-finder scoped to the changed files — a single finder with an all-angles brief is the legitimate floor, because tier S is exactly that — then wait for it in ONE call with the skill's scripts/wait.mjs (never end the turn to wait, and never poll with ListAgents or TaskOutput), fix anything real it finds,`;
  const [middle, action] = state === "late"
    ? [`A reviewer did complete, but only AFTER the marker was written — nothing had read the result when you claimed it. Do not launch another one: it has already reported.`,
      `Read its report, act on it, and then re-mark, in a message of its own:`]
    : state === "stale"
      ? [midFlight
        ? `A reviewer did complete, but this landed after it was launched — a reviewer reads the tree it was given, so it never saw: ${latest}. Nothing read it but you.`
        : `A reviewer did complete, but this landed after it finished: ${latest} — read by nobody but you.`,
        `Converged is a claim about the final state of the files. So: ${spawn} and re-mark only after a completion with no edits behind it, in a message of its own:`]
      : [`No reviewer agent ran in this window — a verifier alone does not count, because verifying findings you generated yourself is reviewing your own work.`,
        `Converged is a claim about the final state of the files. So: ${spawn} and re-mark only after a completion with no edits behind it, in a message of its own:`];
  return [
    // The orchestrator belongs in both lists, and it was missed in both when
    // F10c folded it into `reviewers`: it can reach "late", "stale" and "none"
    // like any reader, and its completion is a change source like an applier's.
    // A model whose only reviewer WAS an orchestrator would otherwise read a
    // refusal flatly denying any reviewer ran, and start again from zero — which
    // spends in the main session exactly what delegating the loop saves.
    //
    // But it is named only when one is actually HERE. F10i ruled the
    // orchestrator does not ship, so an unconditional mention sends every real
    // install looking for an agent type that is not in `plugin/agents/`, and a
    // refusal must only ever name a way forward that exists. Both halves of the
    // original finding survive this: the session whose only reviewer was an
    // orchestrator still sees it named, because it has one.
    `${GATE_TAG} The converged marker was refused: ${UNREVIEWED_TAG}, but no plugin reviewer (self-review-finder, self-review-cold-grader${hasOrchestrator ? " or self-review-orchestrator" : ""}) completed between the last change — your own edit, or an editing subagent finishing — and the marker.`,
    middle,
    `${action} ${MARKER_BODY}`,
    `If the review ran but did not finish, that is a different and honest claim: mark it --not-converged with your real counts. If the loop genuinely does not apply, name that instead: ${NA_BODY}. Reasons: ${NA_REASONS.join(", ")} (note required for "other").`,
  ].join("\n");
}

// ---------- decision ----------

function evaluate(entries, cwd, transcriptPath) {
  const lastMessage = [...entries].reverse().find((e) => e.type === "user" || e.type === "assistant");
  if (!lastMessage || isInterrupt(lastMessage)) return null;

  // Every human prompt, not just the last: the task window reaches back across
  // the ones an agent was working through. `boundary` stays the last of them.
  const humanAt = [];
  entries.forEach((entry, index) => { if (isHumanPrompt(entry)) humanAt.push(index); });
  const boundary = humanAt.length ? humanAt[humanAt.length - 1] : -1;
  const turn = entries.slice(boundary + 1);
  // When the turn began, by the transcript's own clock: the cutoff for
  // "this turn wrote it" in writesSince().
  const since = Date.parse(entries[boundary]?.timestamp ?? turn[0]?.timestamp ?? "");
  const changes = collectChanges(turn, cwd, since);

  // Keyed by tool_use id, so a window-wide map serves both the turn-scoped
  // marker lookup and the window-wide pending scan below.
  const results = toolResultsById(entries);
  // Agents are scanned over the whole window, not just this turn: a reviewer
  // launched before a human interjection is still running, and turn-scoping made
  // exactly those finders invisible (a live false block). Age-out inside
  // scanAgents keeps a crashed agent from holding the gate open forever.
  const agents = scanAgents(entries, results);
  // An applier's writes land whenever they land, and this gate deliberately
  // releases a turn while a subagent runs so the human can type — so the turn
  // is the wrong frame for it, and the whole window is the right one. Nothing
  // to review and no editing subagent ever launched — neither an applier nor an
  // orchestrator — is today's silent pass.
  const appliers = appliersIn(agents);
  const orchestrators = orchestratorsIn(agents);
  const editors = editorsIn(agents);
  if (changes.length === 0 && editors.length === 0) return null;

  // BOTH FRAMES, together, because getting them apart is what went wrong here,
  // and the frame each field takes is decided by WHAT GATES IT.
  //
  // `outcome` and `fileMarker` are read over the WHOLE WINDOW, because the only
  // place they are consumed is inside `markerAtW > changeAtW` — a window-scoped
  // test, so by construction they cannot be stale when read.
  //
  // `markerAt` and `rejected` stay TURN-SCOPED, for opposite reasons. `markerAt`
  // is an index into `turn`, which is all countReminders can use. `rejected` has
  // no gate at all: the fallback branch acts on it unconditionally, without
  // comparing it to `changeAtW` or to anything else. Turn scope was its only
  // bound, and window-scoping it alongside the other two was a REGRESSION caught
  // in round 2 — a rejected marker attempt in one turn then answered the next
  // turn's block, for a turn that wrote no marker, telling the model to fix a
  // record it had not written and never naming the file it had just changed.
  // Proven against the 932c109 binary: old names `src/b.ts`, new reported "1
  // problem(s) with the record". A field with no gate does not get the frame of
  // the fields that have one. Reading the outcome at turn scope under a window-scoped
  // test was a silent pass: an applier keeps the gate armed across a human
  // prompt, the new turn holds no marker of its own, `outcome` read null, the
  // ternary below defaulted to "ok", and reviewerState — the check that refuses
  // a converged claim with no reviewer behind it — was never called. Reproduced
  // live: identical facts block in the same turn and pass silently one human
  // prompt later. logFileMarker is safe at window scope because it already
  // dedupes on the marker id anywhere in the log.
  const { at: markerAt, rejected } = lastMarker(turn, results, cwd);
  const { at: markerAtW, fileMarker, outcome, intent, counts } = lastMarker(entries, results, cwd);
  const lastChangeAt = changes.length ? Math.max(...changes.map((c) => c.index)) : -1;
  // ONE INDEX FRAME, declared before it is used twice below. markerAt and
  // lastChangeAt are turn-relative; agent records carry whole-window indices.
  const toWindow = (i) => i + boundary + 1;
  // The latest thing needing a marker behind it, in window indices: the last
  // main-chain change, or the applier's completion, whichever is later.
  // Everything the orchestrator did NOT do: the lead's own writes, and any
  // applier launched on the main chain beside it. This is the lower bound of the
  // orchestrator's evidence clause in `reviewerState`.
  const externalChangeAt = Math.max(
    changes.length ? toWindow(lastChangeAt) : -1,
    ...appliers.map(editorAnchor),
  );
  // The latest thing needing a marker behind it. The orchestrator's anchor joins
  // it here — as a change source it is indistinguishable from an applier, and
  // leaving it out is what lets a `not-converged` marker written mid-flight sit
  // ahead of `changeAtW` while the orchestrator's applier is still editing.
  const changeAtW = Math.max(externalChangeAt, ...orchestrators.map(editorAnchor));
  // One frame for everything that becomes prose, so a message cannot describe
  // the wrong entry: file changes converted up, appliers already there.
  const inFrame = [
    ...changes.map((c) => ({ ...c, index: toWindow(c.index) })),
    // No agent type on the record: nothing reads one, and round 1 removed the
    // only thing that did. Carrying it anyway is a field a later edit could
    // innocently print, reopening the leak with no test to catch it.
    ...appliers.map((a) => ({ index: editorAnchor(a), kind: "applier" })),
    ...orchestrators.map((a) => ({ index: editorAnchor(a), kind: "orchestrator" })),
  ];
  // What still has no marker behind it — what the generic block is about, where
  // naming an applier that was already reviewed and marked would be wrong.
  // The REFUSAL message must not use this list. It runs only when the marker is
  // ahead of every change, so this filter drops EVERY applier by construction —
  // including the one at changeAtW, which is the one that message has to name.
  // It read "you changed  after it finished" in exactly the scenario the applier
  // arming exists to catch.
  const described = inFrame.filter((c) => (c.kind !== "applier" && c.kind !== "orchestrator") || c.index > markerAtW);

  // THIS TASK'S WINDOW, for the intent check alone. Every index here is a
  // WINDOW index. `intent=validated` is a claim about one ticket, so both halves
  // of it — the validator's completion and the first byte of code it has to
  // precede — must be read inside the task the marker is about. Read over the
  // whole window instead, the check failed in both directions at once: an
  // orchestrator from an already-marked round collapsed `Math.min` onto its own
  // launch so no validator could beat it, and one validator anywhere in a
  // session permanently unlocked `validated` for every later unrelated turn.
  //
  // `lastMarker` sets `at` only for an accepted marker: a rejected file write
  // sets `rejectedAt`, and a script call whose output lacks the token sets
  // nothing. So this is unambiguous without reading any outcome.
  const prevMarkerAt = markerAtW >= 0 ? lastMarker(entries.slice(0, markerAtW), results, cwd).at : -1;
  // A human prompt is an INTERJECTION when some agent launched before it was
  // still running across it; it is a TASK BOUNDARY when none was. Turn-scoping
  // on `boundary` alone reintroduces the 2026-08-22 false block, because an
  // applier launched before an interjection and completing after it is exactly
  // the shape that was made invisible. A missing completion counts as spanning
  // only while the agent is still `pending` — `!done && interjections <
  // PENDING_INTERJECTION_LIMIT` — which is what bounds a crashed agent to two
  // prompts. Testing `doneAt === -1` alone instead read every crashed agent as
  // eternally live, so one anywhere in the session pinned `taskStart` at -1 and
  // handed a later, unrelated task an earlier task's validator: the exact false
  // accept the window exists to prevent, reached from the other side.
  const spans = (h) => agents.some((a) => a.launchedAt < h && (a.doneAt > h || (a.doneAt === -1 && a.pending)));
  let spanStart = -1;
  for (let i = humanAt.length - 1; i >= 0; i -= 1) {
    if (!spans(humanAt[i])) { spanStart = humanAt[i]; break; }
  }
  // The later of the two cuts. With no previous marker and nothing spanning, this
  // is `boundary` — which is what refuses a validator run for an earlier task.
  const taskStart = Math.max(spanStart, prevMarkerAt);

  if (markerAtW > changeAtW) {
    // Only an affirmative `converged` is gated: the other two outcomes are
    // honest claims that need no reader, and an outcome that could not be read
    // is never refused on a guess.
    //
    // There is deliberately NO exception here for a launch whose text did not
    // parse. One stood here and took a finding from each direction in the same
    // round, both reproduced live: a *failed* Agent call is indistinguishable
    // from a reworded one, so a single errored launch disabled the whole check
    // and let `converged` through with provably zero reviewers; and it was
    // defeated by any *other* agent that did parse, falsely blocking a turn
    // that was genuinely reviewed. Two directions of failure on one mechanism
    // is the shape being wrong, not the patch. Harness drift is still handled,
    // one layer out: the refusal is bounded by MAX_REMINDERS below, so a
    // phrasing change costs two turns and a visible notice rather than a
    // deadlock — a bound is cheaper than a hole.
    // Both bounds in window indices — see the frame note above. The lower one
    // is the applier-aware change point, so `converged` after an applier needs
    // a finder that completed after the APPLIER finished, not merely after the
    // lead's own last edit.
    // Read only when the notices alone would not pass — see settleFromTranscripts.
    let settled;
    const settledAgents = () => (settled ??= settleFromTranscripts(agents, entries, markerAtW, transcriptPath));
    let state = outcome === "converged"
      ? reviewerState(agents, externalChangeAt, changeAtW, markerAtW, prevMarkerAt)
      : "ok";
    if (state !== "ok" && state !== "applying") {
      state = reviewerState(settledAgents(), externalChangeAt, changeAtW, markerAtW, prevMarkerAt);
    }
    // A reviewer still working is not a missing one, and this loop waits by
    // ending turns: release, exactly as the pending branch below does.
    if (state === "running") {
      return {
        systemMessage: `self-review gate: a converged marker landed while a reviewer is still running — turn released so its report can arrive; re-mark after it lands and the gate re-checks at the next stop`,
      };
    }
    // Same release, different cause: the applier is still writing, so there is
    // nothing stable to have reviewed yet. Releasing rather than blocking is
    // the loop's own way of waiting — the completion wakes the model, and the
    // next Stop sees a finished applier and asks for the re-mark.
    if (state === "applying") {
      return {
        systemMessage: `self-review gate: a converged marker landed while an editing subagent is still running — turn released so its edits can finish; review them and re-mark after it reports`,
      };
    }
    if (state !== "ok") {
      const refusals = countUnreviewed(turn);
      if (refusals >= MAX_REMINDERS) {
        return {
          systemMessage: `self-review gate: released after ${refusals} refusals of a converged marker with no reviewer completion behind it — the review may not have run. (SELF_REVIEW_GATE=off disables the gate.)`,
        };
      }
      return {
        decision: "block",
        reason: unreviewedReason(state, inFrame, changeAtW, cwd, {
          hasOrchestrator: orchestrators.length > 0,
          // The agents the state was judged on: settled ones when the transcripts were read.
          midFlight: (settled ?? agents).some((a) => REVIEWER_TYPES.test(a.type) && a.launchedAt <= changeAtW && a.doneAt > changeAtW),
        }),
        systemMessage: `self-review gate: converged marker refused — no reviewer completion after the last change (an independent reader of the final state is required)`,
      };
    }
    // The verdicts, after the read. Two conditions on one marker that must not
    // be conflated: the check above refuses a marker with no independent reader
    // and explicitly does NOT count a verifier as one; this one refuses a marker
    // whose counts say the author ruled alone on findings that needed an
    // outsider. Order is the obligations' order — a session with no reviewer at
    // all is told to review before it is told who should rule on the verdicts.
    const need = outcome === "converged" ? verifierNeed(counts) : null;
    if (need) {
      let verified = verifierState(agents, prevMarkerAt, markerAtW);
      if (verified !== "ok") verified = verifierState(settledAgents(), prevMarkerAt, markerAtW);
      // Same release as the reviewer branch, same reason: this loop waits by
      // ending turns, and a verifier still working is not a missing one.
      if (verified === "running") {
        return {
          systemMessage: `self-review gate: a converged marker landed while a verifier is still running — turn released so its verdicts can arrive; re-mark after they land and the gate re-checks at the next stop`,
        };
      }
      if (verified === "none") {
        const refusals = countUnverified(turn);
        if (refusals >= MAX_REMINDERS) {
          return {
            systemMessage: `self-review gate: released after ${refusals} refusals of a converged marker whose ${need === "dismissed" ? "dismissals" : "candidate count"} needed a verifier — the verdicts may be the author's alone. (SELF_REVIEW_GATE=off disables the gate.)`,
          };
        }
        return {
          decision: "block",
          reason: unverifiedReason(need, counts),
          systemMessage: `self-review gate: converged marker refused — ${need === "dismissed" ? `${counts.dismissed} dismissal${counts.dismissed === 1 ? "" : "s"}` : `${counts.fixed + counts.dismissed + counts.open} candidates`} with no verifier completion behind them`,
        };
      }
    }
    // The intent claim, after the reviewer one: both can fail at once, and the
    // review is the older and larger obligation, so it is the one named first.
    // Not `inFrame`: that list carries completion anchors, which are the wrong
    // bound for this question (see `editorStart`).
    //
    // The earliest byte of this task's code, from either hand: a main-chain
    // edit, or an editing subagent's LAUNCH. `editorStart`, never
    // `editorAnchor` — see its comment for why the two checks need opposite
    // bounds — and both restricted to this task's window, because a validator
    // is a claim about this ticket and an editor from a finished task is not
    // evidence about it.
    const written = firstWriteEvent(entries, taskStart, markerAtW, cwd);
    const firstChange = Math.min(
      written ? written.index : Infinity,
      ...appliers.filter((a) => a.launchedAt > taskStart).map(editorStart),
      ...orchestrators.filter((a) => a.launchedAt > taskStart).map(editorStart),
    );
    // An unresolved first write is still the task's first write, and the
    // refusal says so: the session knows what its own shell command did, and
    // the third exit is right there if it wrote only prose, config or scratch.
    const unnamed = written !== null && written.unresolved === true && written.index === firstChange;
    // Not `inFrame.length`: a marker whose task window holds no change has
    // nothing to be ordered against, and refusing it would refuse a marker
    // re-seen at a later Stop because a whole-window applier kept the gate armed.
    if (intent === "validated" && Number.isFinite(firstChange) && !validatedBeforeCoding(agents, taskStart, firstChange)) {
      const refusals = countUnvalidated(turn);
      if (refusals >= MAX_REMINDERS) {
        return {
          systemMessage: `self-review gate: released after ${refusals} refusals of intent=validated with no ticket-validator completion before the first change — the intent may never have been read. (SELF_REVIEW_GATE=off disables the gate.)`,
        };
      }
      return {
        decision: "block",
        reason: unvalidatedReason(unnamed ? written.index : null),
        systemMessage: `self-review gate: intent=validated refused — no ticket-validator completed before this task's first code change`,
      };
    }
    if (fileMarker) logFileMarker(fileMarker, cwd);
    return null;
  }

  const pending = agents.filter((a) => a.pending).length;
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
  const beside = markerAtW !== -1 && markerAtW === changeAtW
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
  if (remarkOnly(outcome, markerAtW, inFrame, editors)) {
    return {
      decision: "block",
      reason: remarkReason(outcome),
      systemMessage: `self-review gate: an editing subagent finished after the ${outcome} marker — re-mark with the same outcome`,
    };
  }
  return {
    decision: "block",
    reason: blockReason(described, reminders, cwd) + beside,
    systemMessage: `self-review gate: ${describeChanges(described, cwd)} — ${lastChange(described)?.kind === "orchestrator" ? "read its report and re-mark before the turn ends" : "running the review loop before the turn ends"}`,
  };
}

// An honest `not-converged` or `not-applicable` marker needs no reader, only a
// place after the last change — and when everything after it is an editor that
// was ALREADY running when it was written, finishing is the only thing that
// moved. The generic text then sent a lead who had just obeyed ESCALATE back
// into a round (review-identity ruling D2). An editor launched or resumed after
// the marker is new work, and a main-chain change after it is the lead's own:
// both keep the generic block.
function remarkOnly(outcome, markerAtW, inFrame, editors) {
  if (outcome !== "not-converged" && outcome !== "not-applicable") return false;
  if (markerAtW === -1) return false;
  const later = inFrame.filter((c) => c.index > markerAtW);
  const laterEditors = editors.filter((a) => editorAnchor(a) > markerAtW);
  return later.length > 0
    && later.every((c) => c.kind === "applier" || c.kind === "orchestrator")
    && laterEditors.every((a) => a.launchedAt < markerAtW && a.resumedAt < markerAtW);
}

function remarkReason(outcome) {
  return [
    `${GATE_TAG} ${REMARK_TAG}. Its claim still stands, but a marker has to come after the last change, and an editing subagent's completion is one.`,
    `So: re-mark, same outcome — no round required. Write the same ${outcome} record again, with the same counts, in a message of its own.`,
  ].join("\n");
}

function shortPath(file, cwd) {
  if (cwd && file.startsWith(cwd + "/")) return file.slice(cwd.length + 1);
  return file.startsWith(HOME + "/") ? "~" + file.slice(HOME.length) : file;
}

function describeChanges(changes, cwd) {
  const files = [...new Set(changes.flatMap((c) => c.kind === "file" ? [c.file] : c.kind === "bash" ? c.files : []).map((f) => shortPath(f, cwd)))];
  const bash = changes.filter((c) => c.kind === "bash");
  const agents = changes.filter((c) => c.kind === "agent").length;
  const appliers = changes.filter((c) => c.kind === "applier");
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
    // Said, because the command itself looks harmless: what it named was prose
    // or scratch, and the code that changed is only the working tree's word.
    if (bash.some((c) => c.vetoed)) parts.push("a command the parser read as prose-only ran in a turn where unexplained code beside what it named changed");
  }
  if (agents) parts.push(`${agents} subagent(s) that edited files`);
  // Named by what it IS, not by what it wrote: the launch is the evidence, and
  // asking the applier what it touched would be the self-report this gate does
  // not accept. "may have edited" is the honest wording — an applier that
  // changed nothing arms exactly the same, and saying otherwise would be a
  // claim the gate cannot support.
  // The COUNT only, exactly as the synchronous-agent line above does. The type
  // is model-authored text: echoing it verbatim let a crafted subagent_type
  // print the gate's own refusal sentence into the reason, which the gate then
  // counts as one of ITS reminders — MAX_REMINDERS reached, next bogus marker
  // released — and let a 20,000-character type produce a 21,653-character
  // block. Reproduced live, both halves.
  if (appliers.length) parts.push(`${appliers.length} applier subagent(s) that may have edited files`);
  // The count only, for the same reason as the applier line above: the type is
  // model-authored text.
  const orchestrators = changes.filter((c) => c.kind === "orchestrator");
  if (orchestrators.length) parts.push(`${orchestrators.length} orchestrator subagent(s) that ran a review and may have edited files`);
  return parts.join(" · ");
}

// The latest change in the frame, by transcript position. Two callers need it
// and they must agree: the block's own sentence and the one-line status beside
// it would otherwise name different next steps.
const lastChange = (changes) =>
  changes.length ? changes.reduce((a, c) => (c.index > a.index ? c : a)) : null;

function blockReason(changes, reminders, cwd) {
  const lead = reminders > 0
    ? `Second reminder: no converged marker has appeared since your last edit. `
    : "";
  // An orchestrator that completed with nothing after it has ALREADY run the
  // loop, so "run the review loop" is the wrong instruction here: it would pay
  // for the review a second time and pull back into the main session exactly
  // the context the orchestrator exists to keep out of it. What is missing is
  // the marker, not the review. The test is the LAST change in the frame — a
  // lead edit after the completion is unread by anyone, and that case wants the
  // loop.
  const latest = lastChange(changes);
  const now = latest?.kind === "orchestrator"
    ? `${lead}Now: read its report and act on anything it left open, then mark convergence in a message of its own, AFTER your last edit: ${MARKER_BODY} — the marker is what clears this gate. Do not launch a second review of the same tree. If it FAILED, its completion is not a review: invoke the Skill tool with skill "${SKILL_NAME}" and run the loop yourself.`
    : `${lead}Now: invoke the Skill tool with skill "${SKILL_NAME}" and follow it to convergence — fresh reviewer subagents, verify each candidate, fix what survives, re-review until a round is clean. Finish by marking convergence in a message of its own, AFTER your last edit: ${MARKER_BODY} — the marker is what clears this gate — and only then write your final summary.`;
  return [
    `${GATE_TAG} Files changed this turn but ${UNMARKED_TAG}, so the turn cannot end yet.`,
    `Changed: ${describeChanges(changes, cwd)}`,
    now,
    // Suppressed on the orchestrator branch, which has just told the model not
    // to launch anything: advice about waiting on reviewers it is not spawning
    // reads as an instruction to spawn them.
    ...(latest?.kind === "orchestrator" ? [] : [`After spawning reviewers, wait in ONE call with the skill's scripts/wait.mjs (Bash timeout 600000) — it blocks on the reviewers' own transcripts and prints who finished and who died. Do not end the turn to wait, and never poll with ListAgents or TaskOutput: each check is a full-context turn that tells you nothing new. This gate does let the turn end while subagents run, which is the fallback for a wait.mjs that cannot run, not the way to wait.`]),
    `If the review genuinely does not apply, mark that outcome rather than skipping the marker — but name it, because it is a different claim: ${NA_BODY}. Reasons: ${NA_REASONS.join(", ")} (note required for "other").`,
  ].join("\n");
}

// A refused marker. Every defect at once, and the exact body to write — the
// model is one message away from ending the turn, and a partial correction
// costs another full-context Stop cycle to reject again.
function rejectionReason(problems) {
  return [
    `${GATE_TAG} A convergence marker was written, but the record ${REJECTED_TAG}.`,
    ...problems.map((problem) => `  - ${problem}`),
    `Write it again, in a message of its own, with every field: ${MARKER_BODY}`,
    `If the review does not apply: ${NA_BODY}. Reasons: ${NA_REASONS.join(", ")} (note required for "other").`,
  ].join("\n");
}

runHook("SELF_REVIEW_GATE", "self-review-gate", (payload) => {
  if (typeof payload.transcript_path !== "string") return null;
  return evaluate(readMainChain(payload.transcript_path), payload.cwd ?? process.cwd(), payload.transcript_path);
});
