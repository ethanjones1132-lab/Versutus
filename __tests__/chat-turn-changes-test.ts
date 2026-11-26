// VS-094, slice 1: the fixture table from
// docs/plans/2026-11-26-turn-change-list-design.md section 5.
//
// Everything here is pure: no network, no device, no Gate process. Each test
// pins a claim the design makes, so an empty or "helpful" stub fails it.

import type {
  FileEvidenceConfidence,
  FileEvidenceInput,
  FileEvidenceKind,
  TurnChangeFile,
  TurnChangeRecord,
  TurnDiffRow,
  TurnObservation,
  TurnObservations,
} from '@/lib/chat/turn-changes';
import {
  boundTurn,
  capTurnChanges,
  extractFileEvidence,
  mergeTurnEvidence,
  parseTurnChangeRecord,
  serializeTurnChangeRecord,
  toTurnChangeSummary,
} from '@/lib/chat/turn-changes';

function makeRecord(overrides: Partial<TurnChangeRecord> = {}): TurnChangeRecord {
  return {
    v: 1,
    turnId: 'turn-1',
    sessionId: 'session-1',
    backendId: 'opencode',
    startedAt: 1000,
    endedAt: 2000,
    files: [],
    truncated: false,
    omitted: 0,
    ...overrides,
  };
}

function makeFile(path: string, overrides: Partial<TurnChangeFile> = {}): TurnChangeFile {
  return { path, status: 'modified', evidence: 'diff', callIds: [], ...overrides };
}

function makeObservation(
  path: string,
  overrides: Partial<Omit<TurnObservation, 'path'>> = {},
): TurnObservation {
  return { path, tool: 'edit', kind: 'write', confidence: 'strong', ...overrides };
}

function makeObservations(
  items: TurnObservation[],
  overrides: Partial<Omit<TurnObservations, 'items'>> = {},
): TurnObservations {
  return {
    turnId: 'turn-1',
    sessionId: 'session-1',
    backendId: 'opencode',
    startedAt: 1000,
    endedAt: 2000,
    items,
    ...overrides,
  };
}

function message(turnId: string, timestamp?: number) {
  return { turnId, ...(timestamp !== undefined ? { timestamp } : {}) };
}

function byteLength(value: string): number {
  let total = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return total;
}

type ExtractFixture = {
  label: string;
  backend: string;
  name: string;
  detail: FileEvidenceInput['detail'];
  paths: string[];
  kind: FileEvidenceKind | null;
  confidence: FileEvidenceConfidence;
  writeLike: boolean;
};

const EXTRACT_FIXTURES: ExtractFixture[] = [
  {
    label: 'Claude Write names file_path and is a strong write',
    backend: 'claude',
    name: 'Write',
    detail: { file_path: 'src/a.ts', content: 'placeholder-not-stored' },
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'strong',
    writeLike: true,
  },
  {
    label: 'Claude Edit names file_path in JSON detail',
    backend: 'claude',
    name: 'Edit',
    detail: '{"file_path":"src/b.ts","old_string":"a","new_string":"b"}',
    paths: ['src/b.ts'],
    kind: 'write',
    confidence: 'strong',
    writeLike: true,
  },
  {
    label: 'Claude Read is not a change',
    backend: 'claude',
    name: 'Read',
    detail: { file_path: 'src/b.ts' },
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Claude Grep is not a change',
    backend: 'claude',
    name: 'Grep',
    detail: { pattern: 'needle', path: 'src' },
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Claude Glob is not a change',
    backend: 'claude',
    name: 'Glob',
    detail: { pattern: 'src/**/*.ts' },
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Claude Bash cat is not a change',
    backend: 'claude',
    name: 'Bash',
    detail: { command: 'cat src/a.ts' },
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Codex exec redirection is a weak write',
    backend: 'codex',
    name: 'exec',
    detail: { command: 'echo x > src/a.ts' },
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'weak',
    writeLike: true,
  },
  {
    label: 'Codex plain exec is not a change',
    backend: 'codex',
    name: 'exec',
    detail: 'ls src',
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Codex truncated JSON never yields a half path',
    backend: 'codex',
    name: 'exec',
    detail: '{"command":"echo x > src/a.t',
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Codex argv array redirection is a weak write',
    backend: 'codex',
    name: 'exec',
    detail: '["bash","-lc","echo x > src/a.ts"]',
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'weak',
    writeLike: true,
  },
  {
    label: 'OpenCode edit names filePath',
    backend: 'opencode',
    name: 'edit',
    detail: { filePath: 'src/d.ts', oldString: 'x', newString: 'y' },
    paths: ['src/d.ts'],
    kind: 'write',
    confidence: 'strong',
    writeLike: true,
  },
  {
    label: 'OpenCode truncated JSON never yields a half path',
    backend: 'opencode',
    name: 'edit',
    detail: '{"filePath":"src/a.t',
    paths: [],
    kind: null,
    confidence: 'none',
    writeLike: false,
  },
  {
    label: 'Windows absolute path normalises to workspace-relative',
    backend: 'claude',
    name: 'Write',
    detail: { file_path: 'C:\\repo\\src\\a.ts' },
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'strong',
    writeLike: true,
  },
  {
    label: 'a home-directory prefix does not ride into the stored path',
    backend: 'opencode',
    name: 'edit',
    detail: { filePath: 'C:\\Users\\ethan\\proj\\src\\a.ts' },
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'strong',
    writeLike: true,
  },
  {
    label: 'duplicate paths in one call collapse once',
    backend: 'codex',
    name: 'exec',
    detail: { command: 'echo x > src/a.ts; echo y >> src/a.ts' },
    paths: ['src/a.ts'],
    kind: 'write',
    confidence: 'weak',
    writeLike: true,
  },
];

function comparable(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function detailText(detail: FileEvidenceInput['detail']): string {
  if (typeof detail === 'string') return detail;
  return detail ? JSON.stringify(detail) : '';
}

describe('extractFileEvidence', () => {
  for (const fixture of EXTRACT_FIXTURES) {
    test(fixture.label, () => {
      const result = extractFileEvidence({
        backend: fixture.backend,
        name: fixture.name,
        detail: fixture.detail,
      });
      expect(result.paths).toEqual(fixture.paths);
      expect(result.kind).toBe(fixture.kind);
      expect(result.confidence).toBe(fixture.confidence);
    });
  }

  test('a Write result never carries the file content it was given', () => {
    const result = extractFileEvidence({
      backend: 'claude',
      name: 'Write',
      detail: { file_path: 'src/a.ts', content: 'placeholder-not-stored' },
    });

    expect(result).toEqual({ paths: ['src/a.ts'], kind: 'write', confidence: 'strong' });
    expect(Object.keys(result)).not.toContain('content');
    expect(JSON.stringify(result)).not.toContain('placeholder-not-stored');
  });

  test('a tool named Write by another backend is not guessed at', () => {
    const result = extractFileEvidence({
      backend: 'codex',
      name: 'Write',
      detail: { file_path: 'src/a.ts' },
    });
    expect(result.paths).toEqual([]);
  });
});

describe('boundTurn', () => {
  test('finishedAt wins over updatedAt and frame timestamps', () => {
    const window = boundTurn({
      messages: [message('turn-1', 1200), message('turn-1', 1500)],
      journalMeta: {
        turnId: 'turn-1',
        status: 'complete',
        startedAt: 1000,
        updatedAt: 1500,
        finishedAt: 2000,
      },
    });

    expect(window).toEqual({ turnId: 'turn-1', startedAt: 1000, endedAt: 2000 });
  });

  test('a running turn ends at updatedAt', () => {
    const window = boundTurn({
      messages: [message('turn-1', 1200)],
      journalMeta: {
        turnId: 'turn-1',
        status: 'running',
        startedAt: 1000,
        updatedAt: 1600,
        finishedAt: null,
      },
    });

    expect(window).toEqual({ turnId: 'turn-1', startedAt: 1000, endedAt: 1600 });
  });

  test('no timestamps anywhere means no window', () => {
    expect(boundTurn({ messages: [{ turnId: 'turn-1' }], journalMeta: null })).toBeNull();
    expect(boundTurn({
      messages: [message('turn-1')],
      journalMeta: { turnId: 'turn-1', status: 'running' },
    })).toBeNull();
    expect(boundTurn({ messages: [], journalMeta: null })).toBeNull();
  });

  test('a reconnect replay yields one window', () => {
    const replay = [
      message('turn-1', 1200),
      message('turn-1', 1300),
      message('turn-1', 1200),
      message('turn-1', 1300),
    ];

    expect(boundTurn({ messages: replay, journalMeta: null })).toEqual({
      turnId: 'turn-1',
      startedAt: 1200,
      endedAt: 1300,
    });
    expect(boundTurn({
      messages: replay,
      journalMeta: {
        turnId: 'turn-1',
        status: 'complete',
        startedAt: 1000,
        updatedAt: 1400,
        finishedAt: 2000,
      },
    })).toEqual({ turnId: 'turn-1', startedAt: 1000, endedAt: 2000 });
  });

  test('a first frame earlier than startedAt clamps to the journal start', () => {
    const window = boundTurn({
      messages: [message('turn-1', 900), message('turn-1', 1100)],
      journalMeta: {
        turnId: 'turn-1',
        status: 'complete',
        startedAt: 1000,
        updatedAt: 1800,
        finishedAt: null,
      },
    });

    expect(window).toEqual({ turnId: 'turn-1', startedAt: 1000, endedAt: 1800 });
  });
});

describe('mergeTurnEvidence', () => {
  test('tool and diff promote a row to diff evidence with the diff counts', () => {
    const before: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, patch: '' },
    ];
    const after: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1, patch: '@@' },
    ];

    const record = mergeTurnEvidence(
      makeObservations([makeObservation('src/a.ts', { callId: 'c1', seenAt: 1200 })]),
      before,
      after,
    );

    expect(record.files).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 4,
        deletions: 1,
        evidence: 'diff',
        callIds: ['c1'],
      },
    ]);
  });

  test('a diff-only row is kept but stays unattributed', () => {
    const record = mergeTurnEvidence(
      makeObservations([]),
      [],
      [{ path: 'src/c.ts', status: 'added', additions: 2, deletions: 0 }],
    );

    expect(record.files).toEqual([
      {
        path: 'src/c.ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        evidence: 'diff',
        callIds: [],
      },
    ]);
  });

  test('tool-only evidence is unknown status with no counts', () => {
    const record = mergeTurnEvidence(
      makeObservations([makeObservation('src/a.ts', { callId: 'c1' })]),
      null,
      [{ path: 'src/a.ts', status: 'modified', additions: 9, deletions: 9 }],
    );

    const file = record.files[0];
    expect(file).toEqual({
      path: 'src/a.ts',
      status: 'unknown',
      evidence: 'tool',
      callIds: ['c1'],
    });
    expect(file).not.toHaveProperty('additions');
    expect(file).not.toHaveProperty('deletions');
  });

  test('a path that disappeared from the diff is a delete', () => {
    const record = mergeTurnEvidence(
      makeObservations([]),
      [{ path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 }],
      [],
    );

    expect(record.files).toEqual([
      { path: 'src/b.ts', status: 'deleted', evidence: 'diff', callIds: [] },
    ]);
  });

  test('a rename becomes a delete plus an add', () => {
    const record = mergeTurnEvidence(
      makeObservations([]),
      [{ path: 'src/old.ts', status: 'modified', additions: 1, deletions: 1 }],
      [{ path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts', additions: 5, deletions: 2 }],
    );

    expect(record.files).toEqual([
      {
        path: 'src/new.ts',
        status: 'added',
        additions: 5,
        deletions: 2,
        evidence: 'diff',
        callIds: [],
      },
      { path: 'src/old.ts', status: 'deleted', evidence: 'diff', callIds: [] },
    ]);
  });

  test('a missing pre-snapshot leaves every row tool-only', () => {
    const record = mergeTurnEvidence(
      makeObservations([makeObservation('src/a.ts', { callId: 'c1' })]),
      null,
      [{ path: 'src/a.ts', status: 'added', additions: 7, deletions: 0 }],
    );

    expect(record.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['c1'] },
    ]);
  });

  test('a diff that did not move cannot promote a touched file', () => {
    const row: TurnDiffRow = { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 };
    const record = mergeTurnEvidence(
      makeObservations([makeObservation('src/a.ts', { callId: 'c1' })]),
      [row],
      [{ ...row }],
    );

    expect(record.files).toEqual([
      { path: 'src/a.ts', status: 'unknown', evidence: 'tool', callIds: ['c1'] },
    ]);
  });

  test('duplicate callIds merge once and are sorted', () => {
    const record = mergeTurnEvidence(
      makeObservations([
        makeObservation('src/a.ts', { callId: 'c2' }),
        makeObservation('src/a.ts', { callId: 'c1' }),
        makeObservation('src/a.ts', { callId: 'c2' }),
      ]),
      null,
      null,
    );

    expect(record.files).toHaveLength(1);
    expect(record.files[0]?.callIds).toEqual(['c1', 'c2']);
  });

  test('replaying the same observations twice is byte-identical', () => {
    const observations = makeObservations([
      makeObservation('src/b.ts', { callId: 'c2', seenAt: 1400 }),
      makeObservation('src/a.ts', { callId: 'c1', seenAt: 1200 }),
    ]);
    const before: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0 },
    ];
    const after: TurnDiffRow[] = [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/c.ts', status: 'added', additions: 1, deletions: 0 },
    ];

    const first = mergeTurnEvidence(observations, before, after);
    const replay = mergeTurnEvidence(observations, before, after);

    expect(serializeTurnChangeRecord(replay)).toBe(serializeTurnChangeRecord(first));
    expect(replay).toEqual(first);
  });
  test('a turn whose only call was a Read produces no row', () => {
    const evidence = extractFileEvidence({
      backend: 'claude',
      name: 'Read',
      detail: { file_path: 'src/b.ts' },
    });
    const items: TurnObservation[] = evidence.paths.map((path) => ({
      path,
      tool: 'Read',
      kind: evidence.kind ?? 'write',
      confidence: evidence.confidence,
    }));

    const record = mergeTurnEvidence(makeObservations(items), null, null);
    expect(record.files).toEqual([]);
    expect(toTurnChangeSummary(record)).toBeNull();
  });

  test('the window comes from the journal bundle and falls back to seenAt', () => {
    const fromBundle = mergeTurnEvidence(
      makeObservations([makeObservation('src/a.ts', { seenAt: 1200 })], {
        startedAt: 1000,
        endedAt: 2000,
      }),
      null,
      null,
    );
    expect([fromBundle.startedAt, fromBundle.endedAt]).toEqual([1000, 2000]);

    const fromSeen = mergeTurnEvidence(
      makeObservations([
        makeObservation('src/a.ts', { seenAt: 1200 }),
        makeObservation('src/b.ts', { seenAt: 1500 }),
      ], { startedAt: undefined, endedAt: undefined }),
      null,
      null,
    );
    expect([fromSeen.startedAt, fromSeen.endedAt]).toEqual([1200, 1500]);
  });
});

describe('capTurnChanges', () => {
  test('keeps exactly 200 paths and counts the rest as omitted', () => {
    const files = Array.from({ length: 250 }, (_, index) =>
      makeFile(`src/f${String(index).padStart(3, '0')}.ts`));
    const capped = capTurnChanges(makeRecord({ files }), { maxPaths: 200 });

    expect(capped.files).toHaveLength(200);
    expect(capped.truncated).toBe(true);
    expect(capped.omitted).toBe(50);
    expect(capped.files.map((file) => file.path))
      .toEqual(files.map((file) => file.path).sort().slice(0, 200));
  });

  test('exactly 200 paths is not truncation', () => {
    const files = Array.from({ length: 200 }, (_, index) =>
      makeFile(`src/f${String(index).padStart(3, '0')}.ts`));
    const capped = capTurnChanges(makeRecord({ files }), { maxPaths: 200 });

    expect(capped.files).toHaveLength(200);
    expect(capped.truncated).toBe(false);
    expect(capped.omitted).toBe(0);
  });

  test('sorts deterministically before truncating', () => {
    const capped = capTurnChanges(makeRecord({
      files: [makeFile('src/b.ts'), makeFile('src/a.ts')],
    }));

    expect(capped.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('drops a path longer than 512 characters', () => {
    const atLimit = `src/${'a'.repeat(508)}`;
    const tooLong = `src/${'a'.repeat(509)}`;
    const capped = capTurnChanges(makeRecord({
      files: [makeFile(tooLong), makeFile(atLimit)],
    }));

    expect(atLimit).toHaveLength(512);
    expect(tooLong).toHaveLength(513);
    expect(capped.files.map((file) => file.path)).toEqual([atLimit]);
    expect(capped.omitted).toBe(1);
    expect(capped.truncated).toBe(true);
  });

  test('the default 32 KB cap trims by serialized bytes', () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      makeFile(`src/${'x'.repeat(300)}-${index}.ts`));
    const capped = capTurnChanges(makeRecord({ files }));

    expect(capped.files.length).toBeLessThan(files.length);
    expect(capped.omitted).toBe(files.length - capped.files.length);
    expect(capped.truncated).toBe(true);
    expect(byteLength(serializeTurnChangeRecord(capped))).toBeLessThanOrEqual(32 * 1024);
  });

  test('an exact byte boundary is kept, one byte less drops the row', () => {
    const record = makeRecord({
      files: [makeFile('src/café.ts', { additions: 1, deletions: 0 })],
    });
    const exact = byteLength(serializeTurnChangeRecord(record));

    const atBoundary = capTurnChanges(record, { maxBytes: exact });
    expect(atBoundary.files).toHaveLength(1);
    expect(atBoundary.truncated).toBe(false);
    expect(atBoundary.omitted).toBe(0);

    // `é` is one UTF-16 unit but two UTF-8 bytes: a character-counting cap
    // would keep the file here and pass the wrong branch.
    const overByOne = capTurnChanges(record, { maxBytes: exact - 1 });
    expect(overByOne.files).toHaveLength(0);
    expect(overByOne.truncated).toBe(true);
    expect(overByOne.omitted).toBe(1);
  });
});

describe('toTurnChangeSummary', () => {
  test('one changed file with diff counts', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [makeFile('src/a.ts', { additions: 1, deletions: 0, callIds: ['c1'] })],
    }))).toEqual({ label: '1 file changed · +1 −0', tone: 'neutral' });
  });

  test('tool evidence says touched and prints no counts', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [
        makeFile('src/a.ts', { status: 'unknown', evidence: 'tool', callIds: ['c1'] }),
        makeFile('src/b.ts', { status: 'unknown', evidence: 'tool', callIds: ['c2'] }),
      ],
    }))).toEqual({ label: '2 files touched', tone: 'neutral' });
  });

  test('never prints +0 −0', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [makeFile('src/a.ts', { additions: 0, deletions: 0, callIds: ['c1'] })],
    }))).toEqual({ label: '1 file changed', tone: 'neutral' });
  });

  test('a diff without counts is Diff too large', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [makeFile('src/a.ts', { status: 'unknown', callIds: [] })],
    }))).toEqual({ label: 'Diff too large', tone: 'warning' });
  });

  test('a deleted file without counts is still just changed', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [makeFile('src/a.ts', { status: 'deleted', callIds: [] })],
    }))).toEqual({ label: '1 file changed', tone: 'neutral' });
  });

  test('mixed evidence says both, without claiming counts for touched files', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [
        makeFile('src/a.ts', { additions: 4, deletions: 1, callIds: ['c1'] }),
        makeFile('src/b.ts', { status: 'unknown', evidence: 'tool', callIds: ['c2'] }),
      ],
    }))).toEqual({ label: '1 file changed · +4 −1 · 1 file touched', tone: 'neutral' });
  });

  test('a truncated record ends with and N more', () => {
    expect(toTurnChangeSummary(makeRecord({
      files: [makeFile('src/a.ts', { additions: 1, deletions: 0, callIds: ['c1'] })],
      truncated: true,
      omitted: 3,
    }))).toEqual({ label: '1 file changed · +1 −0 · and 3 more', tone: 'neutral' });
  });

  test('a turn with no write-like call has no row', () => {
    expect(toTurnChangeSummary(makeRecord({ files: [] }))).toBeNull();
  });
});

describe('serializeTurnChangeRecord and parseTurnChangeRecord', () => {
  const stored = makeRecord({
    files: [
      makeFile('src/a.ts', {
        status: 'modified',
        additions: 2,
        deletions: 1,
        evidence: 'diff',
        callIds: ['c1'],
      }),
    ],
  });

  test('round trips a record', () => {
    expect(parseTurnChangeRecord(serializeTurnChangeRecord(stored))).toEqual(stored);
  });

  test('drops a schema mismatch', () => {
    expect(parseTurnChangeRecord({ ...stored, v: 2 })).toBeNull();
    expect(parseTurnChangeRecord(JSON.stringify({ ...stored, v: 0 }))).toBeNull();
  });

  test('drops a corrupt record', () => {
    expect(parseTurnChangeRecord('{"v":1,')).toBeNull();
    expect(parseTurnChangeRecord('not json')).toBeNull();
    expect(parseTurnChangeRecord(null)).toBeNull();
    expect(parseTurnChangeRecord(42)).toBeNull();
    expect(parseTurnChangeRecord({
      ...stored,
      files: [{ path: 'src/a.ts', status: 'modified' }],
    })).toBeNull();
  });

  test('the key whitelist keeps content, patch, detail and output out', () => {
    const dirty = {
      ...stored,
      content: 'SECRET CONTENT',
      files: [{
        ...stored.files[0],
        patch: 'SECRET PATCH',
        detail: 'SECRET DETAIL',
        output: 'SECRET OUTPUT',
      }],
    } as unknown as TurnChangeRecord;

    const json = serializeTurnChangeRecord(dirty);
    expect(json).not.toContain('SECRET');
    expect(json).not.toMatch(/"(content|patch|detail|output)":/);

    const parsed = parseTurnChangeRecord(json);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(Object.keys(parsed).sort()).toEqual([
      'backendId',
      'endedAt',
      'files',
      'omitted',
      'sessionId',
      'startedAt',
      'truncated',
      'turnId',
      'v',
    ]);
    expect(Object.keys(parsed.files[0] ?? {}).sort()).toEqual([
      'additions',
      'callIds',
      'deletions',
      'evidence',
      'path',
      'status',
    ]);
    expect(serializeTurnChangeRecord(parsed)).toBe(json);
  });
});

describe('property: a record path always comes from a write-like call or a diff row', () => {
  test('every extracted path is present in the call arguments', () => {
    for (const fixture of EXTRACT_FIXTURES) {
      const result = extractFileEvidence({
        backend: fixture.backend,
        name: fixture.name,
        detail: fixture.detail,
      });
      for (const path of result.paths) {
        expect(fixture.writeLike).toBe(true);
        expect(comparable(detailText(fixture.detail))).toContain(comparable(path));
      }
      if (fixture.writeLike) expect(result.paths.length).toBeGreaterThan(0);
    }
  });

  test('every merged path is in an observation or a diff row', () => {
    const cases: Array<{
      observations: TurnObservations;
      before: readonly TurnDiffRow[] | null;
      after: readonly TurnDiffRow[] | null;
    }> = [
      {
        observations: makeObservations([
          makeObservation('src/a.ts', { callId: 'c1' }),
          makeObservation('src/b.ts', { callId: 'c2' }),
        ]),
        before: [{ path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0 }],
        after: [
          { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
          { path: 'src/c.ts', status: 'added', additions: 1, deletions: 0 },
        ],
      },
      {
        observations: makeObservations([]),
        before: [{ path: 'src/old.ts', status: 'modified', additions: 1, deletions: 1 }],
        after: [{ path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts' }],
      },
      {
        observations: makeObservations([makeObservation('src/d.ts', { callId: 'c3' })]),
        before: null,
        after: [{ path: 'src/e.ts', status: 'added', additions: 1, deletions: 0 }],
      },
    ];

    for (const entry of cases) {
      const record = mergeTurnEvidence(entry.observations, entry.before, entry.after);
      const allowed = new Set<string>();
      for (const item of entry.observations.items) {
        if (item.kind === 'write') allowed.add(comparable(item.path));
      }
      for (const row of entry.before ?? []) {
        allowed.add(comparable(row.path));
        if (row.oldPath) allowed.add(comparable(row.oldPath));
      }
      // Without a pre-snapshot the post rows are not licensed for attribution.
      if (entry.before !== null) {
        for (const row of entry.after ?? []) {
          allowed.add(comparable(row.path));
          if (row.oldPath) allowed.add(comparable(row.oldPath));
        }
      }
      expect(record.files.length).toBeGreaterThan(0);
      for (const file of record.files) {
        expect(allowed.has(comparable(file.path))).toBe(true);
      }
    }
  });
});
