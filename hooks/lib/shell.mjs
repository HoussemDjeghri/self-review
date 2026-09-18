/**
 * Reading a shell command: its words, and which word is in command position.
 *
 * Extracted from self-review-gate.mjs when tree-guard.mjs was found to be
 * bypassable by every wrapper the gate already saw through — `bash -c "git
 * reset --hard"`, `sudo -u root git clean -fd` — because the two hooks had
 * grown separate, unequal parsers for the same question. One parser, two
 * callers: a shape the gate learns to see is a shape the guard sees too.
 */

export const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh"]);
// What sits before the command word: a subshell's `(`, `VAR=value` assignments
// and wrappers with their flags. Each wrapper maps to the flag letters that take
// a value, read the getopt way: the first such letter in a cluster takes the
// rest of the word (`-I{}`, `-uroot`) or, when it ends the word, the next word
// (`-u root`, `-0I {}`).
export const COMMAND_PREFIXES = new Map([["sudo", "ugpCDrtTU"], ["env", "uC"], ["time", "fo"], ["nohup", ""], ["xargs", "IJLnPsdEa"], ["command", ""], ["exec", ""]]);
function takesNextWord(flag, valueLetters) {
  if (flag.startsWith("--")) return false;
  for (let i = 1; i < flag.length; i++) if (valueLetters.includes(flag[i])) return i === flag.length - 1;
  return false;
}
// Compound-command words that leave the next word in command position too.
// `git reset --hard` hid behind every one of them: `SEPARATORS` and
// `splitSegments` both cut at `;`, so the surviving segment of
// `if true; then git reset --hard; fi` begins with the bare keyword `then`.
const SHELL_KEYWORDS = new Set(["(", "{", "!", "if", "then", "elif", "else", "while", "until", "do"]);

export function afterPrefixes(ws) {
  let i = 0;
  for (let moved = true; moved && i < ws.length;) {
    moved = false;
    while (i < ws.length && SHELL_KEYWORDS.has(ws[i])) { i++; moved = true; }
    while (i < ws.length && (/^[A-Za-z_]\w*=/.test(ws[i]) || COMMAND_PREFIXES.has(ws[i]))) {
      const valueLetters = COMMAND_PREFIXES.get(ws[i]) ?? "";
      i++; moved = true;
      while (i < ws.length && ws[i].startsWith("-")) i += takesNextWord(ws[i], valueLetters) ? 2 : 1;
    }
  }
  return i;
}
export const commandOf = (ws) => ws[afterPrefixes(ws)] ?? "";
// The string `bash -c` runs — a command list of its own, for writes and for the marker alike.
export function inlineShell(ws) {
  const i = afterPrefixes(ws);
  return SHELL_INTERPRETERS.has(ws[i]) && /^-\w*c\w*$/.test(ws[i + 1] ?? "") ? ws[i + 2] ?? "" : null;
}

export function afterSingleQuoted(cmd, i) {
  if (cmd[i - 2] !== "$") { // plain '…' has no escapes at all
    const end = cmd.indexOf("'", i);
    return end === -1 ? cmd.length : end + 1;
  }
  for (; i < cmd.length; i++) { // ANSI-C $'…' honours backslashes
    if (cmd[i] === "\\") i++;
    else if (cmd[i] === "'") return i + 1;
  }
  return i;
}
export function afterBacktick(cmd, i) {
  const end = cmd.indexOf("`", i);
  return end === -1 ? cmd.length : end + 1;
}
export function afterDoubleQuoted(cmd, i) {
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else if (ch === "$" && cmd[i + 1] === "(") i = afterSubstitution(cmd, i + 2);
    else i++;
  }
  return i;
}
export function afterSubstitution(cmd, i) {
  for (let depth = 1; i < cmd.length && depth > 0;) {
    const ch = cmd[i];
    if (ch === "'") i = afterSingleQuoted(cmd, i + 1);
    else if (ch === '"') i = afterDoubleQuoted(cmd, i + 1);
    else { depth += ch === "(" ? 1 : ch === ")" ? -1 : 0; i++; }
  }
  return i;
}

// Replaces quoted strings — and bare `$( … )` or backtick bodies, which
// splitSegments judges on their own — with Q's of the same length, so operators inside them are not
// read as shell syntax and positions still line up with the raw text. A scanner
// rather than a regex because a double-quoted string may hold
// a $( … ) substitution that itself holds quotes — `echo "n: $(jq '…"…"…' f)"`
// is a common shape, and a regex loses phase at its inner quote, exposing a `>`
// inside <task-notification> as a redirect.
export function maskQuotes(cmd) {
  let out = "";
  for (let i = 0; i < cmd.length;) {
    const ch = cmd[i];
    // A backslash at top level escapes the next character, so neither is shell
    // syntax — mask both. Without this the scan had no escape awareness at all
    // and read `\"` as OPENING a quoted region: `echo a\"b | grep "x>y"` lost
    // phase and exposed the `>` inside the later quoted string as a redirect,
    // reporting a read-only pipeline as a write. `echo a\>b` was the same hole
    // one step shorter — an escaped operator read as an operator. The quote fix
    // below only stopped one way of INJECTING a stray quote; this is the defect
    // both spellings reached. `afterDoubleQuoted` already handles an escape
    // inside an open string; top level was the gap.
    if (ch === "\\" && i + 1 < cmd.length) { out += "QQ"; i += 2; continue; }
    const end = ch === "'" ? afterSingleQuoted(cmd, i + 1) : ch === '"' ? afterDoubleQuoted(cmd, i + 1)
      : ch === "`" ? afterBacktick(cmd, i + 1) : ch === "$" && cmd[i + 1] === "(" ? afterSubstitution(cmd, i + 2) : 0;
    if (end) { out += "Q".repeat(end - i); i = end; }
    else { out += ch; i++; }
  }
  return out;
}

// The text of the simple command a heredoc's `<<` belongs to. Boundaries are
// read on the masked line, so a `;` inside a quoted argument is not one, and a
// redirect's `&` (`2>&1`) is not one either. A heredoc inside a still-open
// `$(` — `X=$(python3 - <<EOF` — is masked to the end of the line, so its
// feeder is looked for inside the substitution. The same holds one quote
// deeper: in `X="$(python3 - <<EOF` the masked run starts at the `"`, and
// stopping there hid the feeder, so a double quote still open at the end of
// the line is entered too (its `$(` is live). Only a still-open one: a closed
// `"…"` right before `<<` (`bash -c "true"<<EOF`) is an argument of the feeder,
// and entering it lost the feeder. A trailing space swallowed by the mask is
// how "still open" is read. A single quote is not entered: nothing inside runs.
const FEEDER_BOUNDARIES = ["(", ";", "&", "|"];
export function feederLead(line) {
  const masked = maskQuotes(line);
  const open = masked.search(/Q*$/);
  if (line.startsWith("$(", open)) return feederLead(line.slice(open + 2));
  const stillOpen = maskQuotes(`${line} `).endsWith("Q");
  if (line[open] === '"' && stillOpen) return feederLead(line.slice(open + 1));
  const bounds = masked.replace(/[<>]&|&>>?/g, (op) => "R".repeat(op.length));
  return line.slice(Math.max(...FEEDER_BOUNDARIES.map((c) => bounds.lastIndexOf(c))) + 1);
}

// ── Segmenting a command: moved verbatim from self-review-gate.mjs so the gate
// and audit.mjs read a command the same way (ruling: docs/design-notes/
// questions/shared-segmenter-answer.md). The gate's call sites are unchanged.

// Matched against the command word alone: `cat > scope.sh <<EOF` must not read as `sh`.
export const INTERPRETER_RE = /^(python[\d.]*|node|deno|bun|ruby|perl|php|bash|sh|zsh|osascript)$/;
// Starts at the `<<` itself: a leading `[^\n]*` made every long line without a
// heredoc quadratic (14 s for a 100k-character command).
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;

// A heredoc body is data when it feeds cat/tee/a file and code when it feeds an
// interpreter (`python3 - <<EOF`). Data bodies are dropped — a README that
// mentions `sed -i` is not a write. Code bodies are lifted out and analysed as
// code, so a script that opens a file for writing is still seen.
//
// The feeder is the simple command the `<<` belongs to, not the line's first
// word: `X=$(python3 - <<EOF` and `cd dir; python3 - <<EOF` both feed python3.
// Reading the line's first word read the second as `cd`, dropped the body as
// data, and a heredoc that rewrote a hook outside the repo never reached the
// gate (field report 2026-09-18, item 4 — every such command began `cd …;`).
export function separateHeredocs(cmd) {
  const scripts = [];
  const text = cmd.replace(/\r\n?/g, "\n"); // a CRLF heredoc terminates all the same
  const shell = text.replace(HEREDOC_RE, (whole, _quote, _word, offset) => {
    const head = whole.slice(0, whole.indexOf("\n"));
    const line = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
    const interpreter = commandOf(words(feederLead(line))).match(INTERPRETER_RE)?.[1];
    if (interpreter) scripts.push({ interpreter, body: whole.slice(head.length + 1, whole.lastIndexOf("\n")) });
    return head;
  });
  return { shell, scripts };
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
export function splitSegments(cmd) {
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
    } else if (ch === "\\" && cmd[i + 1] === "\n") {
      i++; // a line continuation: bash removes both and joins the lines
    } else if (ch === "\\" && i + 1 < cmd.length) {
      current += ch + cmd[++i]; // an escaped separator is not a separator
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

// The words of a segment, quotes removed but each quoted span kept whole — a
// sed expression or a path with spaces is one word, not several. Empty spans
// (`-i ''`) are dropped.
export function words(segment) {
  const out = [];
  let word = "";
  const flush = () => { if (word) out.push(word); word = ""; };
  for (let i = 0; i < segment.length;) {
    const ch = segment[i];
    if (ch === "'" || ch === '"') {
      const end = ch === "'" ? afterSingleQuoted(segment, i + 1) : afterDoubleQuoted(segment, i + 1);
      word += segment.slice(i + 1, segment[end - 1] === ch ? end - 1 : end);
      i = end;
    } else if (ch === "`" || (ch === "$" && segment[i + 1] === "(")) { // a substitution is one word, kept verbatim
      const end = ch === "`" ? afterBacktick(segment, i + 1) : afterSubstitution(segment, i + 2);
      word += segment.slice(i, end);
      i = end;
    } else if (ch === "\\" && i + 1 < segment.length) {
      // A backslash escapes the next character and is removed from the word —
      // the same normalising this function already did for quotes, and the
      // reason it had to be added: `r"m"` was caught and `r\m` was not, so one
      // backslash hid any command name from `commandOf` and a reviewer's
      // `r\m -rf .` walked past the guard that exists to protect the author's
      // uncommitted work. It also keeps an escaped space inside its word, so
      // `cp a /repo/my\ file` names one target instead of two half-paths.
      word += segment[i + 1]; i += 2;
    } else if (ch === "(" || ch === ")") { // shell metacharacters: words of their own
      flush(); out.push(ch); i++;
    } else if (/\s/.test(ch)) {
      flush(); i++;
    } else { word += ch; i++; }
  }
  flush();
  return out;
}
