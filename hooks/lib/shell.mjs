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
    } else if (ch === "(" || ch === ")") { // shell metacharacters: words of their own
      flush(); out.push(ch); i++;
    } else if (/\s/.test(ch)) {
      flush(); i++;
    } else { word += ch; i++; }
  }
  flush();
  return out;
}
