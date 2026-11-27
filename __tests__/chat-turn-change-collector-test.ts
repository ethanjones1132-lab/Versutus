// VS-094, slice 2: the collector that joins a turn's live frames to its
// journal window.
//
// Every test is fixture-only: no network, no device, no Gate process. The
// journal is the injected fetcher; the frames are what the stream reducer
// emitted. Each case fails against the code before this slice existed, where
// nothing produced a record at all.

import type { ChatMessage } from '@/lib/gateway/types';
import type {
  TurnChangeFrame,
  TurnJournalMetaFetcher,
  TurnJournalRecord,
} from '@/lib/chat/turn-change-collector';
import {
  collectTurnChanges,
  collectTurnChangesFromJournal,
} from '@/lib/chat/turn-change-collector';
import type { TurnDiffRow } from '@/lib/chat/turn-changes';
import {
  serializeTurnChangeRecord,
  toTurnChangeSummary,
} from '@/lib/chat/turn-changes';

function journal(overrides: Partial<TurnJournalRecord> = {}): TurnJournalRecord {
  return {
    turnId: 'turn-1',
    sessionId: 'session-1',
    backendId: 'opencode',
    status: 'done',
    startedAt: 1000,
    updatedAt: 1500,
    finishedAt: 2000,
    ...overrides,
  };
}

function fetcher(meta: TurnJournalRecord | null): TurnJournalMetaFetcher {
  return async () => meta;
}

function message(
  turnId: string,
  timestamp: number,
  toolCalls: NonNullable<ChatMessage['toolCalls']>,
): ChatMessage {
  return {
    id: `bubble-${turnId}-${timestamp}`,
    role: 'assistant',
    text: '',
    turnId,
    timestamp,
    toolCalls,
  };
}

describe('collectTurnChanges — Claude tool-only', () => {
  test('a Write is touched, a Read and a Bash cat are not, and detail never survives', async () => {
    const meta = journal({
      turnId: 'turn-claude',
      sessionId: 'session-claude',
      backendId: 'claude',
    });
    const messages = [
      message('turn-claude', 1200, [
        {
          id: 'call-write',
          name: 'Write',
          detail: JSON.stringify({ file_path: 'src/a.ts', content: 'SECRET CONTENT' }),
        },
        {
          id: 'call-read',
          name: 'Read',
          detail: JSON.stringify({ file_path: 'src/b.ts' }),
        },
        {
          id: 'call-bash',
          name: 'Bash',
          detail: JSON.stringify({ command: 'cat src/c.ts' }),
        },
      ]),
    ];

    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-claude',
      messages,
      readJournalMeta: fetcher(meta),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.turnId).toBe('turn-claude');
    expect(record.sessionId).toBe('session-claude');
    expect(record.backendId).toBe('claude');
    expect(record.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['call-write'] },
    ]);
    expect([record.startedAt, record.endedAt]).toEqual([1000, 2000]);
    expect(toTurnChangeSummary(record)).toEqual({ label: '1 file touched', tone: 'neutral' });

    // The record is paths and counts only: the Write's whole-file content must
    // not reach even the serialised form the store would persist.
    const stored = serializeTurnChangeRecord(record);
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toMatch(/"(content|patch|detail|output)":/);
  });
});

describe('collectTurnChanges — Codex weak evidence', () => {
  test('a shell redirection is a weak touched row and result output is never mined', async () => {
    const meta = journal({
      turnId: 'turn-codex',
      sessionId: 'session-codex',
      backendId: 'codex',
    });
    const frames: TurnChangeFrame[] = [
      { turnId: 'turn-codex', at: 1200, id: 'call-exec', name: 'exec', detail: 'echo x > src/a.ts' },
      { turnId: 'turn-codex', at: 1250, id: 'call-ls', name: 'exec', detail: 'ls src' },
      // A completion frame carries the tool's output, which can name a path it
      // only read. It keeps its timestamp for the window and adds no path.
      {
        turnId: 'turn-codex',
        at: 1300,
        id: 'call-exec',
        name: 'exec',
        kind: 'completed',
        detail: 'wrote src/nope.ts',
      },
    ];

    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-codex',
      frames,
      readJournalMeta: fetcher(meta),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['call-exec'] },
    ]);
    expect(toTurnChangeSummary(record)).toEqual({ label: '1 file touched', tone: 'neutral' });
  });
});

describe('collectTurnChanges — OpenCode tool plus diff', () => {
  test('a moved diff row is promoted, a diff-only row stays unattributed, a patch is not stored', async () => {
    const meta = journal({
      turnId: 'turn-oc',
      sessionId: 'session-oc',
      backendId: 'opencode',
      startedAt: 1000,
      updatedAt: 1400,
      finishedAt: 2000,
    });
    const frames: TurnChangeFrame[] = [
      {
        turnId: 'turn-oc',
        at: 1100,
        id: 'call-edit',
        name: 'edit',
        detail: JSON.stringify({ filePath: 'src/a.ts', oldString: 'x', newString: 'y' }),
      },
      {
        turnId: 'turn-oc',
        at: 1150,
        id: 'call-read',
        name: 'read',
        detail: JSON.stringify({ filePath: 'src/ignored.ts' }),
      },
    ];
    const diffBefore: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, patch: '' },
    ];
    const diffAfter: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1, patch: '@@ SECRET PATCH' },
      { path: 'src/c.ts', status: 'added', additions: 2, deletions: 0, patch: '@@ OTHER' },
    ];

    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-oc',
      frames,
      diffBefore,
      diffAfter,
      readJournalMeta: fetcher(meta),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.files).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 4,
        deletions: 1,
        evidence: 'diff',
        callIds: ['call-edit'],
      },
      {
        path: 'src/c.ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        evidence: 'diff',
        callIds: [],
      },
    ]);
    expect(toTurnChangeSummary(record)).toEqual({
      label: '2 files changed · +6 −1',
      tone: 'neutral',
    });
    expect(serializeTurnChangeRecord(record)).not.toContain('SECRET');
  });
});

describe('collectTurnChanges — identity and replay', () => {
  test('a resumed turn replayed through frames and messages yields one record', () => {
    const frames: TurnChangeFrame[] = [
      { turnId: 'turn-1', at: 1200, id: 'call-edit', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
      { turnId: 'turn-1', at: 1200, id: 'call-edit', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
    ];
    const messages = [
      message('turn-1', 1200, [
        { id: 'call-edit', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
      ]),
    ];
    const input = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'opencode',
      frames,
      messages,
      journalMeta: journal(),
    };

    const first = collectTurnChanges(input);
    const replay = collectTurnChanges(input);

    expect(first).not.toBeNull();
    if (!first || !replay) return;
    expect(first.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['call-edit'] },
    ]);
    expect(replay).toEqual(first);
    expect(serializeTurnChangeRecord(replay)).toBe(serializeTurnChangeRecord(first));
  });

  test('a frame or message naming another turn is not merged', () => {
    const record = collectTurnChanges({
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'opencode',
      frames: [
        { turnId: 'turn-1', at: 1200, id: 'c1', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
        { turnId: 'turn-other', at: 1210, id: 'c2', name: 'edit', detail: '{"filePath":"src/other.ts"}' },
      ],
      messages: [
        message('turn-other', 1220, [
          { id: 'c3', name: 'edit', detail: '{"filePath":"src/foreign.ts"}' },
        ]),
      ],
      journalMeta: journal(),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  test('a journal row for a different turn licenses no window', () => {
    const record = collectTurnChanges({
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'opencode',
      frames: [
        { turnId: 'turn-1', at: 1200, id: 'c1', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
      ],
      journalMeta: journal({ turnId: 'turn-other' }),
    });

    expect(record).toBeNull();
  });

  test('a window with no write-like call is an empty record, not an unavailable one', () => {
    const record = collectTurnChanges({
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'claude',
      frames: [
        { turnId: 'turn-1', at: 1200, id: 'c1', name: 'Read', detail: '{"file_path":"src/a.ts"}' },
      ],
      journalMeta: journal({ backendId: 'claude' }),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.files).toEqual([]);
    expect(toTurnChangeSummary(record)).toBeNull();
  });
});

describe('collectTurnChangesFromJournal — the journal seam', () => {
  test('a refused journal read yields no record rather than an empty one', async () => {
    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'claude',
      frames: [
        { turnId: 'turn-1', at: 1200, id: 'c1', name: 'Write', detail: '{"file_path":"src/a.ts"}' },
      ],
      readJournalMeta: async () => {
        throw new Error('403 forbidden');
      },
    });

    expect(record).toBeNull();
  });

  test('a missing journal falls back to the observed frame window', async () => {
    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-1',
      sessionId: 'session-1',
      backendId: 'claude',
      frames: [
        { turnId: 'turn-1', at: 1200, id: 'c1', name: 'Write', detail: '{"file_path":"src/a.ts"}' },
        { turnId: 'turn-1', at: 1500, id: 'c2', name: 'Read', detail: '{"file_path":"src/b.ts"}' },
      ],
      readJournalMeta: fetcher(null),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect([record.startedAt, record.endedAt]).toEqual([1200, 1500]);
    expect(record.files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  test('the journal supplies identity and the running window from updatedAt', async () => {
    const record = await collectTurnChangesFromJournal({
      turnId: 'turn-1',
      messages: [
        message('turn-1', 1200, [
          { id: 'c1', name: 'edit', detail: '{"filePath":"src/a.ts"}' },
        ]),
      ],
      readJournalMeta: fetcher(journal({
        turnId: 'turn-1',
        sessionId: 'session-from-journal',
        backendId: 'opencode',
        status: 'running',
        startedAt: 1000,
        updatedAt: 1600,
        finishedAt: null,
      })),
    });

    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.sessionId).toBe('session-from-journal');
    expect([record.startedAt, record.endedAt]).toEqual([1000, 1600]);
  });
});
