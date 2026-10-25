/**
 * Line-by-line reads of transcripts and logs, which outgrow a JavaScript string.
 *
 * `readFileSync(file, "utf8")` builds the whole file as one string, and V8 caps
 * a string at 0x1fffffe8 characters (~512 MB). A user's session transcripts
 * reached 1,659, 597 and 591 MB, and audit.mjs died on the first with no output
 * (0.11.1, 2026-10-25). Every reader of a file that only ever grows reads it
 * here instead, in fixed chunks, so no string is longer than one line.
 *
 * Synchronous on purpose: the hooks that call this must finish before they
 * answer, and a stream would make every caller async for no gain.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { constants } from "node:buffer";

const CHUNK_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Each line of `file` without its newline, the unterminated last one included.
 * Lines are cut on the newline byte, so a multibyte character split across two
 * chunks is joined before it is decoded. A line longer than `maxLineBytes`
 * cannot become a string; it is skipped whole, as a torn line is.
 */
export function* linesOf(file, { chunkBytes = CHUNK_BYTES, maxLineBytes = constants.MAX_STRING_LENGTH } = {}) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let pending = [];       // copies of the current line's earlier pieces
    let pendingBytes = 0;
    let oversized = false;  // the current line is past the cap: drop it through its newline
    for (let read; (read = readSync(fd, buffer, 0, chunkBytes, null)) > 0;) {
      const chunk = buffer.subarray(0, read);
      let start = 0;
      for (let nl; (nl = chunk.indexOf(NEWLINE, start)) !== -1; start = nl + 1) {
        const tail = chunk.subarray(start, nl);
        if (!oversized && pendingBytes + tail.length <= maxLineBytes) {
          yield (pending.length ? Buffer.concat([...pending, tail]) : tail).toString("utf8");
        }
        pending = []; pendingBytes = 0; oversized = false;
      }
      if (start < read && !oversized) {
        pendingBytes += read - start;
        if (pendingBytes > maxLineBytes) { oversized = true; pending = []; pendingBytes = 0; }
        else pending.push(Buffer.from(chunk.subarray(start)));  // the buffer is reused next read
      }
    }
    if (pending.length && !oversized) yield Buffer.concat(pending).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Every line of `file` that parses as JSON, in order; blank and torn lines are skipped. */
export function* jsonlOf(file, options) {
  for (const line of linesOf(file, options)) {
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    yield value;
  }
}
