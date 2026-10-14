// An append-only log split into one segment per UTC month, `YYYY-MM.jsonl`.
//
// Built for the gate's decision log (state-location ruling, section 2) and
// meant to be reused by `log.jsonl` when that one is rotated: a single growing
// file is what the gate reads in full at every file marker, and a month per file
// bounds both the read and the retention.
//
// Retention is a constant on purpose. It is not read from config or from the
// repository: a log dir can be redirected by a repo's settings `env`, and a
// retention that repo could set would be one more lever it holds.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export const RETENTION_MONTHS = 6;

const SEGMENT_RE = /^(\d{4})-(\d{2})\.jsonl$/;
const monthIndex = (year, month) => year * 12 + (month - 1);

export const segmentOf = (now) =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;

/**
 * Append one row to the current month's segment. The first write of a month —
 * the segment does not exist yet — first deletes every segment more than
 * RETENTION_MONTHS whole months older, so the prune costs one readdir a month.
 * A failed prune is ignored; a failed append throws, and whether that matters
 * is the caller's decision.
 */
export function appendMonthly(dir, row, { now = new Date() } = {}) {
  const file = path.join(dir, segmentOf(now));
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    prune(dir, monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1));
  }
  appendFileSync(file, JSON.stringify(row) + "\n");
}

function prune(dir, current) {
  try {
    for (const name of readdirSync(dir)) {
      const match = SEGMENT_RE.exec(name);
      if (match && current - monthIndex(Number(match[1]), Number(match[2])) > RETENTION_MONTHS) {
        rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch { /* retention is housekeeping: a failure here never costs the row */ }
}
