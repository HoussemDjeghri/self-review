/**
 * The Levenshtein distance, for "did you mean" hints. findings.mjs and wait.mjs
 * each carried their own copy; both only ask whether it is at most 2, so a
 * length gap wider than that answers 3 without filling the table.
 */
export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}
