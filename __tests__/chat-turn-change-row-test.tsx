// VS-094, slice 3: the per-turn change row, rendered.
//
// Every case is fixture-only: a Map stands in for the device store, the journal
// is an injected fetcher, and no network or Gate is touched. Each assertion is
// about what the thread shows for a record — the copy, the expansion, the
// stable unavailable line, and the absence of a row when there is nothing to
// say.
//
// Before this slice nothing rendered a change row at all, so every test here
// fails against the old code.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The kit primitives keep their props verbatim, so a test can read what the row
// actually emitted without a native surface.
jest.mock('@/components/ui', () => ({
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));

jest.mock('@/constants/tokens', () => ({
  Radius: { md: 8 },
  Spacing: { one: 4, half: 2, two: 8 },
}));

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ backgroundInset: '#111111' }),
}));

import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TurnChangeRow } from '@/components/chat/turn-change-row';
import type { TurnJournalRecord } from '@/lib/chat/turn-change-collector';
import { resolveTurnChangeRowState } from '@/lib/chat/turn-change-row-state';
import type { TurnChangeFile, TurnChangeRecord } from '@/lib/chat/turn-changes';
import { toTurnChangeSummary } from '@/lib/chat/turn-changes';
import { createTurnChangeStore, type TurnChangeStorage } from '@/lib/chat/turn-change-store';
import type { ChatMessage } from '@/lib/gateway/types';

function memoryStorage(): TurnChangeStorage {
  const data = new Map<string, string>();
  return {
    async getItem(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      data.delete(key);
    },
    async getAllKeys(): Promise<string[]> {
      return [...data.keys()];
    },
  };
}

function makeFile(path: string, overrides: Partial<TurnChangeFile> = {}): TurnChangeFile {
  return { path, status: 'modified', evidence: 'diff', callIds: [], ...overrides };
}

function makeRecord(overrides: Partial<TurnChangeRecord> = {}): TurnChangeRecord {
  return {
    v: 1,
    turnId: 'turn-1',
    sessionId: 'session-1',
    backendId: 'opencode',
    startedAt: 1000,
    endedAt: 2000,
    files: [
      makeFile('src/a.ts', { additions: 5, deletions: 1, callIds: ['c1'] }),
      makeFile('src/b.ts', { status: 'added', additions: 1, deletions: 0 }),
    ],
    truncated: false,
    omitted: 0,
    ...overrides,
  };
}

function journal(overrides: Partial<TurnJournalRecord> = {}): TurnJournalRecord {
  return {
    turnId: 'turn-live',
    sessionId: 'session-1',
    backendId: 'claude',
    status: 'running',
    startedAt: 1000,
    updatedAt: 1500,
    ...overrides,
  };
}

function writeMessage(turnId: string): ChatMessage {
  return {
    id: `bubble-${turnId}`,
    role: 'assistant',
    text: '',
    turnId,
    timestamp: 1200,
    toolCalls: [
      {
        id: 'call-write',
        name: 'Write',
        detail: JSON.stringify({ file_path: 'src/a.ts', content: 'SECRET CONTENT' }),
      },
    ],
  };
}

/** Text children flattened into one string; the kit's Text takes strings here. */
function textContent(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textContent).join('');
  return '';
}

function textNodes(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => textContent(node.props.children));
}

function summaryButton(renderer: ReactTestRenderer): ReactTestInstance {
  const buttons = renderer.root.findAll(
    (node) => (node.type as unknown) === 'PressableScale'
      && node.props.accessibilityRole === 'button',
  );
  expect(buttons).toHaveLength(1);
  return buttons[0];
}

type RowProps = ComponentProps<typeof TurnChangeRow>;

async function renderRow(props: RowProps): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(TurnChangeRow, props));
  });
  // Let the store read settle, so the row shows its answer rather than the
  // in-flight nothing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
  return renderer;
}

async function expand(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    summaryButton(renderer).props.onPress();
  });
}

describe('turn change row — a stored record', () => {
  test('renders the record summary under the finished turn', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    await store.save(makeRecord());

    const renderer = await renderRow({ turnId: 'turn-1', store });

    expect(textNodes(renderer)).toContain('2 files changed \u00b7 +6 \u22121');
  });

  test('expands to paths, status labels and diff counts only', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    await store.save(makeRecord());

    const renderer = await renderRow({ turnId: 'turn-1', store });
    await expand(renderer);

    const texts = textNodes(renderer);
    expect(texts).toEqual(
      expect.arrayContaining([
        'src/a.ts',
        'Modified',
        '+5 \u22121',
        'src/b.ts',
        'Added',
        '+1 \u22120',
      ]),
    );
    expect(summaryButton(renderer).props.accessibilityState).toEqual({ expanded: true });
  });

  test('a tool-only file says Touched and wears no invented counts', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    await store.save(makeRecord({
      files: [makeFile('src/tool.ts', { status: 'unknown', evidence: 'tool', callIds: ['c9'] })],
    }));

    const renderer = await renderRow({ turnId: 'turn-1', store });
    // The summary already says "touched"; the expansion must not add a `+N −M`.
    expect(textNodes(renderer)).toContain('1 file touched');

    await expand(renderer);

    const texts = textNodes(renderer);
    expect(texts).toEqual(
      expect.arrayContaining(['src/tool.ts', 'Touched', 'The backend reports tool calls, not a diff']),
    );
    expect(texts.some((text) => /^\+\d/.test(text))).toBe(false);
    expect(texts.some((text) => text.includes('\u2212'))).toBe(false);
  });

  test('a capped record says "and N more" instead of listing dropped paths', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    await store.save(makeRecord({
      files: [makeFile('src/a.ts', { additions: 1, deletions: 0 })],
      truncated: true,
      omitted: 3,
    }));

    const renderer = await renderRow({ turnId: 'turn-1', store });
    expect(textNodes(renderer)).toContain('1 file changed \u00b7 +1 \u22120 \u00b7 and 3 more');

    await expand(renderer);
    // The summary still carries the count; the expanded list repeats it once
    // and never guesses at the three paths it cannot name.
    expect(
      textNodes(renderer).filter((text) => text.includes('and 3 more')),
    ).toHaveLength(2);
  });
});

describe('turn change row — honest absence', () => {
  test('the store returning null prints the stable unavailable line', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });

    const renderer = await renderRow({ turnId: 'turn-missing', store });

    expect(textNodes(renderer)).toContain('Changes are unavailable for this turn');
  });

  test('an empty record renders no row at all', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    await store.save(makeRecord({ files: [] }));

    const renderer = await renderRow({ turnId: 'turn-1', store });

    expect(renderer.toJSON()).toBeNull();
  });

  test('a turn with no id renders nothing and never asks the store', async () => {
    const load = jest.fn(async () => null);
    const renderer = await renderRow({ store: { load } });

    expect(renderer.toJSON()).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('turn change row — the two seams', () => {
  test('a finished turn reads the store and never the journal', async () => {
    const load = jest.fn(async () => null);
    const readJournalMeta = jest.fn(async () => journal());

    const state = await resolveTurnChangeRowState({
      turnId: 'turn-1',
      streaming: false,
      store: { load },
      readJournalMeta,
    });

    expect(state).toEqual({ status: 'unavailable' });
    expect(load).toHaveBeenCalledWith('turn-1');
    expect(readJournalMeta).not.toHaveBeenCalled();
  });

  test('a streaming turn collects from the journal and never the store', async () => {
    const load = jest.fn(async () => null);

    const state = await resolveTurnChangeRowState({
      turnId: 'turn-live',
      streaming: true,
      sessionId: 'session-1',
      backendId: 'claude',
      messages: [writeMessage('turn-live')],
      store: { load },
      readJournalMeta: async () => journal(),
    });

    expect(load).not.toHaveBeenCalled();
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.record.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['call-write'] },
    ]);
    expect(toTurnChangeSummary(state.record)).toEqual({
      label: '1 file touched',
      tone: 'neutral',
    });
  });

  test('a streaming turn renders journal evidence through the hook, not the store', async () => {
    const store = createTurnChangeStore({ storage: memoryStorage(), now: () => 10_000 });
    const load = jest.spyOn(store, 'load');

    const renderer = await renderRow({
      turnId: 'turn-live',
      streaming: true,
      sessionId: 'session-1',
      backendId: 'claude',
      messages: [writeMessage('turn-live')],
      store,
      readJournalMeta: async () => journal(),
    });

    expect(textNodes(renderer)).toContain('1 file touched');
    expect(load).not.toHaveBeenCalled();
  });

  test('a streaming turn with no journal reader shows nothing, not "unavailable"', async () => {
    const load = jest.fn(async () => null);

    const state = await resolveTurnChangeRowState({
      turnId: 'turn-live',
      streaming: true,
      store: { load },
    });

    expect(state).toEqual({ status: 'none' });
    expect(load).not.toHaveBeenCalled();
  });
});
