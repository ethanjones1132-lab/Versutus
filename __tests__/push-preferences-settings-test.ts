// ─── The notification preferences pane on gateway settings ─────────────────
// A8's step 1 and A6's per-device opt-in are toggles only the settings pane
// exposes: the preferences RPC pair is live Gate-side (push-rpc.mjs) and the
// notifier enforces every field (push-notifier.mjs), but nothing app-side
// made `enabled` reachable before this. The section's own fold is pinned by
// push-preferences-test.ts; this suite pins the mount and the capability gate
// by source, the way the spend-entry-points suite does.

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

const settingsScreen = () => readSource('src', 'app', 'gateway', 'settings.tsx');
const section = () => readSource('src', 'components', 'gateway', 'notification-preferences-section.tsx');

describe('the preferences pane hangs off gateway settings', () => {
  test('the screen mounts the section exactly once, for the active gateway', () => {
    const src = settingsScreen();
    expect(src).toContain("from '@/components/gateway/notification-preferences-section'");
    expect(src.split('<NotificationPreferencesSection />').length - 1).toBe(1);
    // It is inside the activeGateway branch, so a screen with no active
    // gateway shows nothing new (the card's paired-device row is its sibling).
    const branch = src.slice(src.indexOf('{activeGateway ? ('), src.indexOf('</>\n        ) : null}'));
    expect(branch).toContain('<NotificationPreferencesSection />');
  });

  test('the section is capability-gated on the advertised methods and renders nothing ungated', () => {
    const src = section();
    const gate = src.indexOf('pushPreferencesAdvertised(capabilitySnapshot.rpcMethods)');
    const usage = src.indexOf("if (!advertised) return null;");
    expect(gate).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(gate);
    // And the section does not fetch its own manifest — it reads the
    // already-held snapshot, the same no-new-fetch rule RpcMethodsSection holds.
    expect(src).toContain('capabilitySnapshot');
    expect(src).not.toContain("rpcRequest('manifest");
  });
});

describe('the pane reads and writes the Gate, never a device-side cache', () => {
  test('the fold answers the Gate defaults and the patch omits unset fields', () => {
    // The two rules the pane's honesty rests on live in the module, pinned
    // there; this asserts the section uses the module rather than inlining
    // its own idea of the four fields.
    expect(section()).toContain("from '@/lib/notifications/push-preferences'");
    expect(section()).not.toContain('versutus:');
    expect(section()).not.toContain('AsyncStorage');
    expect(section()).not.toContain('secureKeyValueStorage');
  });

  test('existing settings sections render unchanged (must-KEEP pin)', () => {
    const src = settingsScreen();
    // The App lock switch and every other card stay byte-familiar.
    expect(src).toContain('<SpendEntryRow />');
    expect(src).toContain('APP_LOCK_LABEL');
    expect(src).toContain('/gateway/diagnostics');
  });
});
