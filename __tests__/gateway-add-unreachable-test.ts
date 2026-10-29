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

// ─── An unknown identity that answered nothing is not a token prompt ────────
// identifyGateway can file an address as unknown either because a living
// server answered /health with some status (a credential question) or because
// nothing answered there at all (a dead path). The add screen used to treat
// both as "requires a token" and open the token field. These scans pin the
// split: the no-answer case reaches setSaveError and returns before the token
// branch, and the answered case keeps today's note and advanced field.

describe('manual-add-gateway unknown identity reachability', () => {
  const NO_ANSWER = "identity.reachability === 'no-answer'";

  /** The `else if` block that owns the no-answer test, closing brace included. */
  function noAnswerBranch(): string {
    const start = FLOW.indexOf(NO_ANSWER);
    expect(start).toBeGreaterThanOrEqual(0);
    return FLOW.slice(start, FLOW.indexOf('} else if', start));
  }

  /** The token-required `else if` block, closing brace included. */
  function tokenBranch(): string {
    const start = FLOW.indexOf('identity.auth.requiresToken');
    expect(start).toBeGreaterThanOrEqual(0);
    return FLOW.slice(start, FLOW.indexOf('\n        }', start));
  }

  test('the no-answer branch names the dead address in the save error', () => {
    const block = noAnswerBranch();
    expect(block).toContain('setSaveError(');
    expect(block).toContain('Nothing answered at');
    expect(block).toContain('setSaving(false);');
    expect(block).toContain('return;');
  });

  test('the no-answer branch is never the token note and never opens the field', () => {
    const block = noAnswerBranch();
    expect(block).not.toContain('setAccessNote');
    expect(block).not.toContain('setShowAdvanced');
  });

  test('the no-answer branch runs before the token-required branch', () => {
    // A dead address still has auth.requiresToken === true, so the token branch
    // would answer for it if it were reached first.
    expect(FLOW).toContain(NO_ANSWER);
    expect(FLOW.indexOf(NO_ANSWER)).toBeGreaterThanOrEqual(0);
    expect(FLOW.indexOf(NO_ANSWER)).toBeLessThan(FLOW.indexOf('identity.auth.requiresToken'));
  });

  test('the no-answer branch stops the save before addGateway', () => {
    // addGateway sits outside FLOW by construction; returning means falling no
    // further, and the branch itself must not call the save.
    expect(noAnswerBranch()).toContain('return;');
    expect(FLOW).not.toContain('addGateway');
  });

  test('an address that answered keeps the token note and the optional token field', () => {
    const block = tokenBranch();
    expect(block).toContain('setAccessNote(');
    expect(block).toContain('setShowAdvanced(true);');
    expect(block).toContain('setSaving(false);');
    expect(block).toContain('return;');
  });

  test('a supplied token still reaches the save through connectToken', () => {
    expect(SOURCE).toContain('token: connectToken(grantedToken, token),');
  });
});
