const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(source, [minimum, maximum], field) {
  const values = new Set();
  for (const part of source.split(',')) {
    const [rangeText, stepText, ...extra] = part.split('/');
    if (extra.length || (stepText !== undefined && !/^\d+$/.test(stepText))) {
      throw new Error(`Invalid cron ${field} field`);
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new Error(`Invalid cron ${field} step`);
    let start = minimum;
    let end = maximum;
    if (rangeText !== '*') {
      const range = /^(\d+)(?:-(\d+))?$/.exec(rangeText);
      if (!range) throw new Error(`Invalid cron ${field} field`);
      start = Number(range[1]);
      end = range[2] === undefined ? start : Number(range[2]);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new Error(`Cron ${field} values must be between ${minimum} and ${maximum}`);
    }
    for (let value = start; value <= end; value += step) values.add(field === 'day-of-week' && value === 7 ? 0 : value);
  }
  return { values, wildcard: source === '*' };
}

/** Parse a five-field cron expression (minute hour day month weekday). */
export function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('Cron schedule must be a string');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron schedule must have five fields');
  return fields.map((field, index) => parseField(field, FIELD_RANGES[index], [
    'minute', 'hour', 'day-of-month', 'month', 'day-of-week',
  ][index]));
}

function matchesDayOfMonth(day, weekday, dom, dow) {
  if (dom.wildcard && dow.wildcard) return true;
  if (dom.wildcard) return dow.values.has(weekday);
  if (dow.wildcard) return dom.values.has(day);
  return dom.values.has(day) || dow.values.has(weekday);
}

/**
 * Find the next occurrence in the host's local timezone. Walking real minutes
 * (rather than adding a local calendar day) naturally skips nonexistent DST
 * minutes and does not invent a second occurrence during a fall-back hour.
 */
export function nextCronRun(expression, after = new Date()) {
  const [minute, hour, day, month, weekday] = parseCron(expression);
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  // Five years bounds impossible expressions such as February 31.
  const limit = start.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  for (let time = start.getTime(); time <= limit; time += 60_000) {
    const candidate = new Date(time);
    if (minute.values.has(candidate.getMinutes())
      && hour.values.has(candidate.getHours())
      && month.values.has(candidate.getMonth() + 1)
      && matchesDayOfMonth(candidate.getDate(), candidate.getDay(), day, weekday)) return candidate;
  }
  throw new Error(`Cron schedule has no occurrence within five years: ${expression}`);
}
