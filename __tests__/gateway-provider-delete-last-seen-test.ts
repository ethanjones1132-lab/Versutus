// ─── Gateway deletion clears Home last-seen stamps ────────────────────────
// When a gateway profile is deleted (or cascaded away as a child), its
// "while you were away" stamp must be removed so a later re-added gateway
// with the same id does not inherit an old visit window. The deleteGateway
// callback already clears transcripts and session labels for every removed
// id; it must also clear the per-gateway last-seen key.

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

const provider = readSource('src', 'context', 'gateway-provider.tsx');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = provider.indexOf(startMarker);
  const end = provider.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return provider.slice(start, end);
}

const deleteFn = sliceBetween(
  'const deleteGateway = useCallback',
  'const disconnectGateway = useCallback',
);

describe('gateway deletion clears last-seen stamps', () => {
  test('deleteGateway imports clearLastSeen from @/lib/home/last-seen', () => {
    expect(provider).toContain("import { clearLastSeen } from '@/lib/home/last-seen';");
  });

  test('deleteGateway clears last-seen for every removed gateway id', () => {
    // The removedIds set is built from the id argument plus any cascaded children.
    expect(deleteFn).toContain('const removedIds = new Set<string>([id]);');
    // clearLastSeen is awaited in a Promise.all alongside the other cleanups.
    const clearLastSeenAt = deleteFn.indexOf('clearLastSeen(removedId)');
    expect(clearLastSeenAt).toBeGreaterThan(-1);
    // It runs after transcripts and session labels (order not critical, but present).
    const transcriptsAt = deleteFn.indexOf('clearTranscriptsForGateway(removedId)');
    const labelsAt = deleteFn.indexOf('clearSessionLabelsForGateway(removedId)');
    expect(transcriptsAt).toBeGreaterThan(-1);
    expect(labelsAt).toBeGreaterThan(-1);
    expect(clearLastSeenAt).toBeGreaterThan(-1);
  });

  test('clearLastSeen is best-effort like the other cleanups', () => {
    // The Promise.all swallows individual rejections — a storage failure on
    // one key does not block the others or the deletion itself.
    const clearBlock = deleteFn.slice(
      deleteFn.indexOf('await Promise.all(['),
      deleteFn.indexOf('});', deleteFn.indexOf('clearLastSeen'))
    );
    expect(clearBlock).toContain('clearTranscriptsForGateway');
    expect(clearBlock).toContain('clearSessionLabelsForGateway');
    expect(clearBlock).toContain('clearLastSeen');
  });
});