/**
 * The convergence marker's grammar, in one place.
 *
 * Three consumers have to agree on what a marker says: `converged.sh` writes
 * one, the Stop gate accepts or refuses one, and `audit.mjs` counts them. They
 * used to agree by convention — the summary was a free string that everyone
 * hand-typed as `key=value` — and 112 real markers say convention lost. 14 were
 * prose with no counts at all, nine carried tokens that are not numbers
 * (`rounds=2of3`, `dismissed=1(rebutted,`), and 29 — a quarter of every marker
 * ever written — claimed a converged review with `rounds=0`, which is not a
 * review that ran but the escape hatch wearing its clothes.
 *
 * So the model no longer encodes the record: it names fields, and `format`
 * writes the string. Every summary this module emits parses, by construction.
 *
 * It lives beside the hooks rather than beside `converged.sh` because the Stop
 * gate is the one consumer that must never die: an ESM resolution failure
 * happens before any try/catch a hook could install, so a grammar imported
 * across `hooks/ -> scripts/` would turn a partial install into a broken
 * session. `hooks/lib` is the tree that has to stand alone; a CLI under
 * `scripts/` failing on the same partial install is an error message, not a
 * session.
 *
 * THE RECORD
 *   outcome   converged | not-converged | not-applicable        (always)
 *   rounds/fixed/dismissed/open   non-negative integers
 *                                 required for the first two outcomes,
 *                                 REFUSED for not-applicable — there were no
 *                                 rounds, and `rounds=0` is what made the
 *                                 hatch invisible in the first place
 *   reason    no-code-changed | user-declined | scratch-only | other
 *                                 required for not-applicable, refused otherwise
 *   note      free text; the only free text there is, mandatory for `other`
 *   tier           optional, S | M | L
 *   forced/computed optional, S | M | L, written together when the loop took a
 *                   tier other than the one the rules chose
 *   adapter        optional, open vocabulary — the loop names its scope adapter
 *   intent    validated | author | skipped                      (always, for
 *             the two counted outcomes) — who read the intent before the code
 *             was written. `validated` means a fresh ticket-validator did, and
 *             the Stop gate refuses that word unless one COMPLETED before this
 *             turn's first code edit. The other two are honest claims about the
 *             author's own account and are never gated. It is required rather
 *             than optional because an absent field and "nobody read it" are
 *             the same state wearing different clothes, and the report line
 *             this feeds has to be true on every review, not on the ones that
 *             remembered.
 *
 * `note` is deliberately NOT part of the formatted summary. Free text inside a
 * key=value string is how prose got in; it travels as its own field instead, so
 * the summary stays parseable no matter what a human writes in it.
 */

export const OUTCOMES = ["converged", "not-converged", "not-applicable"];
export const NA_REASONS = ["no-code-changed", "user-declined", "scratch-only", "other"];
export const COUNTS = ["rounds", "fixed", "dismissed", "open"];
export const TIERS = ["S", "M", "L"];
// `forced`/`computed` are here because SKILL.md tells the loop to record an
// override, and audit.mjs reads both; without them the CLI refused the whole
// marker as an unknown flag and the file form dropped them silently.
export const LABELS = ["tier", "adapter", "forced", "computed", "intent"];
const TIER_LABELS = new Set(["tier", "forced", "computed"]);
// Who read the intent before the code existed. `validated` is the only one the
// Stop gate can check, and it checks ordering — a validator completion before
// the first edit — never the verdict: grading the ticket would be the stamp
// this field exists to avoid being.
export const INTENT_STATES = ["validated", "author", "skipped"];

export const isCounted = (outcome) => outcome === "converged" || outcome === "not-converged";
const list = (values) => values.join(" | ");

/**
 * Flags to a field bag — the CLI's half of the grammar, here rather than in
 * `scripts/marker.mjs` because `audit.mjs` has to read a marker command back
 * out of a transcript, and a second parser for the same flags is how the three
 * consumers drift. Unknown flags and bare words are refused, not ignored: a
 * summary typed the old way must fail loudly in the same turn rather than reach
 * the gate and cost a Stop cycle to reject.
 */
export function fieldsFromFlags(argv) {
  const fields = {};
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (name) => {
      const value = argv[++i];
      if (value === undefined) { problems.push(`${arg} needs a value.`); return; }
      // A value that looks like a flag is refused rather than swallowed:
      // `--rounds --fixed 3` must not quietly eat the next flag. For every
      // field but one that IS the whole story, because the vocabularies are
      // closed. `note` is the free-text field, so its value legitimately might
      // start with `--` — there the message says a value was given, and names
      // the form that has no such constraint.
      if (value.startsWith("--")) {
        problems.push(name === "note"
          ? `--note was given "${value}", which looks like another flag — if that really is the value, write the record to CONVERGED.json instead.`
          : `${arg} needs a value.`);
        return;
      }
      fields[name] = value;
    };
    if (arg === "--converged" || arg === "--not-converged") fields.outcome = arg.slice(2);
    else if (arg === "--not-applicable") { fields.outcome = "not-applicable"; take("reason"); }
    else if (arg === "--outcome") take("outcome");
    else if (arg === "--note") take("note");
    else if (arg.startsWith("--") && [...COUNTS, ...LABELS, "reason"].includes(arg.slice(2))) take(arg.slice(2));
    else if (arg.startsWith("--")) problems.push(`unknown flag: ${arg}`);
    else problems.push(`unexpected argument: "${arg}" — the summary is built from flags now, not typed as a string.`);
  }
  return { fields, problems };
}

/**
 * Validate a field bag into a record. Returns `{ record, problems }`; `record`
 * is null when `problems` is non-empty. Every problem is a whole sentence
 * naming the field and what it should be — the caller prints them all at once,
 * because three sequential single-defect rejections is the cost F3 measured.
 */
export function validateMarker(fields = {}) {
  const problems = [];
  const has = (key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== "";

  const outcome = fields.outcome;
  if (!has("outcome")) problems.push(`outcome is required (${list(OUTCOMES)}).`);
  else if (!OUTCOMES.includes(outcome)) problems.push(`outcome "${outcome}" is not one of ${list(OUTCOMES)}.`);

  const record = { outcome };

  // An unrecognised outcome must not hide the rest. Whether a field is REQUIRED
  // or REFUSED depends on the outcome, so those checks wait until it is known —
  // but a value that is present can always be judged on its own shape, and
  // saying so here is what keeps one rejection from becoming three.
  for (const key of COUNTS) {
    if (!has(key)) {
      if (isCounted(outcome)) problems.push(`${key} is required for outcome=${outcome} (a non-negative integer).`);
      continue;
    }
    // The counts are refused rather than defaulted to zero: a zero row reads as
    // a review that ran and found nothing, which is the exact misreading that
    // put 29 non-reviews into the converged column.
    if (outcome === "not-applicable") {
      problems.push(`${key} cannot be given with outcome=not-applicable — there were no rounds.`);
      continue;
    }
    const value = String(fields[key]);
    if (!/^\d+$/.test(value)) problems.push(`${key}="${value}" is not a non-negative integer.`);
    else record[key] = Number(value);
  }

  // `rounds=0` on a counted outcome is the hatch wearing a review's clothes —
  // 29 of the 112 real markers. A turn the loop does not fit says so by name.
  if (isCounted(outcome) && record.rounds === 0) {
    problems.push(`rounds=0 is not a review — a turn the loop did not fit is outcome=not-applicable (${list(NA_REASONS)}).`);
  }

  if (outcome === "not-applicable" && !has("reason")) {
    problems.push(`reason is required for outcome=not-applicable (${list(NA_REASONS)}).`);
  }
  if (has("reason")) {
    if (isCounted(outcome)) problems.push(`reason only applies to outcome=not-applicable.`);
    else if (!NA_REASONS.includes(fields.reason)) problems.push(`reason "${fields.reason}" is not one of ${list(NA_REASONS)}.`);
    else record.reason = fields.reason;
  }
  if (record.reason === "other" && !has("note")) problems.push(`note is required when reason=other — say what the case was.`);

  for (const key of LABELS) {
    if (!has(key)) continue;
    const value = String(fields[key]);
    // Labels are tokens in the summary string, so whitespace would split one
    // field into two and re-open the parse hole this module exists to close.
    if (/\s/.test(value)) problems.push(`${key}="${value}" cannot contain whitespace.`);
    // adapter is an open vocabulary — the loop names its own scope adapters —
    // but a tier outside S|M|L opens an audit bucket nothing else writes.
    else if (TIER_LABELS.has(key) && !TIERS.includes(value)) problems.push(`${key}="${value}" is not one of ${list(TIERS)}.`);
    else if (key === "intent" && !INTENT_STATES.includes(value)) problems.push(`intent="${value}" is not one of ${list(INTENT_STATES)}.`);
    else record[key] = value;
  }

  // Required on a counted outcome, for the reason in the header: optional here
  // would mean every review that forgot the flag reads the same as one nobody
  // groomed, and the report line would be true only when it was remembered.
  // `not-applicable` is exempt — there was no code to have an intent about.
  if (isCounted(outcome) && !has("intent")) {
    problems.push(`intent is required for outcome=${outcome} (${list(INTENT_STATES)}) — say who read the intent before the code was written.`);
  }

  // Half an override is unreadable: `forced` alone does not say what was
  // overridden, `computed` alone does not say it was.
  if (has("forced") !== has("computed")) {
    problems.push(`forced and computed are written together — one names the tier the rules chose, the other the tier you took.`);
  }

  if (has("note")) record.note = String(fields.note);

  const known = new Set(["outcome", "reason", "note", ...COUNTS, ...LABELS]);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) problems.push(`${key} is not a field of this record (${[...known].join(", ")}).`);
  }

  return problems.length ? { record: null, problems } : { record, problems: [] };
}

/** The canonical summary string: key=value tokens only, never free text. */
export function formatSummary(record) {
  const parts = [`outcome=${record.outcome}`];
  for (const key of COUNTS) if (record[key] !== undefined) parts.push(`${key}=${record[key]}`);
  if (record.reason !== undefined) parts.push(`reason=${record.reason}`);
  for (const key of LABELS) if (record[key] !== undefined) parts.push(`${key}=${record[key]}`);
  return parts.join(" ");
}
