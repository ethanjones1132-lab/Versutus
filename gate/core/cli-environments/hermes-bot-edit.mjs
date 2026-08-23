/**
 * Bounded profile.yaml edits for an existing Bot (ADR 0015).
 *
 * The Gate already owns file writes inside a Bot's home (SOUL.md, .env at
 * create). Updating the one-line description reuses that ownership with a
 * line-scoped edit: only the top-level `description:` key and its folded
 * continuation lines are touched, mirroring what `parseDescription` reads.
 * Every other line is preserved byte-for-byte, including its original
 * `\r\n` or `\n` ending — the CLI writes CRLF profiles on Windows and a
 * whole-file re-serialisation would churn unrelated history.
 */

function foldDescription(description) {
  return String(description)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain-safe scalars stay unquoted; everything else is a double-quoted scalar. */
function serializeScalar(value) {
  if (/^[A-Za-z0-9][A-Za-z0-9 _.,!?()/'&+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function continuationCount(segments, start) {
  let count = 0;
  while (
    start + 1 + count < segments.length
    && /^[ \t]+\S/.test(segments[start + 1 + count].text)
  ) {
    count += 1;
  }
  return count;
}

/** Splits into `{ text, end }` pairs where `end` is the line's own terminator. */
function splitKeepingEnds(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
    let next = j;
    if (text[j] === '\r' && text[j + 1] === '\n') next += 2;
    else if (text[j] === '\n' || text[j] === '\r') next += 1;
    segments.push({ text: text.slice(i, j), end: text.slice(j, next) });
    i = next;
  }
  return segments;
}

function render(segments) {
  return segments.map((segment) => segment.text + segment.end).join('');
}

/**
 * Returns yamlText with the top-level description set (or removed when the
 * value folds to empty). Untouched lines keep their exact bytes apart from a
 * guaranteed trailing newline when appending.
 */
export function upsertProfileDescription(yamlText, description) {
  const source = typeof yamlText === 'string' ? yamlText : '';
  const segments = splitKeepingEnds(source);
  const start = segments.findIndex((segment) => /^description:(?:[ \t]+.*)?$/.test(segment.text));
  const folded = foldDescription(description ?? '');

  if (!folded) {
    if (start === -1) return source;
    segments.splice(start, 1 + continuationCount(segments, start));
    return render(segments);
  }

  const line = `description: ${serializeScalar(folded)}`;
  if (start !== -1) {
    const end = segments[start].end;
    segments.splice(start, 1 + continuationCount(segments, start), { text: line, end });
    return render(segments);
  }

  // Append at column zero using the file's own dominant line ending.
  let fileEol = '\n';
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].end) {
      fileEol = segments[i].end;
      break;
    }
  }
  while (segments.length > 0 && segments[segments.length - 1].text === '') segments.pop();
  if (segments.length > 0 && !segments[segments.length - 1].end) {
    segments[segments.length - 1].end = fileEol;
  }
  segments.push({ text: line, end: fileEol });
  return render(segments);
}
