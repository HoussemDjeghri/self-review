#!/usr/bin/env node
// self-review wait — block inside one call until this round's reviewers report.
//
// Usage:
//   wait.mjs --work <dir> --round N [--session <id>] [name…]
//
// Names default to the stems of `round-N/briefs/*.md`; the verifier and applier
// waits pass their own name. Run it with the Bash tool's `timeout` at 600000.
//
// Why a script rather than ending the turn. The lead used to wait by ending its
// turn and letting each reviewer's completion notification wake it. On
// 2026-09-03 that channel dropped three reports — SendMessage returned
// `success:true` for each — and the session sat idle for 2h49m while the
// reviewers' transcripts on disk had said "finished" within ten minutes. The
// transcripts are the signal this plugin owns; the wake-ups are a courtesy.
// Waiting inside one call is also *cheaper* than being woken: a wake is a
// full-context turn per finisher, and this is one turn for the whole round.
//
// The other candidate signal, "N state files non-empty", is wrong — though not
// for the reason first written here. That reason was "a finder with nothing to
// report writes `[]` and never touches its state file", and 2026-09-08
// falsified it: a finder wrote `[]` into its lifeboat. What holds is weaker and
// still enough. In two rounds of this repo's own review, "nothing to report"
// arrived three ways — no file at all, a zero-byte file, and `[]` — so a count
// of non-empty files settles neither direction: it waits out the clock on the
// first two and reads a report into the third.
//
// Exit 0 every reviewer settled (collect now) · 1 call ceiling reached with
// budget left (call it again, immediately) · 3 the round's wait budget is spent
// (treat the still-active ones as dead) · 2 usage, a budget already spent, a
// name with no transcript while every other reviewer settled (a wrong name: the
// table says which transcripts are close), or no transcripts to watch, which is
// the one case where ending the turn is still the way to wait.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOG_DIR, isMain, loadConfig } from "../hooks/lib/config.mjs";
import { agentNameOf, agentStatus, findAgentFiles, readAgent, resolveSubagentsDir } from "../hooks/lib/agents.mjs";
import { reviewName, reviewNumber } from "./brief.mjs";
import { editDistance } from "./lib/edit-distance.mjs";
import { gitRoot } from "./lib/repo.mjs";
import { ROLE, logReviewRow, roleOf, tally } from "./lib/review-log.mjs";

const POLL_MS = 5000;
// Polls are POLL_MS apart while this process runs, so a gap far wider than that
// is time the process did not run at all: the host was asleep. A suspended
// laptop stops the reviewers in the same window, and counting that window as
// their silence declared a whole round dead with "0m of budget left" — and the
// lead then salvaged and re-spawned finders that went on to finish (a 4h23m
// review). Slept time therefore counts toward neither the stale limit nor the
// budget.
const SLEEP_GAP_MS = 60_000;
// A name with no transcript, while every other reviewer has settled, is a
// wrong name rather than a slow start: a spawned agent writes its first line
// within seconds. This is that "seconds", with room; past it the wait stops
// instead of sitting out the stale limit (660s, longer than one call) on a
// name nothing will ever write under.
const NO_TRANSCRIPT_GRACE_MS = 60_000;
// A wait that can return in seconds is a wait the lead will call in a loop, and
// a loop of calls is the turn-per-check cost this script exists to remove. So
// while anything is still working, no call returns sooner than this.
const MIN_CALL_MS = 120_000;
// How a wait ended, as the durable log spells it. Exit 1 is absent: the wait
// has not ended, the caller is told to call again.
const ENDED = { 0: "settled", 2: "unknown-name", 3: "budget-spent" };

const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });

function parseArgs(argv) {
  const flags = ["work", "round", "session"];
  const options = { names: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { options.names.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!flags.includes(name)) throw usage(`unknown argument ${arg}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw usage(`--${name} needs a value`);
    options[name] = value;
  }
  return options;
}

const mtimeOr = (file, fallback) => { try { return statSync(file).mtimeMs; } catch { return fallback; } };

// `null` when there is no state file at all, which is NOT the same news as a
// state file holding nothing — both are normal, but a lead that reads "0" for a
// reviewer whose findings are sitting in `round-N/state/` under another name (a
// respawn, §2f, files under the name it was respawned as) learns to distrust
// the column and goes back to reading the files by hand every round, which is
// the per-round polling the whole script exists to remove. Reported 2026-09-07
// after three days of use.
//
// It counts CANDIDATES, not lines, because the two diverge in both directions
// and a line count is wrong in each. The header's prediction above — amended
// there — was falsified on 2026-09-08 by a finder that wrote `[]` into the
// lifeboat, which is the empty-list form its own agent file tells it to return;
// the column said `1 filed` and the lead went looking for a candidate that was
// never there. The mirror case costs more: the lifeboat's salvage value is a
// dying finder's work, and a finder that appends its whole array at once puts
// every candidate it had on a single line, which a line count renders as `1`.
// An unparseable line still counts as one, because a truncated append is a line
// the lead has to go and read.
const stateLinesIn = (file) => {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  return text.split("\n").filter(Boolean).reduce((n, line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return n + 1; }
    return n + (Array.isArray(parsed) ? parsed.length : 1);
  }, 0);
};

// The fallback session id is in the work dir's own path — the scratchpad Claude
// Code hands a session is `<project>/<session-id>/scratchpad/…` — so a shell
// without CLAUDE_CODE_SESSION_ID still needs no --session. It is the fallback,
// not the first choice, because the path can name another session's scratchpad
// while the variable always names the session holding the reviewers.
export const sessionIdFrom = (workDir) =>
  /[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]scratchpad([/\\]|$)/i.exec(workDir)?.[1] ?? null;

// Reads each agent's transcript, re-parsing only the files that grew since the
// last poll. A finder's transcript reaches a few hundred KB and a round waits
// on six of them every five seconds; parsing all of it every time would spend
// more CPU than the review.
export function makeReader() {
  const cache = new Map();
  return (file) => {
    const mtimeMs = mtimeOr(file, 0);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.agent;
    const agent = readAgent(file);
    cache.set(file, { mtimeMs, agent });
    return agent;
  };
}

// The host's sleep that lies after `fromMs`: a reviewer's silence is measured
// on the wall clock, less only the time the host slept since it last wrote.
const sleptAfter = (sleeps, fromMs) =>
  sleeps.reduce((sum, { from, to }) => sum + Math.max(0, to - Math.max(from, fromMs)), 0);

// One row per reviewer: what the transcripts say right now.
export function poll({ names, dir, since, roundDir, now, config, waitStartMs, read, sleeps = [] }) {
  const quietNow = (fromMs) => now - sleptAfter(sleeps, fromMs);
  return names.map((name) => {
    const agent = findAgentFiles(dir, name, since)
      .map(read)
      // `since` prefiltered on mtime; the first message's own timestamp is what
      // actually separates a re-spawn from the attempt it replaced. A transcript
      // timestamp is integer milliseconds and an mtime is not, so the floor is
      // floored — a sub-millisecond difference must not read as "an earlier
      // attempt".
      .find((a) => a.startedMs === 0 || a.startedMs >= Math.floor(since));
    const stateLines = stateLinesIn(path.join(roundDir, "state", `${name}.jsonl`));
    if (!agent) {
      // Never started. Silence before the first message is silence all the
      // same, timed from when this wait began rather than from a file that
      // does not exist.
      const quiet = quietNow(waitStartMs) - waitStartMs;
      return {
        name, stateLines, calls: 0, lastAt: "—",
        status: quiet > config.staleSeconds * 1000 ? "dead" : "active",
        note: "no transcript",
      };
    }
    return {
      name, stateLines, calls: agent.calls, lastAt: agent.lastAt, matched: agent.name,
      status: agentStatus(agent, quietNow(agent.mtimeMs), config),
      // The row carries the error itself, because which KIND it is decides the
      // remedy and only the transcript knows: a nudge resumes a dropped
      // connection and merely spends another refusal against a quota limit.
      stall: agent.apiError,
      note: "",
    };
  });
}

export function render(rows, verdict, extra = [], sessionId = undefined) {
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = rows.map((r) =>
    `${r.name.padEnd(width)}  ${r.status.padEnd(8)}  last ${r.lastAt.padEnd(19)}  ${String(r.calls).padStart(3)} calls  ` +
    `${r.stateLines === null ? "no file" : `${r.stateLines} filed`}${r.note ? `  (${r.note})` : ""}`);
  return [...lines, verdict, ...deadAdvice(rows, sessionId), ...stallAdvice(rows), ...extra].join("\n");
}

// A stalled reviewer is the one status whose remedy is neither "collect it"
// nor "give up on it", so the table alone would not be actionable: the caller
// has to be told, per agent, that the work is intact and what to send. The
// error text is quoted rather than classified away — a 522 and a reset time
// are different facts and the lead is the one acting on them.
// The other half of the "0 filed" confusion: a state file in this round that
// belongs to no reviewer being waited on. §2f respawns a dead finder under a
// new name, so its first attempt's findings stay on disk under the OLD one —
// the lead globs `round-N/state/*.jsonl`, sees candidates, reads "no filed" in
// the table, and concludes the counter is broken. It is not; the two are
// looking at different names. Naming the orphans is what makes them
// collectable instead of merely confusing, because `salvage.mjs` can still
// read them.
//
// A file named after a row of this round's plan is not an earlier attempt: it
// is a finder that writes under its row's name while it was spawned under
// another, so the lead is waiting on a name the state file does not carry.
//
// Only the stage being waited on is looked at. The finders' state files stay
// in round-N/state/ while the lead waits on the verifier and then the applier,
// and reading them there named every finder as "spawned under another name" or
// "an earlier attempt" on one wait call in six (145 of 910).
const stageOf = (name) => {
  const role = ROLE.exec(name)?.[1] ?? null;
  return role === "cold-grader" ? "finder" : role;
};

export function orphanAdvice(rows, stateDir, files, planned = []) {
  const waited = new Set(rows.map((r) => r.name));
  const stages = new Set(rows.map((r) => stageOf(r.name)));
  const unwaited = files
    .filter((f) => {
      if (!f.endsWith(".jsonl")) return false;
      const name = f.slice(0, -".jsonl".length);
      return !waited.has(name) && stages.has(stageOf(name));
    })
    .sort();
  const rowNames = new Set(planned);
  const misnamed = unwaited.filter((f) => rowNames.has(f.slice(0, -".jsonl".length)));
  const orphans = unwaited.filter((f) => !misnamed.includes(f));
  return [...misnamedAdvice(stateDir, misnamed), ...earlierAttempts(stateDir, orphans)];
}

function misnamedAdvice(stateDir, files) {
  if (files.length === 0) return [];
  return [
    `# ${files.length} plan row${files.length === 1 ? "" : "s"} filed under ${files.length === 1 ? "its" : "their"} own name, which no reviewer above carries —`,
    "# spawned under another name. Spawn with the name brief.mjs printed; the candidates are here:",
    ...files.map((f) => `#   ${path.join(stateDir, f)}`),
  ];
}

function earlierAttempts(stateDir, orphans) {
  if (orphans.length === 0) return [];
  // Both sentences agree with the count, not just the noun: the second line is
  // as singular as the first ("an earlier attempt … Its candidates"), so
  // conjugating only `file` moved the disagreement into the plural branch
  // instead of removing it.
  const one = orphans.length === 1;
  return [
    `# ${orphans.length} state file${one ? "" : "s"} in this round belong${one ? "s" : ""} to no reviewer above — ${one ? "an earlier attempt" : "earlier attempts"}`,
    `# that §2f respawned under a new name. ${one ? "Its" : "Their"} candidates are still on disk and still collectable:`,
    ...orphans.map((f) => `#   ${path.join(stateDir, f)}`),
  ];
}

// The plan's names as brief.mjs printed them: tier.json holds them without the
// review number, the briefs and state files with it.
const plannedNames = (roundDir, review) => {
  try {
    return JSON.parse(readFileSync(path.join(roundDir, "tier.json"), "utf8")).finders
      .map((row) => reviewName(row.name, row.agent, review));
  } catch {
    return [];
  }
};

// The names of this round's transcripts that no waited row was matched to —
// where the agent a wrong name meant to find is, if it ran at all.
function unclaimedNames(dir, since, rows) {
  const claimed = new Set(rows.map((r) => r.matched).filter(Boolean));
  let files = [];
  try { files = readdirSync(dir); } catch { return []; }
  return [...new Set(files
    .filter((f) => f.startsWith("agent-a") && f.endsWith(".jsonl") && mtimeOr(path.join(dir, f), 0) >= since)
    .map((f) => agentNameOf(path.join(dir, f)))
    .filter((name) => name && !claimed.has(name)))].sort();
}

// The two wrong names measured in the field: the base name where the harness
// had suffixed it (`X` for `X-3`), and several names joined into one shell
// word. Both are a substring relation; a typo is the edit distance.
export function nearMatches(name, candidates) {
  const base = (n) => n.replace(/-\d+$/, "");
  return candidates
    .filter((c) => c.includes(name) || name.includes(c) || base(c) === base(name) || editDistance(c, name) <= 2)
    .slice(0, 3);
}

// Rows with no transcript at all while every row that has one has settled.
const missingWhileSettled = (rows) => {
  const missing = rows.filter((r) => r.status === "active" && r.note === "no transcript");
  return missing.length && rows.every((r) => missing.includes(r) || r.status !== "active") ? missing : [];
};

// A dead reviewer's remedy is a command, and SKILL.md §2f tells the lead the
// tool prints it with the names already substituted — so it has to, or that
// promise sends them to a reference file to assemble it by hand. The verdict
// line can only say "a dead one goes to §2f": it is one sentence for the whole
// table and it does not know which row died. This does, and it prints ONE call
// for all of them, because salvage.mjs takes every name at once and a
// per-agent line would be a per-agent turn.
export function deadAdvice(rows, sessionId = "<session-id>") {
  const dead = rows.filter((r) => r.status === "dead");
  if (dead.length === 0) return [];
  return [
    "# A dead reviewer is salvaged BEFORE it is re-spawned: its transcript may already hold the",
    "# report, and re-spawning one that finished pays for the same review twice (§2f).",
    `#   → "\${CLAUDE_PLUGIN_ROOT}/scripts/salvage.mjs" ${sessionId} ${dead.map((r) => r.name).join(" ")}`,
    "#   Re-spawn under a NEW name only for those that come back empty.",
  ];
}

export function stallAdvice(rows) {
  const stalled = rows.filter((r) => r.status === "stalled");
  if (stalled.length === 0) return [];
  return [
    "# A stalled reviewer is NOT a dead one: it stopped on an API error with its work and",
    "# its context intact, so it is resumed, never re-spawned from zero (§2f is for dead).",
    ...stalled.flatMap((r) => [
      `#   ${r.name}: ${(r.stall?.text ?? "an API error").split("\n")[0].slice(0, 100)}`,
      {
        quota: "#     → a quota refusal: a nudge now only spends another one. Resume after the reset above.",
        transient: `#     → resume it: SendMessage to "${r.name}" with "resume", then call wait.mjs again.`,
      }[r.stall?.kind] ??
        "#     → an API-error shape this plugin has not measured: READ the error above before acting. " +
        "Resume only if it is transient; if it is a limit, waiting is the only thing that works.",
    ]),
  ];
}

const count = (rows, status) => rows.filter((r) => r.status === status).length;

const USAGE = "usage: wait.mjs --work <dir> --round N [--session <id>] [name…]";

export async function main(argv, {
  log = (line) => process.stdout.write(`${line}\n`),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logDir = LOG_DIR,
} = {}) {
  if (argv.some((a) => a === "--help" || a === "-h")) {
    log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  if (!options.work) throw usage("--work is required");
  const round = Number(options.round);
  if (!Number.isInteger(round) || round < 1) throw usage("--round needs a positive integer");

  const workDir = path.resolve(options.work);
  const roundDir = path.join(workDir, `round-${round}`);
  const briefsDir = path.join(roundDir, "briefs");
  const names = options.names.length > 0
    ? options.names
    : (existsSync(briefsDir)
      ? readdirSync(briefsDir).filter((f) => f.endsWith(".md")).map((f) => path.basename(f, ".md")).sort()
      : []);
  if (names.length === 0) throw usage(`no names given and no briefs under ${briefsDir}`);

  // Claude Code exports the running session's id to every Bash call, and that
  // session's subagents/ directory is where the reviewers are — also when the
  // caller is itself a subagent (nested agents land flat in the lead's
  // directory) or a `claude -p` child (it gets its own id). The scratchpad path
  // is only the fallback: a subagent or child is handed a scratchpad that can
  // name another session, which is how a subagent's loop once found no
  // transcripts (measured on 2.1.301, docs/design-notes/subagent-mode-plan.md).
  const sessionId = options.session ?? (process.env.CLAUDE_CODE_SESSION_ID || null) ?? sessionIdFrom(workDir);
  if (!sessionId) throw usage("could not read a session id from --work or CLAUDE_CODE_SESSION_ID; pass --session <id>");
  const dir = resolveSubagentsDir(sessionId);
  if (!existsSync(dir)) {
    throw Object.assign(
      new Error(`no subagent transcripts under ${dir} — the harness is not writing them where this expects. ` +
        "Wait by ending the turn with a one-line status until that is fixed (SKILL.md §2b)."),
      { exitCode: 2 });
  }

  const config = loadConfig(gitRoot()).wait;
  // A reviewer re-spawned into the same round reuses its name; the scope
  // bundle's mtime is when the round began, so anything older is a previous
  // attempt's agent and not this round's.
  const since = mtimeOr(path.join(roundDir, "scope.diff"), 0);

  // One wait per set of names: the finders' wait, then the verifier's, then the
  // applier's, each with its own start and its own budget, all in round-N/.
  const waitFile = path.join(roundDir, "wait.json");
  let state = null;
  try { state = JSON.parse(readFileSync(waitFile, "utf8")); } catch { /* first call this round, or a truncated file */ }
  if (!state || !Array.isArray(state.names) || state.names.join(" ") !== names.join(" ")) {
    state = { startedAt: new Date(now()).toISOString(), names, calls: 0 };
  }
  state.calls += 1;
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(waitFile, `${JSON.stringify(state, null, 2)}\n`);
  // Exit 3 is terminal: the round's waiting is over and §2f decides what the
  // still-active reviewers are. A second call for the same names is therefore
  // a loop, not a wait, and it is cheap enough to be one — so it refuses. The
  // refusal is recorded first: a call that is not counted is a call the next
  // reader cannot see was made.
  if (state.spent) {
    throw Object.assign(
      new Error(`the round-${round} wait budget for these agents was already spent — treat the ones still active as dead (SKILL.md §2f) rather than waiting again`),
      { exitCode: 2 });
  }
  const waitStartMs = Date.parse(state.startedAt);
  const budgetEndsMs = waitStartMs + config.budgetMinutes * 60_000;
  // The budget reads `awake()`, wall time minus the time the host slept during
  // this wait. Staleness reads the wall clock less only the sleep after each
  // agent's last write, because transcript mtimes are wall-clock: subtracting
  // all of it understated the quiet of an agent silent since the wake. The call
  // ceiling, which guards the Bash tool's own timeout, reads the wall clock.
  let slept = Number(state.sleptMs) || 0;
  const sleeps = Array.isArray(state.sleeps) ? state.sleeps : [];
  const awake = () => now() - slept;
  const budgetLeft = () => `${Math.max(0, Math.round((budgetEndsMs - awake()) / 60_000))}m of budget left`;

  const callStartMs = now();
  const callEndsMs = callStartMs + config.callSeconds * 1000;
  log(`# wait round ${round} · ${names.length} agent${names.length === 1 ? "" : "s"} · call ${state.calls} · ${budgetLeft()}`);

  const read = makeReader();
  const snapshot = () => poll({ names, dir, since, roundDir, now: now(), config, waitStartMs, read, sleeps });
  // A missing state directory is the normal case in a round where nobody has
  // filed yet, so it reads as "no orphans" rather than as an error.
  const stateDir = path.join(roundDir, "state");
  const orphans = () => {
    let files = [];
    try { files = readdirSync(stateDir); } catch { return []; }
    return orphanAdvice(rows, stateDir, files, plannedNames(roundDir, reviewNumber(workDir)));
  };
  const sleptNote = () => slept > 0
    ? [`# the host was asleep for ${Math.max(1, Math.round(slept / 60_000))}m of this wait — not counted toward the stale limit or the budget`]
    : [];
  let rows = snapshot();
  // The table is worth printing even when the tool timeout, not this script,
  // ends the call — otherwise a wait that ran too long tells the lead nothing.
  const onSignal = () => {
    log(render(rows, `# interrupted — ${count(rows, "finished")} finished, ${count(rows, "stalled")} stalled, ${count(rows, "dead")} dead, ${count(rows, "active")} active`, [...sleptNote(), ...orphans()], sessionId));
    process.exit(1);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let exitCode = 0;
  let lastPollMs = callStartMs;
  let missingSinceMs = null;
  try {
    for (;;) {
      const at = now();
      if (at - lastPollMs > SLEEP_GAP_MS) {
        // Recorded at once: a call the Bash timeout kills on wake must not
        // hand the next call a clock with the sleep back in it.
        slept += at - lastPollMs - POLL_MS;
        sleeps.push({ from: lastPollMs, to: at - POLL_MS });
        state.sleptMs = slept;
        state.sleeps = sleeps;
        writeFileSync(waitFile, `${JSON.stringify(state, null, 2)}\n`);
      }
      lastPollMs = at;
      rows = snapshot();
      const missing = missingWhileSettled(rows);
      missingSinceMs = missing.length ? (missingSinceMs ?? awake()) : null;
      if (missing.length && awake() - missingSinceMs >= NO_TRANSCRIPT_GRACE_MS) {
        const others = unclaimedNames(dir, since, rows);
        rows = rows.map((r) => {
          if (!missing.includes(r)) return r;
          const near = nearMatches(r.name, others);
          return { ...r, status: "unknown", note: near.length ? `no transcript — did you mean ${near.join(" or ")}?` : "no transcript under this or any similar name this round" };
        });
        exitCode = 2;
        break;
      }
      if (count(rows, "active") === 0) { exitCode = 0; break; }
      if (awake() >= budgetEndsMs) { exitCode = 3; break; }
      if (at >= callEndsMs && at - callStartMs >= MIN_CALL_MS) { exitCode = 1; break; }
      await sleep(POLL_MS);
    }

    // The wait's final state, and one numbers-only row of it in the durable
    // log: wait.json goes with the scratchpad, and how long a round's
    // reviewers took is a fact the metrics need after it has gone.
    if (exitCode !== 1) {
      if (exitCode === 3) state.spent = true;
      state.ended = ENDED[exitCode];
      state.waitedMs = Math.max(0, Math.round(awake() - waitStartMs));
      writeFileSync(waitFile, `${JSON.stringify(state, null, 2)}\n`);
      logReviewRow("wait", {
        round, ended: state.ended, calls: state.calls, waitedMs: state.waitedMs, sleptMs: slept,
        roles: tally(names.map(roleOf)), statuses: tally(rows.map((r) => r.status)),
      }, { work: workDir, script: "wait.mjs", logDir });
    }

    const active = count(rows, "active");
    const verdict = {
      0: `# settled — ${count(rows, "finished")} finished, ${count(rows, "stalled")} stalled, ${count(rows, "dead")} dead. Collect the finished reports (§2c); a dead one goes to §2f.`,
      1: `# ${active} still active, ${budgetLeft()} — call wait.mjs again as the very next tool call.`,
      2: `# ${count(rows, "unknown")} name${count(rows, "unknown") === 1 ? " has" : "s have"} no transcript while every other reviewer settled — a wrong name, not a slow agent. ` +
        "Call wait.mjs again with the name the Agent launch result shows.",
      3: `# budget spent after ${config.budgetMinutes}m — treat the ${active} still active as dead (§2f).`,
    }[exitCode];
    log(render(rows, verdict, [...sleptNote(), ...orphans()], sessionId));
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  return exitCode;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`wait.mjs: ${error.message}\n`);
    // Never 1: exit 1 means "still active, call again", and a crash answered
    // that way is a retry loop. An unexpected failure is a wait that cannot run.
    process.exit(error.exitCode ?? 2);
  });
}
