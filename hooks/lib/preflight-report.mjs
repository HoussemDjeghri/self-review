// Which pre-flight checks a review has no verdict on.
//
// The pre-flight budget (round.sh, ruled 2026-11-08) turned a check stopped at
// its cap from FAIL into `INFRA … did not finish`, and a check with no budget
// left into `SKIP … pre-flight budget spent`: neither is a verdict on the code.
// That took away a false red, and with it the one alarm a hang introduced by the
// change used to raise. So a review may not end `converged` while any check is
// in that state (ruled the same day): it clears only when a newer pre-flight
// report — one the script wrote, never a typed claim — gives the check a real
// verdict, or the review ends `--not-converged --reason checks-unverified`.
// A check the project skipped on purpose (`preflight.skip`) is not counted.
//
// The reports are every `preflight*.txt` in the work dir and its round dirs;
// for each check KIND — keyed on the kind alone, so a later run that detects a
// different command for it still decides — the NEWEST report giving it PASS, FAIL,
// FLAKY, did-not-finish or budget-SKIP decides. A could-not-start line (`INFRA …
// (exit 126 …)` or `(exit 127 …)`) changes nothing; a newer `(preflight.skip)`
// for a kind clears every earlier entry of that kind. Only the status block is
// read: parsing stops at the first `--- ` line, so quoted tails never count.
// Newest is by mtime, which is what "a later run" means here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// `INFRA <kind> <cmd>   (did not finish in Ns — …)` and
// `SKIP  <kind> <cmd>   (pre-flight budget spent — …)`, as preflight.sh prints
// them. A check that could not START (`INFRA … (exit 127 …)`) is not counted:
// it is a tool missing from the shell, which a longer run does not cure.
const LINE_RE = /^(PASS|FAIL|FLAKY|INFRA|SKIP) +(\S+) +(.*?)(?: {3}\((.*)\))?$/;
const UNVERIFIED_RE = /^(did not finish in \d+s|pre-flight budget spent)\b/;

/** A pre-flight report's file name; the gate's tampering check uses the same one. */
export const PREFLIGHT_REPORT_RE = /^preflight[\w.-]*\.txt$/;

/** Every pre-flight report under a review dir, oldest first. */
export function preflightReports(work) {
  const dirs = [work];
  try {
    for (const name of readdirSync(work)) if (/^round-\d+$/.test(name)) dirs.push(path.join(work, name));
  } catch { return []; }
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!PREFLIGHT_REPORT_RE.test(name)) continue;
      const file = path.join(dir, name);
      try { files.push([file, statSync(file).mtimeMs]); } catch { /* gone between readdir and stat */ }
    }
  }
  return files.sort((a, b) => a[1] - b[1]).map(([file]) => file);
}

/** The checks whose latest verdict is no verdict: `[{ kind, cmd, why, report }]`. */
export function unverifiedChecks(work) {
  const latest = new Map();
  // A report that is listed but cannot be read blocks: "could not look" is not
  // "nothing unverified", and this check exists to fail closed. A newer readable
  // report supersedes it, since a re-run runs every check again — otherwise the
  // re-run every message prescribes could never clear it.
  const unreadable = [];
  let lastReadable = -1;
  const reports = preflightReports(work);
  for (const [at, report] of reports.entries()) {
    let text = "";
    try { text = readFileSync(report, "utf8"); lastReadable = at; } catch { unreadable.push({ at, kind: "report", cmd: path.basename(report), why: "report unreadable", report }); continue; }
    for (const line of text.split("\n")) {
      if (line.startsWith("--- ")) break;
      const m = LINE_RE.exec(line);
      if (!m) continue;
      const [, verdict, kind, cmd, note = ""] = m;
      if (cmd === "(preflight.skip)") {
        latest.delete(kind);
        continue;
      }
      // FLAKY is a verdict: the suite ran to the end twice (Q-a, preflight.sh).
      if (verdict === "PASS" || verdict === "FAIL" || verdict === "FLAKY" || UNVERIFIED_RE.test(note)) latest.set(kind, { verdict, kind, cmd, note, report });
    }
  }
  return [...latest.values()]
    .filter((c) => UNVERIFIED_RE.test(c.note))
    .map(({ kind, cmd, note, report }) => ({ kind, cmd, why: note.match(UNVERIFIED_RE)[1], report }))
    .concat(unreadable.filter((u) => u.at > lastReadable).map(({ at, ...entry }) => entry));
}
