/**
 * One walk over a unified diff, shared by impact.mjs (which symbols moved) and
 * tier.mjs (how many lines, and what the added ones say). Both used to walk it
 * themselves, and two walkers disagreeing about what counts as a changed line
 * is how a tier and its impact end up describing different changes.
 *
 * Returns one entry per file, hunks in order, `+` lines carrying their line
 * number in the new file — the number a marker or a finding is quoted at.
 */
const strip = (value) => (value === "/dev/null" ? null : value.replace(/^[ab]\//, "").replace(/\t.*$/, ""));

export function parseDiff(lines) {
  const files = [];
  let file = null, hunk = null, minus = null, lineNumber = 0;
  for (const line of lines) {
    if (line.startsWith("--- ")) { minus = strip(line.slice(4).trim()); continue; }
    if (line.startsWith("+++ ")) {
      const name = strip(line.slice(4).trim()) || minus;
      hunk = null;
      if (!name) { file = null; continue; }
      // A file can be diffed twice in one bundle (tracked diff, then the
      // untracked rendering); its hunks belong to one entry.
      file = files.find((entry) => entry.file === name) ?? null;
      if (!file) { file = { file: name, hunks: [] }; files.push(file); }
      continue;
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (header) {
      if (!file) continue;
      lineNumber = Number(header[1]);
      hunk = { context: header[2], lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const sign = line[0];
    if (sign === "+") { hunk.lines.push({ sign, text: line.slice(1), line: lineNumber }); lineNumber += 1; continue; }
    if (sign === "-") { hunk.lines.push({ sign, text: line.slice(1), line: lineNumber }); continue; }
    // Context advances the new-file line counter; "\ No newline at end of
    // file" and the next file's `diff --git` header advance nothing.
    if (sign === " " || line === "") lineNumber += 1;
  }
  return files;
}

/** Changed (`+` and `-`) lines per file — the diff's own size, headers excluded. */
export const changedLineCounts = (files) =>
  new Map(files.map((entry) => [entry.file, entry.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)]));
