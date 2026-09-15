import { readFileSync } from 'fs';
import { join } from 'path';

// Measurement baseline, recorded at filing time: sendChatInput loaded
// @/lib/gateway/slash-commands with `await import(...)` on every slash
// command the operator sent, while the SAME module already ships
// statically at the top of gateway-provider.tsx (isSlashCommandInput).
// After the hoist the module is loaded by the static import exactly once.
const DYNAMIC_SPECIFIER = '@/lib/gateway/slash-commands';
const PROVIDER = join(__dirname, '..', 'src', 'context', 'gateway-provider.tsx');

const providerSource = () => readFileSync(PROVIDER, 'utf8');

describe('sendChatInput loads the slash module once', () => {
  it('the executor is imported statically at the top, beside the sentinel checks', () => {
    const src = providerSource();
    expect(src).toMatch(
      /import\s*\{[^}]*executeGatewaySlashCommand[^}]*\}\s*from\s*['"]@\/lib\/gateway\/slash-commands['"];/
    );
  });

  it('no dynamic import of the slash module remains in the provider', () => {
    const src = providerSource();
    expect(src).not.toContain(`await import('${DYNAMIC_SPECIFIER}')`);
    expect(src).not.toContain(`await import("${DYNAMIC_SPECIFIER}")`);
  });

  it('the sendChatInput executor call uses the statically imported identifier', () => {
    const src = providerSource();
    expect(src).toMatch(/executeGatewaySlashCommand\(\s*trimmed,\s*\{/);
  });

  it('the dynamic-import count across the provider for this specifier is 0', () => {
    const src = providerSource();
    const dynamicHits = src.split(`import('${DYNAMIC_SPECIFIER}')`).length - 1;
    expect(dynamicHits).toBe(0);
  });
});
