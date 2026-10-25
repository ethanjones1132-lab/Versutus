// ─── Six provider reads that answered for facts they never had ───────────────
// Quality scan 2026-10-11, the MED entries in the gateway-provider.tsx section
// (scan lines 705-792): a confirmation sheet that showed "(unset)" for a config
// it could not read, a re-attach ladder that stopped on one failed journal read,
// a connect whose pin write could reject before the client attached, a refresh
// that stamped "checked just now" after failed reads, a dead /health that still
// counted as landed, and a delete whose pin write could skip the resume path.
//
// Pinned off the source, the way the rest of the provider suites pin theirs, so
// each assertion describes the honest shape the fix put in place and fails on
// the shape that came before it.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const source = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('a config.get that was refused is unknown, not unset', () => {
  const preview = sliceBetween(
    'export async function buildActionPreview(',
    "if (tokens[0] === '/channel'",
  );

  test('the unreadable before value has its own copy, not the "(unset)" one', () => {
    expect(source).toContain("export const CONFIG_BEFORE_UNREADABLE = '(current value could not be read)';");
    expect(preview).toContain('before: currentKnown ? safeStringify(lookupPath(current, key)) : CONFIG_BEFORE_UNREADABLE,');
  });

  test('a refused config.get records that nothing is known about the current values', () => {
    expect(preview).toContain('let currentKnown = true;');
    expect(preview).toContain('currentKnown = false;');
    // The old shape rendered every key through safeStringify(null, key), which
    // is "(unset)" — the false basis this fix exists to remove.
    expect(preview).not.toContain('before: safeStringify(lookupPath(current, key)),');
  });

  test('the sheet says the before column is unknown', () => {
    expect(preview).toContain(
      'The current values could not be read, so the before column is unknown.',
    );
  });
});

describe('the re-attach ladder survives a failed journal read', () => {
  const reattach = sliceBetween(
    'const reattachTurn = useCallback(',
    'useEffect(() => {\n    scheduleTurnReattachRef.current',
  );

  test('a rejected getTurn re-arms the next window instead of ending the follow', () => {
    expect(reattach).toContain('const read = await client.getTurn(turnId).then(');
    expect(reattach).toContain('if (!read.ok) {');
    expect(reattach).toContain(
      'if (clientGenerationRef.current === generation) scheduleTurnReattach(turnId);',
    );
  });

  test('the failure is no longer swallowed into a null answer', () => {
    expect(reattach).not.toContain('.catch(() => null)');
  });

  test('the re-arm is a dependency, so it is not a stale closure', () => {
    expect(reattach).toContain(
      '[attachTurn, localTurnIds, renderedSeqs, scheduleTurnReattach, settleTurn]',
    );
  });
});

describe('connectGateway connects even when the active-gateway pin is refused', () => {
  const connect = sliceBetween(
    'const connectGateway = useCallback(',
    'const resolveGatewayForUrl = useCallback',
  );

  test('both pin writes are caught and named', () => {
    const guarded = connect.match(/await saveActiveGatewayId\(gateway\.id\)\.catch\(/g) ?? [];
    expect(guarded).toHaveLength(2);
    expect(connect).toContain('Could not save the active gateway');
  });

  test('the attach still runs after a refused write', () => {
    const writeAt = connect.lastIndexOf('await saveActiveGatewayId(gateway.id).catch(');
    const attachAt = connect.indexOf('await attachClient(gateway);');
    expect(writeAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(writeAt);
  });
});

describe('refreshCapabilities only claims a check that actually read something', () => {
  const refresh = sliceBetween(
    'const refreshCapabilities = useCallback',
    'const confirmPendingAction = useCallback',
  );

  test('a falsy /health answer marks the refresh as not landed', () => {
    expect(refresh).toContain('const health = await raceAbort(client.healthCheck(), abort.signal);');
    expect(refresh).toContain('if (!health) landed = false;');
  });

  test('the checked stamp is written only for a refresh that landed', () => {
    expect(refresh).toContain('if (landed) setCapabilityCheckedAt(Date.now());');
    expect(refresh).not.toMatch(/\n\s*setCapabilityCheckedAt\(Date\.now\(\)\);/);
  });
});

describe('deleteGateway still resumes when the active-gateway pin is refused', () => {
  const remove = sliceBetween(
    'const deleteGateway = useCallback',
    'const disconnectGateway = useCallback',
  );

  test('the pin write is caught and named', () => {
    expect(remove).toContain('await saveActiveGatewayId(null).catch(');
    expect(remove).toContain('Could not clear the active gateway');
  });

  test('the auto-connect resume still follows the refused write', () => {
    const writeAt = remove.indexOf('await saveActiveGatewayId(null).catch(');
    const resumeAt = remove.indexOf("applyConnectionPhase('searching')");
    expect(writeAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(writeAt);
  });
});
