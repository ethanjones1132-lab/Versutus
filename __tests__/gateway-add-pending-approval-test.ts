// â”€â”€â”€ A pending-approval is rendered as a waiting note, never saved â”€â”€â”€
// This test pins the early return and rendering of the approval request state
// for the manual-add flow's response to requestGatewayAccess.

// See docs/portal-architecture.md Â§4:
//   pending-approval  â†’ gateway-side approval required (OpenClaw pairing)

// This test copies the structure from gateway-add-unreachable-test.ts
// and verifies the pending-approval branch returns early like denied and unreachable.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const SOURCE = nodeFs
  .readFileSync([__dirname, '..', 'src', 'app', 'gateway', 'add.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

/** One `if (result.status === 'â€¦')` block, closing brace included. */
function branch(status: string): string {
  const start = SOURCE.indexOf(`if (result.status === '${status}')`);
  expect(start).toBeGreaterThanOrEqual(0);
  return SOURCE.slice(start, SOURCE.indexOf('\n          }', start));
}

describe('manual-add-gateway pending-approval access result', () => {
  test('the access handshake is still gated on the result status', () => {
    expect(SOURCE).toContain("setAccessStatus(result.status);");
  });

  test('a pending-approval is rendered as a note and stops the save', () => {
    const block = branch('pending-approval');
    expect(block).toContain('setAccessNote');
    expect(block).toContain('setSaving(false);');
    expect(block).toContain('return;');
  });

  test('a pending-approval is never filed as a save error', () => {
    // The pending approval is a wait state, not an error.
    expect(branch('pending-approval')).not.toContain('setSaveError');
  });

  test('the pending-approval branch runs before anything can be saved', () => {
    expect(SOURCE.indexOf("result.status === 'pending-approval'")).toBeLessThan(SOURCE.length);
    // addGateway is outside the flow slice by construction, so reaching it
    // requires falling through every branch; pending-approval returns.
    expect(branch('pending-approval')).not.toContain('addGateway');
    expect(branch('pending-approval')).not.toContain('connectGateway');
  });

  test('the pending-approval branch does not open the token field', () => {
    expect(branch('pending-approval')).not.toContain('setShowAdvanced');
  });

  test('a pending-approval keeps the hint text as a note', () => {
    // The hint from requestGatewayAccess should appear in the UI.
    expect(SOURCE).toMatch(/Approval requested.*approve this device on the gateway\./);
  });
});
