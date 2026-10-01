import {
  completedSentenceText,
  planHandsfreeSpeech,
  replyPrefixIntact,
  type HandsfreeSpeechCursor,
  type HandsfreeSpeechPlan,
} from '@/lib/voice/handsfree-reply';
import { speechChunks } from '@/lib/voice/speech-chunks';

// A reply is planned once per streamed delta. The whole-reply scan behind that
// was the defect: each delta re-read the reply from index 0, so a 20 kB reply
// cost hundreds of megabytes of scanning on the JS thread that also dispatches
// the native level events. The plan now resumes from the position the last one
// reached. Two things have to hold for that to be safe, and both are pinned
// here: the incremental answer must be the answer the whole-reply scan gave,
// for every intermediate delta of any reply; and the work must be proportional
// to the reply, not its square.

type PlanInput = {
  fullText: string;
  streaming: boolean;
  spoken: string;
  maxLength: number;
  waitForCompletion: boolean;
};

/**
 * The pre-change planner, kept verbatim as the reference every incremental
 * answer is compared against: `replyPrefixIntact` over the whole spoken prefix,
 * then a full scan of the whole reply, on every delta.
 */
function referencePlan(input: PlanInput): HandsfreeSpeechPlan {
  if (!replyPrefixIntact(input.spoken, input.fullText)) {
    return { chunks: [], spoken: '', mutated: true };
  }
  if (input.waitForCompletion && input.streaming) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }
  const window = input.streaming ? completedSentenceText(input.fullText) : input.fullText;
  if (window.length <= input.spoken.length) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }
  const fresh = window.slice(input.spoken.length);
  const chunks = speechChunks(fresh, input.maxLength);
  if (!chunks.length) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }
  return { chunks, spoken: window, mutated: false };
}

/** A reproducible generator, so a failure names the reply it happened on. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const PIECES = [
  'The build passed on the first try. ',
  'Version 1.2.3 shipped; nothing else changed. ',
  'Try `npm run verify` before you push. ',
  '```ts\nconst answer = 42;\nconsole.log(answer);\n```\n',
  '### Notes\n\n- first item\n- second item\n',
  'Dr. Smith called at 3 p.m. ',
  'Wait... is that right? ',
  'Line one of a list:\n',
  'e.g. the second example, i.e. the same thing. ',
  'No terminator here at all',
  '\n\n',
  'Mixed **bold** and _italic_ text. ',
];

/** A reply with sentences, fences, markdown, abbreviations and no terminator at all. */
function randomReply(rand: () => number, sentences: number): string {
  let out = '';
  for (let index = 0; index < sentences; index += 1) {
    out += PIECES[Math.floor(rand() * PIECES.length)] ?? 'Something. ';
  }
  return out;
}

/**
 * One character inside what has already been spoken, changed in place. The
 * rewrite is kept inside the spoken prefix so the pre-change planner names it as
 * a mutation too: the incremental answer has to be the same answer, not a
 * stricter one, for every step of the comparison.
 */
function rewriteSpoken(text: string, spoken: string, rand: () => number): string {
  if (!spoken.length) return text;
  const at = Math.floor(rand() * spoken.length);
  const char = text[at];
  const flipped = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
  return text.slice(0, at) + flipped + text.slice(at + 1);
}

function speakable(plan: HandsfreeSpeechPlan): unknown {
  return { chunks: plan.chunks, spoken: plan.spoken, mutated: plan.mutated };
}

/** Both answers for one delta: the incremental plan and the whole-reply one. */
function both(
  input: PlanInput,
  cursor: HandsfreeSpeechCursor | undefined,
): { plan: HandsfreeSpeechPlan; expected: HandsfreeSpeechPlan } {
  return { plan: planHandsfreeSpeech({ ...input, cursor }), expected: referencePlan(input) };
}

describe('planHandsfreeSpeech — the incremental answer is the whole-reply answer', () => {
  test('every intermediate delta of every generated reply matches the reference', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = lcg(seed);
      const reply = randomReply(rand, 8);
      let spoken = '';
      let cursor: HandsfreeSpeechCursor | undefined;
      for (let end = 1; end <= reply.length; end += 1) {
        const fullText = reply.slice(0, end);
        const streaming = end < reply.length;
        const input: PlanInput = { fullText, streaming, spoken, maxLength: 240, waitForCompletion: false };
        const expected = referencePlan(input);
        const plan = planHandsfreeSpeech({ ...input, cursor });
        // The incremental plan must be indistinguishable from the scan it
        // replaces, delta for delta.
        expect(speakable(plan)).toEqual(speakable(expected));
        if (plan.mutated) {
          spoken = '';
          cursor = undefined;
        } else {
          if (streaming) expect(plan.cursor?.index).toBe(fullText.length);
          spoken = plan.spoken;
          cursor = plan.cursor;
        }
      }
    }
  });

  test('the delta size does not change what the reply says', () => {
    const reply = 'One. Two. Three.\n```js\nconst x = 1;\n```\nFour! Five? Six';
    const spokenOf = (step: number): string[] => {
      let spoken = '';
      let cursor: HandsfreeSpeechCursor | undefined;
      const out: string[] = [];
      for (let end = step; end <= reply.length; end += step) {
        const fullText = reply.slice(0, end);
        const plan = planHandsfreeSpeech({
          fullText,
          streaming: end < reply.length,
          spoken,
          maxLength: 400,
          waitForCompletion: false,
          cursor,
        });
        out.push(...plan.chunks);
        spoken = plan.spoken;
        cursor = plan.cursor;
      }
      return out;
    };
    // The whole reply in one delta, and the same reply in five-character
    // deltas, say the same thing in the same order. Only where the queue pauses
    // may differ, which is what a chunk boundary decides.
    const said = (chunks: string[]) => chunks.join('');
    expect(said(spokenOf(5))).toBe(reply);
    expect(said(spokenOf(reply.length))).toBe(reply);
    expect(spokenOf(5).length).toBeGreaterThan(spokenOf(reply.length).length);
  });

  test('a reply that is not an extension of the scanned text falls back and is reported', () => {
    const first = planHandsfreeSpeech({
      fullText: 'Hello there. Wor',
      streaming: true,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
    });
    expect(first.spoken).toBe('Hello there. ');
    // The cursor belongs to the text it was minted from: it is the proof that
    // this text extends the one already scanned. A text it does not fit — here
    // one that is shorter, as a rewrite or a new reply's own text would be —
    // makes the whole spoken prefix read as before, and the mutation named
    // rather than spoken.
    const mutated = planHandsfreeSpeech({
      fullText: 'Goodbye.',
      streaming: true,
      spoken: first.spoken,
      maxLength: 400,
      waitForCompletion: false,
      cursor: first.cursor,
    });
    expect(mutated.mutated).toBe(true);
    expect(mutated.chunks).toEqual([]);
    expect(mutated.spoken).toBe('');
    expect(mutated.cursor).toBeUndefined();
  });

  test('a shrunk reply falls back to the whole-prefix check and reports the mutation', () => {
    const first = planHandsfreeSpeech({
      fullText: 'Hello there. And more',
      streaming: true,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
    });
    const shrunk = planHandsfreeSpeech({
      fullText: 'Hello',
      streaming: true,
      spoken: first.spoken,
      maxLength: 400,
      waitForCompletion: false,
      cursor: first.cursor,
    });
    expect(shrunk.mutated).toBe(true);
  });

  test('a cursor from a longer reply is ignored rather than trusted', () => {
    const longer = planHandsfreeSpeech({
      fullText: 'Goodbye. Goodbye. ',
      streaming: true,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
    });
    const plan = planHandsfreeSpeech({
      fullText: 'Hello. ',
      streaming: true,
      spoken: 'Goodbye. ',
      maxLength: 400,
      waitForCompletion: false,
      cursor: longer.cursor,
    });
    expect(plan.mutated).toBe(true);
  });

  test('without a cursor the plan is the whole-reply scan again', () => {
    const input: PlanInput = {
      fullText: 'One. Two. Three.',
      streaming: true,
      spoken: 'One. ',
      maxLength: 400,
      waitForCompletion: false,
    };
    expect(speakable(planHandsfreeSpeech(input))).toEqual(speakable(referencePlan(input)));
  });

  test('a completed reply is spoken whole and needs no scan', () => {
    let examined = 0;
    const plan = planHandsfreeSpeech({
      fullText: 'One. Two. Three',
      streaming: false,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
      onExamine: (chars) => {
        examined += chars;
      },
    });
    expect(plan.chunks).toEqual(['One. Two. Three']);
    expect(examined).toBe(0);
  });
});

// A cursor's position is a position and nothing more: it says how far the scan
// read, not what it read. A reply rewritten under the cursor leaves it perfectly
// valid, so a planner that only compared positions would carry on speaking a
// message the Bot has taken back, from a sentence boundary that no longer exists.
// The cursor carries a digest of the text it settled for exactly this, and these
// pin that the check is really made.
describe('the cursor proves the reply is still append-only', () => {
  test('a rewrite inside the settled prefix is caught, and answers what the reference answers', () => {
    const first = planHandsfreeSpeech({
      fullText: 'Hello there. And more',
      streaming: true,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
    });
    expect(first.spoken).toBe('Hello there. ');
    expect(first.mutated).toBe(false);

    // Same length, same completed sentence, one character different in text the
    // scan has already walked: only the digest can say no.
    const input: PlanInput = {
      fullText: 'HELLO THERE. And more',
      streaming: true,
      spoken: first.spoken,
      maxLength: 400,
      waitForCompletion: false,
    };
    const { plan, expected } = both(input, first.cursor);
    expect(plan.mutated).toBe(true);
    expect(plan.chunks).toEqual([]);
    expect(plan.spoken).toBe('');
    // The cursor that proved nothing is dropped, so the next delta starts over.
    expect(plan.cursor).toBeUndefined();
    expect(speakable(plan)).toEqual(speakable(expected));
  });

  test('a rewrite of the scanned tail the words have not reached yet is caught as well', () => {
    // Deliberately stricter than the pre-change check, which compared only what
    // had been spoken: the sentence boundary the scan settled is only still a
    // sentence boundary while the text under it is unchanged, so a rewrite there
    // sends the turn to the same wait-for-completion fallback a spoken rewrite
    // does — for that turn, with the whole reply still spoken at the end.
    const first = planHandsfreeSpeech({
      fullText: 'Hello. World',
      streaming: true,
      spoken: '',
      maxLength: 400,
      waitForCompletion: false,
    });
    expect(first.spoken).toBe('Hello. ');
    const plan = planHandsfreeSpeech({
      fullText: 'Hello. Woxld',
      streaming: true,
      spoken: first.spoken,
      maxLength: 400,
      waitForCompletion: false,
      cursor: first.cursor,
    });
    expect(plan.mutated).toBe(true);
    // Where the spoken text alone still agrees — it is not the reply that broke.
    expect(referencePlan({
      fullText: 'Hello. Woxld',
      streaming: true,
      spoken: first.spoken,
      maxLength: 400,
      waitForCompletion: false,
    }).mutated).toBe(false);
  });

  test('a cursor whose digest is not this text’s is not trusted', () => {
    // A position that fits and a spoken prefix that still holds: only the digest
    // is left to disagree, and it is the one that has to be believed.
    const plan = planHandsfreeSpeech({
      fullText: 'Hello. World',
      streaming: true,
      spoken: 'Hello. ',
      maxLength: 400,
      waitForCompletion: false,
      cursor: { index: 12, boundary: 7, hash: 0 },
    });
    expect(plan.mutated).toBe(true);
    expect(plan.chunks).toEqual([]);
  });

  test('an append-only stream never trips the digest', () => {
    // Every delta of every generated reply, compared with the reference: a
    // digest that disagreed with a stream that only ever grew would silence the
    // turn's speech entirely, which is as broken as the miss above.
    let steps = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      const rand = lcg(seed * 7919 + 13);
      const reply = randomReply(rand, 5);
      let spoken = '';
      let cursor: HandsfreeSpeechCursor | undefined;
      for (let end = 1; end <= reply.length; end += 1) {
        const fullText = reply.slice(0, end);
        const input: PlanInput = {
          fullText,
          streaming: end < reply.length,
          spoken,
          maxLength: 240,
          waitForCompletion: false,
        };
        const plan = planHandsfreeSpeech({ ...input, cursor });
        expect(speakable(plan)).toEqual(speakable(referencePlan(input)));
        expect(plan.mutated).toBe(false);
        steps += 1;
        spoken = plan.spoken;
        cursor = plan.cursor;
      }
    }
    expect(steps).toBeGreaterThan(500);
  });

  test('deltas and in-place rewrites mixed still answer the reference, delta for delta', () => {
    // The defect was a rewrite the cursor could not see, so the mixed stream has
    // to contain some: every step is compared against the reference, and the
    // count is what proves the comparison was not vacuous.
    let rewrites = 0;
    let steps = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = lcg(seed * 104_729 + 5);
      const reply = randomReply(rand, 6);
      let fullText = '';
      let spoken = '';
      let cursor: HandsfreeSpeechCursor | undefined;
      let rewritesHere = 0;
      let rounds = 0;
      while (fullText.length < reply.length && rounds < 4 * reply.length) {
        rounds += 1;
        const rewrite =
          fullText.length > 0 &&
          spoken.length > 0 &&
          (rewritesHere < 3 ? rand() < 0.4 : rand() < 0.06);
        const next = rewrite
          ? rewriteSpoken(fullText, spoken, rand)
          : reply.slice(0, Math.min(reply.length, fullText.length + 1 + Math.floor(rand() * 9)));
        if (next === fullText) continue;
        if (next.length === fullText.length) rewritesHere += 1;
        fullText = next;
        const input: PlanInput = {
          fullText,
          streaming: fullText.length < reply.length,
          spoken,
          maxLength: 240,
          waitForCompletion: false,
        };
        const { plan, expected } = both(input, cursor);
        expect(speakable(plan)).toEqual(speakable(expected));
        steps += 1;
        if (plan.mutated) {
          spoken = '';
          cursor = undefined;
        } else {
          if (input.streaming) expect(plan.cursor?.index).toBe(fullText.length);
          spoken = plan.spoken;
          cursor = plan.cursor;
        }
      }
      rewrites += rewritesHere;
    }
    expect(steps).toBeGreaterThan(200);
    expect(rewrites).toBeGreaterThanOrEqual(36);
  });
});

describe('planHandsfreeSpeech — the work is proportional to the reply', () => {
  test('a 20 kB reply in 5-character deltas is read a small constant number of times', () => {
    const sentence = 'The build passed on the first try, so nothing else changed. ';
    const reply = sentence.repeat(Math.ceil(20_000 / sentence.length)).slice(0, 20_000);
    let examined = 0;
    let spoken = '';
    let cursor: HandsfreeSpeechCursor | undefined;

    for (let end = 5; end <= reply.length; end += 5) {
      const plan = planHandsfreeSpeech({
        fullText: reply.slice(0, end),
        streaming: end < reply.length,
        spoken,
        maxLength: 400,
        waitForCompletion: false,
        cursor,
        onExamine: (chars) => {
          examined += chars;
        },
      });
      spoken = plan.spoken;
      cursor = plan.cursor;
    }

    // Every character is read once on its way in, plus the handful of deltas
    // that re-check the spoken tail; the last delta is spoken whole rather than
    // scanned, so a few characters are never read at all. The whole-reply scan
    // read all of them 4000 times over. The counter measures the scan — the pass
    // with the per-character string work in it. Re-proving the settled prefix is
    // one integer fold per character and is deliberately not counted here: no
    // exact check of "did this text change" can be cheaper than reading the
    // characters it is about, and the whole-reply scan this replaced was paying
    // far more than one such pass per delta.
    expect(examined).toBeGreaterThan(reply.length - 10);
    expect(examined).toBeLessThan(reply.length * 3);
  });

  test('without the cursor the same reply costs quadratic reading', () => {
    const sentence = 'The build passed on the first try, so nothing else changed. ';
    const reply = sentence.repeat(Math.ceil(20_000 / sentence.length)).slice(0, 20_000);
    let examined = 0;
    let spoken = '';

    for (let end = 5; end <= reply.length; end += 5) {
      const plan = planHandsfreeSpeech({
        fullText: reply.slice(0, end),
        streaming: end < reply.length,
        spoken,
        maxLength: 400,
        waitForCompletion: false,
        onExamine: (chars) => {
          examined += chars;
        },
      });
      spoken = plan.spoken;
    }

    expect(examined).toBeGreaterThan(reply.length * 50);
  });
});