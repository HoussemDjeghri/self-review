#!/usr/bin/env node
// self-review brief generator — one finder brief per row of the round's plan.
//
// Usage:
//   brief.mjs --round N (--plan round-N/tier.json | --tier S|M|L)
//             --intent intent.md --scope round-N/scope.diff --out round-N/briefs/
//             [--impact round-N/impact.md] [--prior prior.md] [--ledger ledger.md]
//             [--angles <file>] [--live <dir>] [--cold <transcript.md>]
//
// A brief is the whole world of the agent that receives it, so this script
// assembles it from the pieces the round already produced: the verbatim angle
// text from the catalogue, the intent block, the scope pointer, the impact
// block at the row's requested depth, prior findings, the dismissed ledger, a
// per-finder state file, and the call budget. Doing it by hand costs 4-6
// main-session calls per round and gets a section wrong sooner or later.
//
// `--plan` is the deterministic path (tier.mjs writes tier.json). `--tier`
// builds that tier's default plan without it — the pre-tier.mjs path, and the
// fallback when tier.mjs fails.
//
// Every brief is held to the token budget (config `brief.maxTokens`, estimated
// as bytes/3.5): impact rows are trimmed first (lowest-ranked last-listed
// first, broken references never), then prior findings. Angle text and the
// dismissed ledger are never cut — a brief that cannot fit them says so in its
// header and ships anyway, because a finder briefed without its angle is worse
// than an expensive one.
//
// Exit 0; 2 usage; 3 an input file is missing or unreadable.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOG_DIR, PLUGIN_ROOT, isMain, loadConfig } from "../hooks/lib/config.mjs";
import { gitRoot } from "./lib/repo.mjs";

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 3.5);

// Markdown section boundary, shared by the three readers below: the angle
// catalogue, the ledger and the impact block are all "read until the next
// heading" formats, and they must agree on what a heading is.
const isHeading = (line) => /^#{1,3} +\S/.test(line);
// impact.md opens with a single-`#` freshness note *above* its first section,
// so section-picking uses the stricter form — the loose one swallowed the whole
// header, and with it the counts every docs brief is supposed to carry.
const isSection = (line) => /^#{2,3} +\S/.test(line);

// --- the angle catalogue ---------------------------------------------------
// Angles are pasted verbatim: the catalogue is the tuned text, and a brief that
// paraphrases it is a different review.
export function angleSections(markdown) {
  const angles = new Map();
  const lines = markdown.split("\n");
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^#{2,3} +([A-Z][0-9]?) +· +(.*)$/);
    const compact = /^#{2,3} +Compact all-angles brief/.test(line);
    if (heading || compact) {
      const id = heading ? heading[1] : "compact";
      const title = heading ? `${heading[1]} · ${heading[2]}` : "Every angle at once (compact review)";
      current = { id, title, body: [] };
      angles.set(id, current);
      continue;
    }
    if (!current) continue;
    if (isHeading(line) || line.trim() === "---") { current = null; continue; }
    current.body.push(line);
  }
  for (const angle of angles.values()) angle.body = angle.body.join("\n").trim();
  return angles;
}

// --- the fallback plan -----------------------------------------------------
// DESIGN §4.5's round-1 groups for code, plus its round-2/3 merges. Without
// tier.json there are no kinds and no risk markers, so this builds the code
// plan and keeps L's conditional G/H rows: at tier L, missing a security or
// concurrency finder costs more than spending one.
const ROUND_1 = {
  S: [{ angles: ["compact"], impact: "full" }],
  M: [
    { angles: ["A", "B", "D"], impact: "summary" },
    { angles: ["C", "E", "F"], impact: "full" },
    { angles: ["Q", "V"], impact: "summary" },
  ],
  L: [
    { angles: ["A", "B"], impact: "summary" },
    { angles: ["C", "D"], impact: "full" },
    { angles: ["E", "F"], impact: "full" },
    { angles: ["Q", "V"], impact: "summary" },
    { angles: ["G"], impact: "full", model: "opus" },
    { angles: ["H"], impact: "full", model: "opus" },
  ],
};
const ROUND_2 = [
  { angles: ["A", "B", "D", "Q", "V"], impact: "summary" },
  { angles: ["C", "E", "F", "G", "H"], impact: "full" },
];

export function buildPlan(tier, round, config = {}) {
  const calls = config.callsCode ?? 40;
  const rows = round >= 3 ? ROUND_1.S : round === 2 ? ROUND_2 : ROUND_1[tier];
  if (!rows) throw new Error(`unknown tier ${tier}`);
  return {
    schema: 1,
    tier,
    round,
    source: "default plan",
    verifier: tier === "L" ? "agent" : "author",
    finders: rows.map((row) => {
      // The name leads with the agent type, and that is containment rather than
      // convention: the harness puts a named agent's NAME into the `agent_type`
      // its PreToolUse hooks see, so `tree-guard` matches this string and never
      // the registered type. `tier.mjs` does the same for the same reason —
      // these are two generators feeding one guard, and this one is the
      // fallback the skill reaches for when the other is broken, which is
      // exactly when an unguarded reviewer would go unnoticed. F10h.
      const agent = "self-review-finder";
      return {
        name: `${agent}-r${round}-${row.angles.join("").toLowerCase()}`,
        kind: "code",
        angles: row.angles,
        agent,
        model: row.model ?? "sonnet",
        effort: "high",
        calls,
        impact: row.impact,
      };
    }),
  };
}

// --- inputs ----------------------------------------------------------------
const read = (file, what) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const problem = new Error(`cannot read ${what} (${file}): ${error.message}`);
    problem.exitCode = 3;
    throw problem;
  }
};

// Only the dismissed section travels: "fixed" would tell the next round what
// not to look at, which is exactly the bias a fresh reviewer is there to avoid.
export function dismissedFrom(ledgerText) {
  if (!ledgerText) return [];
  const lines = ledgerText.split("\n");
  const start = lines.findIndex((line) => /^#{1,3} +dismissed\b/i.test(line));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trimEnd()).filter(Boolean);
}

// Impact at the depth the row asked for. `summary` is the file's own two-line
// header (§4.3 writes the counts there); `docs` keeps the sections a prose
// reviewer can act on; `full` is the file, capped.
export const IMPACT_DEPTHS = new Set(["full", "docs", "summary"]);

export function impactLines(impactText, depth, { impactMaxLines }) {
  if (!impactText) return { lines: [], protectedFlags: [] };
  const all = impactText.split("\n").map((l) => l.trimEnd());
  if (depth === "summary") {
    const head = all.filter(Boolean).slice(0, 2);
    return { lines: head, protectedFlags: head.map(() => true) };
  }

  let candidates = all;
  if (depth === "docs") {
    candidates = [];
    let inWanted = true; // the header lines before the first section
    for (const line of all) {
      if (isSection(line)) inWanted = /broken reference|docs and config/i.test(line);
      if (inWanted) candidates.push(line);
    }
  }
  // Protection is per line, not a prefix: broken references are the section the
  // whole impact script exists for and are never trimmed, wherever they sit in
  // the file, while the caller rows above them stay droppable.
  let broken = false;
  const isProtected = candidates.map((line, index) => {
    if (isHeading(line)) broken = /broken reference/i.test(line);
    return broken || isHeading(line) || index < 2;
  });
  // The cap is applied after protection, never before it: a rename that breaks
  // more references than the cap allows must still show every broken one — that
  // section is the reason impact.mjs exists.
  const cap = depth === "docs" ? Math.ceil(impactMaxLines / 2) : impactMaxLines;
  const lines = [], protectedFlags = [];
  candidates.forEach((line, index) => {
    if (!isProtected[index] && lines.length >= cap) return;
    lines.push(line);
    protectedFlags.push(isProtected[index]);
  });
  return { lines, protectedFlags };
}

// --- rendering -------------------------------------------------------------
function renderSections({ row, index, total, round, intent, scope, live, angles, impact, prior, dismissed, stateFile, cold }) {
  // Angle X's own reviewer has no shell (see agents/self-review-cold-grader.md),
  // so its lifeboat is written rather than appended with Bash.
  //
  // Asked of the agent the plan actually assigned, not re-derived from the
  // angle shape. tier.mjs owns that derivation; a second copy here agreed only
  // because tests pin X to being planned alone, and the whole rest of this
  // feature exists because two halves of it once disagreed about what an entry
  // point is. If the two ever diverged, this brief would hand a shell-less
  // reviewer instructions to append with Bash.
  const grading = row.agent === "self-review-cold-grader";
  // The transcript goes to any reviewer whose angles cover the cold run — which
  // includes the compact all-angles row, whose reviewer DOES have a shell. That
  // is why the section below tells it the run already happened rather than
  // telling it what it does or does not have: a compact reviewer reading "you
  // have no shell" would be reading something false.
  const coldSection = row.angles.some((id) => id === "X" || id === "compact");
  const angleText = row.angles
    .map((id) => {
      const angle = angles.get(id);
      if (!angle) throw Object.assign(new Error(`no angle "${id}" in the catalogue`), { exitCode: 3 });
      return `${angle.title}\n${angle.body}`;
    })
    .join("\n\n");
  return {
    head: `You are reviewer ${index + 1} of ${total} in round ${round} of a self-review.\n`,
    intent: `${intent.trim()}\n`,
    scope:
      `SCOPE\nRead ${scope} first — changed-file list, diff, and new files rendered as\n` +
      `additions. The live files are at ${live}; read enclosing code and sections\n` +
      `there. Scratch and generated files are not in scope.\n`,
    angle: `YOUR ANGLE\n${angleText}\n`,
    cold: coldSection
      ? cold
        ? `THE COLD RUN (already performed — do not run the artifact yourself)\n${cold}\n` +
          `The artifact was copied out of the repository, reached through a symlink under a\n` +
          `path containing a space, and invoked inside a sandbox that denies the network,\n` +
          `confines writes, and denies reads outside itself. Grade that transcript. Read its\n` +
          `header first: it names the containment tier, and "uncontained" means nothing ran\n` +
          `and the entry points are UNVERIFIED, not verified-clean.\n\n` +
          `Running it yourself instead would be uncontained — a documented \`deploy\` or\n` +
          `\`migrate\` reaches the real network with your real credentials, and deciding which\n` +
          `invocation is safe means trusting the code this review exists to doubt. If you\n` +
          `believe another invocation is needed, that is a FINDING naming the argv.\n`
        : `THE COLD RUN\nNo transcript was produced for this round — \`scripts/coldrun.sh\` did not run or\n` +
          `failed. Say so as a \`minor\` candidate: the cold run could not be exercised, which\n` +
          `is not the same as the artifact being fine. Do not run the artifact yourself to\n` +
          `make up for it — uncontained execution is what this section replaced.\n`
      : "",
    impact: impact.length ? `IMPACT (line numbers as of generation — re-read before asserting)\n${impact.join("\n")}\n` : "",
    prior: prior.length
      ? `PRIOR FINDINGS IN THIS REPO (context, not a checklist)\n${prior.join("\n")}\n` +
        `If one of these lines is the defect you are filing, put the eight characters its\n` +
        `brackets hold in your finding's \`prior_id\` — "prior_id": "1a2b3c4d". A wrong id\n` +
        `is worse than none.\n`
      : "",
    dismissed:
      `ALREADY DISMISSED (do not re-report without new evidence)\n` +
      `${dismissed.length ? dismissed.join("\n") : "none"}\n`,
    state: grading
      ? `STATE FILE (crash insurance)\n${stateFile} — each time a candidate firms up, Write\n` +
        `the candidates you have so far there, one JSON object per line. If your session\n` +
        `dies, this file is what survives.\n`
      : `STATE FILE (crash insurance)\n${stateFile} — append each candidate there as one\n` +
        `JSON line the moment it firms up, batched into the same Bash call as your next\n` +
        `read. If your session dies, this file is what survives.\n`,
    output:
      `CALL BUDGET\n${row.calls} tool calls. Spend them on reading the enclosing code and proving\n` +
      `findings, not on breadth for its own sake.\n\n` +
      `OUTPUT\nThe JSON array described in your instructions. Up to 6 candidates, most severe\n` +
      "first, `[]` if nothing qualifies. Nothing after the JSON.\n",
  };
}

const assemble = (notes, sections) =>
  [...notes.map((n) => `# ${n}`), ...Object.values(sections).filter(Boolean)].join("\n").replace(/\n{3,}/g, "\n\n");

export function renderBrief(args) {
  const { maxTokens } = args.budget;
  const impact = args.impact.lines.map((text, index) => ({ text, keep: args.impact.protectedFlags?.[index] ?? false }));
  let prior = [...args.prior];
  let trimmedImpact = 0, trimmedPrior = 0;
  // The trim notes are part of the brief, so they are inside the measurement:
  // a budget check that ignores its own header is a budget check that lies.
  const notes = () => {
    if (!trimmedImpact && !trimmedPrior) return [];
    const parts = [];
    if (trimmedImpact) parts.push(`${trimmedImpact} impact row${trimmedImpact === 1 ? "" : "s"}`);
    if (trimmedPrior) parts.push(`${trimmedPrior} prior line${trimmedPrior === 1 ? "" : "s"}`);
    return [`trimmed to fit ${maxTokens} tokens: ${parts.join(", ")}`];
  };
  const build = () => {
    const text = assemble(notes(), renderSections({ ...args, impact: impact.map((row) => row.text), prior }));
    return { text, tokens: estimateTokens(text) };
  };
  // Lowest-ranked first: impact.mjs ranks descending, so the droppable row
  // nearest the end is the cheapest one to lose.
  const dropLowestRanked = () => {
    for (let index = impact.length - 1; index >= 0; index -= 1) {
      if (!impact[index].keep) { impact.splice(index, 1); return true; }
    }
    return false;
  };

  let { text, tokens } = build();
  while (tokens > maxTokens && dropLowestRanked()) {
    trimmedImpact += 1;
    ({ text, tokens } = build());
  }
  while (tokens > maxTokens && prior.length) {
    prior.pop();
    trimmedPrior += 1;
    ({ text, tokens } = build());
  }
  if (tokens > maxTokens) {
    // Nothing left that may be cut: the angle text and the ledger stay whole,
    // and the brief says why it is over rather than shipping a silent overrun.
    const over = args.dismissed.length
      ? `over budget: ledger ${args.dismissed.length} lines`
      : `over budget: ${tokens} tokens, nothing left to trim`;
    text = assemble([...notes(), over], renderSections({ ...args, impact: impact.map((row) => row.text), prior }));
    tokens = estimateTokens(text);
  }
  // The prior lines this brief actually carries, after the trim: what a finder
  // was shown is a fact only the render knows, and the eval's `badCite` metric
  // is a guess without it (DESIGN §4.4).
  return { text, tokens, trimmedImpact, trimmedPrior, priorShown: [...prior] };
}

// The ids in rendered `prior.md` lines (`[83de6191] file:line · … · verdict`).
const PRIOR_LINE_ID = /\[([0-9a-f]{8})\]/;
export const priorIdsIn = (lines) => [...new Set(lines.map((line) => PRIOR_LINE_ID.exec(line)?.[1]).filter(Boolean))];

/**
 * Log which prior ids this round put in front of a finder — the union across
 * the round's briefs, because a taper can hand two finders different ones.
 *
 * **An empty round writes an empty row.** It used to write nothing, and that
 * silence was indistinguishable from a build too old to log at all — so every
 * reader of this row (`shownReader` in the eval, and anything scoring a cite
 * against it) had to treat a cold review as unmeasured, and the guard that
 * catches an unverifiable citation stayed off in exactly the arm that has no
 * ids to cite. `shown: []` is the fact, not the absence of one, and it is the
 * fact a person reading the log wants too: this round showed no prior.
 *
 * Best effort, like every other write to this file: a round must not fail
 * because its bookkeeping could not be written.
 */
export function logPriorShown(shown, { round, cwd = process.cwd(), logDir = LOG_DIR, now = () => new Date().toISOString() }) {
  const row = { ts: now(), kind: "prior-shown", cwd, round, shown };
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, "log.jsonl"), `${JSON.stringify(row)}\n`);
    return row;
  } catch (error) {
    process.stderr.write(`brief.mjs: could not log the prior ids shown: ${error.message}\n`);
    return null;
  }
}

export function writeBriefs({ plan, outDir, stateDir, angles, intent, scope, live, impactText, prior, dismissed, config, cold }) {
  // The whole plan is checked before the first file exists: a bad row must not
  // leave the earlier rows' briefs behind as a half-written round.
  const reject = (message) => { throw Object.assign(new Error(message), { exitCode: 3 }); };
  const seen = new Set();
  for (const row of plan.finders) {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(row.name ?? "")) {
      reject(`finder name ${JSON.stringify(row.name)} is not a plain file name`);
    }
    // The name is the file name, so a repeat would silently overwrite an earlier
    // finder's brief and dispatch that finder with someone else's angles.
    if (seen.has(row.name)) reject(`finder name ${JSON.stringify(row.name)} is used more than once`);
    seen.add(row.name);
    if (!Array.isArray(row.angles) || row.angles.length === 0) reject(`finder ${row.name} has no angles[]`);
    for (const id of row.angles) if (!angles.has(id)) reject(`finder ${row.name}: no angle "${id}" in the catalogue`);
    // The budget is rendered into the brief verbatim, so a missing one would
    // instruct a live finder to spend "undefined tool calls".
    if (!Number.isInteger(row.calls) || row.calls < 1) {
      reject(`finder ${row.name}: calls must be a positive integer, not ${JSON.stringify(row.calls)}`);
    }
    if (row.impact !== undefined && !IMPACT_DEPTHS.has(row.impact)) {
      reject(`finder ${row.name}: impact must be one of ${[...IMPACT_DEPTHS].join(", ")}, not ${JSON.stringify(row.impact)}`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const total = plan.finders.length;
  return plan.finders.map((row, index) => {
    const file = path.join(outDir, `${row.name}.md`);
    const stateFile = path.join(stateDir, `${row.name}.jsonl`);
    const brief = renderBrief({
      row, index, total,
      round: plan.round ?? 1,
      intent, scope, live, angles, stateFile, dismissed, cold,
      impact: impactLines(impactText, row.impact, config),
      prior: prior.slice(0, config.priorMaxLines),
      budget: config,
    });
    writeFileSync(file, brief.text);
    return { row, file, ...brief };
  });
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const options = {};
  const flags = ["round", "plan", "tier", "intent", "scope", "impact", "prior", "ledger", "out", "angles", "live", "cold"];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s) : [null, null];
    if (!name || !flags.includes(name)) throw Object.assign(new Error(`unknown argument ${arg}`), { exitCode: 2 });
    const value = inline ?? argv[++i];
    if (value === undefined) throw Object.assign(new Error(`--${name} needs a value`), { exitCode: 2 });
    options[name] = value;
  }
  return options;
}

export function main(argv, { log = console.log } = {}) {
  const options = parseArgs(argv);
  const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });
  if (!options.plan && !options.tier) throw usage("pass --plan round-N/tier.json or --tier S|M|L");
  if (options.plan && options.tier) throw usage("--plan and --tier are alternatives; pass one");
  for (const required of ["intent", "scope", "out"]) {
    if (!options[required]) throw usage(`--${required} is required`);
  }
  const positiveInteger = (value) => Number.isInteger(value) && value >= 1;
  const round = Number(options.round ?? 1);
  if (!positiveInteger(round)) throw usage("--round needs a positive integer");

  const config = loadConfig(gitRoot()).brief;
  const plan = options.plan
    ? JSON.parse(read(path.resolve(options.plan), "the plan"))
    : buildPlan(options.tier.toUpperCase(), round);
  if (!Array.isArray(plan.finders) || plan.finders.length === 0) {
    throw Object.assign(new Error(`the plan has no finders[]`), { exitCode: 3 });
  }
  plan.round = plan.round ?? round;
  if (!positiveInteger(plan.round)) {
    throw Object.assign(new Error(`the plan's round (${plan.round}) is not a positive integer`), { exitCode: 3 });
  }

  const anglesFile = options.angles
    ? path.resolve(options.angles)
    : path.join(PLUGIN_ROOT, "skills", "self-review", "references", "angles.md");
  const outDir = path.resolve(options.out);
  const ledgerPath = options.ledger ? path.resolve(options.ledger) : "the ledger";
  const dismissed = dismissedFrom(options.ledger ? read(ledgerPath, "the ledger") : "");
  const dismissedCount = dismissed.length;
  const results = writeBriefs({
    plan,
    outDir,
    stateDir: path.join(path.dirname(outDir), "state"),
    angles: angleSections(read(anglesFile, "the angle catalogue")),
    intent: read(path.resolve(options.intent), "the intent block"),
    scope: path.resolve(options.scope),
    live: options.live ? path.resolve(options.live) : gitRoot(),
    impactText: options.impact ? read(path.resolve(options.impact), "the impact block") : "",
    prior: options.prior ? read(path.resolve(options.prior), "prior findings").split("\n").filter(Boolean) : [],
    dismissed,
    // A path, not the file: the transcript holds every byte the artifact wrote
    // and belongs in the grader's context once, when it reads it — not in
    // every brief, and not in this script's caller's context at all.
    cold: options.cold ? path.resolve(options.cold) : "",
    config,
  });

  logPriorShown(priorIdsIn(results.flatMap((result) => result.priorShown)), { round: plan.round });


  // The Agent-call table: everything the spawn needs, nothing else. Kept to
  // one line per finder because this output lands in the main session's
  // context, where every line is paid for on every later turn.
  log(`# ${results.length} brief${results.length === 1 ? "" : "s"} for round ${plan.round}, tier ${plan.tier} (${plan.source ?? "plan"}) — verifier: ${plan.verifier ?? "author"}`);
  for (const { row, file, tokens, trimmedImpact } of results) {
    log(`${row.name}  ${row.agent}  ${row.model}/${row.effort}  ${row.calls} calls  ${file}  (${tokens} tok${trimmedImpact ? `, -${trimmedImpact} impact` : ""})`);
  }
  // What the briefs carry from the ledger, said out loud. An empty dismissed
  // list reads identically whether nothing was dismissed or the lead never
  // wrote `<work>/ledger.md` — `round.sh` seeds it with a placeholder, so the
  // forgotten case is silent and every later round re-files what round 1
  // already refuted. It happened across rounds 2-4 of the v0.7.2 review, and
  // the workaround was pasting the list into the agent prompts by hand.
  log(dismissedCount === 0 && plan.round > 1
    ? "# no dismissed findings carried into this round — if round " +
      `${plan.round - 1} dismissed anything, ${ledgerPath} was never updated (SKILL §2e) and these finders will re-file it`
    : `# ${dismissedCount} dismissed finding${dismissedCount === 1 ? "" : "s"} carried into every brief`);
  return results;
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`brief.mjs: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
