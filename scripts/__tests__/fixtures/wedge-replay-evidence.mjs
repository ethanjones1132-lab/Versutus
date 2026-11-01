/**
 * Replay evidence for the commercial-wedge smoke (`../../smoke-wedge-loop.mjs`).
 *
 * Once a run finishes, a phone that dropped its SSE connection reattaches and
 * receives the whole event log replayed. The smoke used to prove agreement by
 * comparing event TYPES only: a replay that swapped two `run.output` fragments,
 * drifted a sequence number, named another run, or dropped a payload field read
 * as green — exactly the corruption a reattaching operator would see as mangled
 * text under a "completed" run.
 *
 * `compareRunEventStreams` compares the two streams field by field and returns
 * a verdict rather than throwing, so the smoke can report a failure as its own
 * `wedge step` line and the node --test leg can pin each rule directly. It is a
 * pure function: it reads both arrays and never rewrites them.
 *
 * Only `timestamp` is excluded, and deliberately. Every field a reattaching
 * phone renders — sequence, type, runId and the whole payload tree — must match
 * the live stream exactly. The timestamp is the wall-clock mark of emission
 * rather than part of the event's meaning, and a Gate that reloads a run whose
 * process died synthesizes its closing verdict with a fresh stamp (see
 * `hydrateArchive` in `gate/core/cli-environments/supervisor.mjs`), so a
 * replay-vs-live comparison is allowed to see different stamps for equal events.
 */

/** Enough detail to fix the first bug without dumping a whole transcript. */
const MAX_REPORTED_DIFFERENCES = 3;

/** Longest value rendered into a failure line, so one huge fragment cannot hide the rest. */
const MAX_SAMPLE_CHARS = 120;

function sampleValue(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive payload agreement. Reports at most `MAX_REPORTED_DIFFERENCES`
 * paths, each naming where the two payload trees part company, so a failure
 * line points at the field instead of printing two whole events.
 */
function compareValues(live, replayed, path, differences) {
  if (differences.length >= MAX_REPORTED_DIFFERENCES) return;
  // Object.is keeps NaN equal to NaN without treating -0 as equal to 0.
  if (Object.is(live, replayed)) return;

  const liveIsArray = Array.isArray(live);
  const replayedIsArray = Array.isArray(replayed);
  if (liveIsArray || replayedIsArray) {
    if (!liveIsArray || !replayedIsArray) {
      differences.push(`${path}: live ${sampleValue(live)} vs replay ${sampleValue(replayed)}`);
      return;
    }
    if (live.length !== replayed.length) {
      differences.push(`${path}: live has ${live.length} item(s), replay has ${replayed.length}`);
    }
    const shared = Math.min(live.length, replayed.length);
    for (let index = 0; index < shared; index += 1) {
      compareValues(live[index], replayed[index], `${path}[${index}]`, differences);
    }
    return;
  }

  if (isPlainObject(live) && isPlainObject(replayed)) {
    // Every key either side knows about: a replayed payload that gained a field
    // is as much a divergence as one that lost a field.
    const keys = new Set([...Object.keys(live), ...Object.keys(replayed)]);
    for (const key of keys) {
      if (differences.length >= MAX_REPORTED_DIFFERENCES) return;
      const here = `${path}.${key}`;
      if (!Object.hasOwn(replayed, key)) {
        differences.push(`${here}: missing from replay (live ${sampleValue(live[key])})`);
        continue;
      }
      if (!Object.hasOwn(live, key)) {
        differences.push(`${here}: not in live (replay ${sampleValue(replayed[key])})`);
        continue;
      }
      compareValues(live[key], replayed[key], here, differences);
    }
    return;
  }

  differences.push(`${path}: live ${sampleValue(live)} vs replay ${sampleValue(replayed)}`);
}

/**
 * Whether a reattaching phone's replay reproduces the live stream.
 *
 * Returns `{ ok: true, count }` when every event agrees, or
 * `{ ok: false, reason }` naming the first divergence. A replayed log always
 * starts at sequence 1 and is contiguous (it is the whole run, not a tail), so
 * both streams are held to that as well — a gap in a "complete" replay is a
 * missing event on the phone, whatever the remaining types look like.
 */
export function compareRunEventStreams(live, replayed) {
  if (!Array.isArray(live)) {
    return { ok: false, reason: `the live stream is not an array (${sampleValue(live)})` };
  }
  if (!Array.isArray(replayed)) {
    return { ok: false, reason: `the replay is not an array (${sampleValue(replayed)})` };
  }
  if (replayed.length !== live.length) {
    return {
      ok: false,
      reason: `replay has ${replayed.length} event(s), the live stream had ${live.length}`,
    };
  }

  for (let index = 0; index < live.length; index += 1) {
    const expected = live[index];
    const actual = replayed[index];
    const position = `event ${index + 1}`;
    if (!isPlainObject(expected) || !isPlainObject(actual)) {
      return {
        ok: false,
        reason: `${position}: ${isPlainObject(actual) ? 'the live' : 'the replayed'} event is not an object`,
      };
    }
    const label = `${position} (${expected.type ?? 'no type'})`;
    if (actual.sequence !== index + 1) {
      return {
        ok: false,
        reason: `${label}: replay sequence ${sampleValue(actual.sequence)} (expected ${index + 1})`,
      };
    }
    if (actual.sequence !== expected.sequence) {
      return {
        ok: false,
        reason: `${label}: replay sequence ${sampleValue(actual.sequence)} vs live ${sampleValue(expected.sequence)}`,
      };
    }
    if (actual.type !== expected.type) {
      return {
        ok: false,
        reason: `${label}: replay type ${sampleValue(actual.type)} vs live ${sampleValue(expected.type)}`,
      };
    }
    if (actual.runId !== expected.runId) {
      return {
        ok: false,
        reason: `${label}: replay runId ${sampleValue(actual.runId)} vs live ${sampleValue(expected.runId)}`,
      };
    }
    const differences = [];
    compareValues(expected.payload, actual.payload, 'payload', differences);
    if (differences.length > 0) {
      return { ok: false, reason: `${label}: ${differences.join('; ')}` };
    }
  }

  return { ok: true, count: replayed.length };
}
