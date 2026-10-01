// ─── An unreachable gateway is rendered as a failed attempt, not a refusal ───
// This repo has jest-expo but no renderer (no @testing-library/react-native, no
// react-test-renderer), so a screen's runtime behaviour cannot be asserted here
// — the add-screen tests are source scans, and so is this one. It pins the one
// branch that changed: requestGatewayAccess can now return `unreachable`, and
// a gateway that answered nothing must land in the save error like the
// device-identity failure does, never in the warm note the refusal colouring is
// gated on.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const SOURCE = nodeFs
  .readFileSync([__dirname, '..', 'src', 'app', 'gateway', 'add.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

// The access handshake through the save: everything the result can change.
const FLOW = SOURCE.slice(
  SOURCE.indexOf('const result = await requestGatewayAccess'),
  SOURCE.indexOf('const gateway = await addGateway'),
);

/** One `if (result.status === '…')` block, closing brace included. */
function branch(status: string): string {
  const start = FLOW.indexOf(`if (result.status === '${status}')`);
  expect(start).toBeGreaterThanOrEqual(0);
  return FLOW.slice(start, FLOW.indexOf('\n          }', start));
}

describe('manual-add-gateway unreachable access result', () => {
  test('the access handshake is still gated on the result status', () => {
    expect(FLOW).toContain("setAccessStatus(result.status);");
  });

  test('an unreachable gateway becomes the save error and stops the save', () => {
    const block = branch('unreachable');
    expect(block).toContain('setSaveError(result.reason);');
    expect(block).toContain('setSaving(false);');
    expect(block).toContain('return;');
  });

  test('an unreachable gateway is never filed as an access note', () => {
    // The note is what `accessStatus === 'denied'` paints warm — a dead path
    // must not take that branch, whatever colour the reason text would get.
    expect(branch('unreachable')).not.toContain('setAccessNote');
  });

  test('the unreachable branch runs before anything can be saved', () => {
    expect(FLOW.indexOf("result.status === 'unreachable'")).toBeLessThan(FLOW.length);
    // addGateway is outside the flow slice by construction, so reaching it
    // requires falling through every branch; unreachable returns.
    expect(FLOW).not.toContain('addGateway');
  });

  test('a real denial still takes the note, and only a denial is coloured', () => {
    expect(branch('denied')).toContain('setAccessNote(result.reason);');
    expect(SOURCE).toContain("color={accessStatus === 'denied' ? 'accentWarm' : 'secondary'}");
  });

  test('the device-identity branch is unchanged', () => {
    const block = branch('device-identity');
    expect(block).toContain('setSaveError(result.reason);');
    expect(block).toContain('setSaving(false);');
  });
});
