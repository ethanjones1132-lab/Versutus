import {
  finishRunTranscript,
  pushRunTranscriptEvent,
  RUN_TRANSCRIPT_EVENT_CAP,
  type RunTranscriptPage,
} from '@/lib/gateway/runs';
import type { RunEvent } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function event(index: number): RunEvent {
  return { type: 'tool.result', data: { step: index } };
}

function fold(count: number): { page: RunTranscriptPage; peak: number } {
  const page: RunTranscriptPage = { events: [], omitted: 0 };
  let peak = 0;
  for (let index = 0; index < count; index += 1) {
    pushRunTranscriptEvent(page, event(index));
    peak = Math.max(peak, page.events.length);
  }
  return { page: finishRunTranscript(page), peak };
}

describe('run transcript replay cap', () => {
  test('a 20 000-frame replay keeps the newest window and names the omitted count', () => {
    const { page } = fold(20_000);
    expect(page.events).toHaveLength(RUN_TRANSCRIPT_EVENT_CAP);
    expect(page.omitted).toBe(20_000 - RUN_TRANSCRIPT_EVENT_CAP);
    expect(page.events[0]?.data).toEqual({ step: 20_000 - RUN_TRANSCRIPT_EVENT_CAP });
    expect(page.events[page.events.length - 1]?.data).toEqual({ step: 19_999 });
  });

  test('peak held events never exceed twice the cap', () => {
    // Compacting in batches of `cap` is what keeps an 8 MiB SSE replay from
    // sitting in JS memory; one shift per overflow would still allocate the
    // dropped frames on the way through.
    const { peak } = fold(20_000);
    expect(peak).toBeLessThanOrEqual(RUN_TRANSCRIPT_EVENT_CAP * 2);
  });

  test('a replay that fits is unchanged', () => {
    const { page } = fold(3);
    expect(page.events).toHaveLength(3);
    expect(page.omitted).toBe(0);
    expect(page.events.map((item) => item.data)).toEqual([
      { step: 0 },
      { step: 1 },
      { step: 2 },
    ]);
  });

  test('loadRunEvents folds the stream through the capped buffer', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const impl = src.match(/const loadRunEvents = useCallback\([\s\S]*?\},\s*\[\]\);/)?.[0];
    expect(impl).toBeDefined();
    expect(impl).toMatch(/pushRunTranscriptEvent\(page, event\)/);
    expect(impl).toMatch(/return finishRunTranscript\(page\)/);
    expect(impl).not.toMatch(/collected\.push\(event\)/);
  });
});
