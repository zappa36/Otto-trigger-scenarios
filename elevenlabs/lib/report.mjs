/*
 * What the loop prints and diffs. Tables in the style of
 * scripts/tune_triggers.py — fixed columns, one row per thing, a
 * verdict glyph where there is one — and a unified diff of the prompt,
 * because a proposal a human cannot read in one screen is a proposal
 * nobody applies. No dependencies, like the rest of the kit: the diff
 * is a plain LCS over lines, which is all a prompt of a few hundred
 * lines needs.
 */

/* rows: objects; cols: [{ key, label, width, right }]. Cells wider
 * than the column are cut with an ellipsis, so a long test name never
 * pushes the numbers off the screen. */
export function table(rows, cols) {
  const cut = (s, w) => { s = String(s == null ? '' : s); return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s; };
  const cell = (s, c) => (c.right ? cut(s, c.width).padStart(c.width) : cut(s, c.width).padEnd(c.width));
  const lines = [cols.map(c => cell(c.label, c)).join('  ')];
  for (const r of rows) lines.push(cols.map(c => cell(typeof c.get === 'function' ? c.get(r) : r[c.key], c)).join('  '));
  return lines.join('\n');
}

export const pct = x => (x == null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`);

/* 20260914T112400.123Z — sorts as text, safe in a file name on every
 * OS. Milliseconds, and never the same value twice in one process: two
 * commands a second apart must not overwrite each other's file. */
let lastStamp = 0;
export const stamp = (d = new Date()) => {
  let t = d.getTime();
  if (t <= lastStamp) t = lastStamp + 1;
  lastStamp = t;
  return new Date(t).toISOString().replace(/[-:]/g, '');
};

/* A failure rationale, reduced to the sentence that names the reason,
 * so the same complaint worded three ways lands in one bucket. */
export function reasonKey(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[.!?])\s+/)[0] || s;
  return first.toLowerCase().replace(/[^a-z0-9àèéìòù' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- the diff ---------- */

function lcsOps(a, b) {
  const n = a.length, m = b.length;
  /* the table holds LCS lengths of suffixes, so the walk below reads
   * forwards and emits ops in order */
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/* A unified diff of two texts, hunks with `context` lines around each
 * change, in the format `git diff` prints — so it can be read by eye
 * and applied by hand. Returns '' when the texts are equal. */
export function unifiedDiff(oldText, newText, { oldName = 'prompt (current)', newName = 'prompt (proposed)', context = 3 } = {}) {
  const a = String(oldText).split('\n'), b = String(newText).split('\n');
  const ops = lcsOps(a, b);
  if (!ops.some(([t]) => t !== ' ')) return '';
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    /* a hunk runs from `context` lines before this change to `context`
     * lines after the last change that is within 2*context of another */
    let start = Math.max(0, k - context);
    let end = k;
    let last = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') last = end;
      else if (end - last > 2 * context) break;
      end++;
    }
    end = Math.min(ops.length, last + context + 1);
    const slice = ops.slice(start, end);
    /* line numbers: count how many old / new lines precede `start` */
    let oldStart = 1, newStart = 1;
    for (let x = 0; x < start; x++) { if (ops[x][0] !== '+') oldStart++; if (ops[x][0] !== '-') newStart++; }
    const oldLen = slice.filter(([t]) => t !== '+').length;
    const newLen = slice.filter(([t]) => t !== '-').length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const [t, line] of slice) out.push(t + line);
    k = end;
  }
  return out.join('\n');
}

/* +3 / -2 / ±0 — what a compare row says about a test at a glance */
export const signed = (x, digits = 0) => (x > 0 ? '+' : x < 0 ? '' : '±') + (digits ? x.toFixed(digits) : String(Math.round(x)));
