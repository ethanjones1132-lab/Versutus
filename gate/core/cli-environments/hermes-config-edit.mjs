/**
 * Remove selected model pins from a Bot's config.yaml without reserialising
 * provider credentials or unrelated model settings.
 */
export function removeModelPins(yamlText, fields = ['default', 'provider']) {
  const source = typeof yamlText === 'string' ? yamlText : '';
  const wanted = new Set(fields);
  if (wanted.size === 0) return source;

  const lines = splitKeepingEnds(source);
  const modelStart = lines.findIndex((line) => /^model:\s*$/.test(line.text));
  if (modelStart === -1) return source;

  const modelEnd = findBlockEnd(lines, modelStart + 1);
  const kept = lines.slice(modelStart + 1, modelEnd).filter((line) => {
    const match = /^[ \t]+(default|provider):(?:[ \t]+.*)?$/.exec(line.text);
    return !match || !wanted.has(match[1]);
  });

  if (kept.some((line) => line.text.trim() && /^[ \t]+\S/.test(line.text))) {
    lines.splice(modelStart + 1, modelEnd - modelStart - 1, ...kept);
  } else {
    lines.splice(modelStart, modelEnd - modelStart);
  }
  return lines.map((line) => line.text + line.end).join('');
}

function findBlockEnd(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].text && !/^[ \t]/.test(lines[i].text)) return i;
  }
  return lines.length;
}

function splitKeepingEnds(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1;
    let next = end;
    if (text[end] === '\r' && text[end + 1] === '\n') next += 2;
    else if (text[end] === '\r' || text[end] === '\n') next += 1;
    lines.push({ text: text.slice(start, end), end: text.slice(end, next) });
    start = next;
  }
  return lines;
}
