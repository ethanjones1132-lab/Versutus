jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { Palette } from '@/constants/tokens';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const GATEWAY = ['src', 'components', 'gateway'] as const;

const management = () => readSource(...GATEWAY, 'gateway-management-section.tsx');
const notifications = () => readSource(...GATEWAY, 'notifications-section.tsx');
const savedList = () => readSource(...GATEWAY, 'compact-gateway-list.tsx');
const capabilities = () => readSource(...GATEWAY, 'gateway-capabilities.tsx');
const hive = () => readSource(...GATEWAY, 'capability-hive.tsx');
const channels = () => readSource(...GATEWAY, 'channel-status-row.tsx');

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

// CHARTER priority 1 / docs/visual-direction-2026-09.md: gateway + settings
// section chrome printed the brighter focus violet at rest, and readiness /
// channel attention borrowed the brand instead of the semantic status ramp.
describe('gateway and settings sections read the quiet brand stage', () => {
  it('the four section eyebrows resolve brand violet', () => {
    const source = management();
    expect(occurrences(source, 'color="accent" style={styles.eyebrow}')).toBe(3);
    expect(notifications()).toContain('color="accent" style={styles.eyebrow}');
    for (const src of [source, notifications()]) {
      expect(src).not.toContain('accentWarm');
    }
  });

  it('the active saved-gateway row edges with brand violet', () => {
    const source = savedList();
    expect(source).toContain('borderColor: tokens.accent,');
    expect(source).not.toContain('accentWarm');
    expect(source).toContain('color="accent"');
  });

  it('capability readiness speaks semantic green while its toggle reads brand violet', () => {
    const source = capabilities();
    expect(source).toContain('color="accent" style={styles.toggle}');
    expect(source).toContain("status === 'ready'\n      ? tokens.statusConnected");
    expect(source).not.toContain('accentWarm');
    expect(source).toContain('? tokens.statusConnecting');
    expect(source).toContain('? tokens.statusDisconnected');
  });

  it('the hive summary and selected cell agree with the ready-cell painter', () => {
    const source = hive();
    expect(source).toContain('color="statusConnected"');
    expect(source).toContain('borderColor: Palette.accent,');
    expect(source).not.toContain('accentWarm');
    expect(source).toContain('      return tokens.statusConnected;');
    expect(source).toContain('      return tokens.statusConnecting;');
  });

  it('channel attention resolves amber instead of the brand', () => {
    const source = channels();
    expect(source).toContain("? tokens.statusConnecting\n        : tokens.textTertiary;");
    expect(source).toContain('borderColor: Palette.statusConnecting,');
    expect(source).toContain('? tokens.statusConnected');
    expect(source).not.toContain('accentWarm');
  });

  it('brand, readiness green and attention amber are three different colours', () => {
    expect(Palette.accent).toBe('#8B7CFF');
    expect(Palette.accent).not.toBe(Palette.accentWarm);
    expect(Palette.statusConnected).not.toBe(Palette.accent);
    expect(Palette.statusConnecting).not.toBe(Palette.accent);
    expect(Palette.statusConnecting).not.toBe(Palette.statusConnected);
    expect(Palette.statusDisconnected).toBe('#E56D6D');
  });
});

describe('every gateway and settings flow the tone pass left alone', () => {
  it('startup, discovery and saved-gateway actions still wire up', () => {
    const source = management();
    for (const needle of [
      'onValueChange={(value) => void setAutoConnect(value)}',
      'trackColor={{ true: tokens.accent, false: tokens.border }}',
      'onPress={discovery.rescan}',
      'discovery.status === \'scanning\'',
      '<CompactGatewayList',
      'onSelect={(gateway) => void handleConnect(gateway.id)}',
      'onDelete={(gateway) => handleDelete(gateway.id)}',
      'label="Refresh saved profiles"',
      'onConfirm={confirmDelete}',
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('notification switches, quiet hours and the test round trip still work', () => {
    const source = notifications();
    for (const needle of [
      'onValueChange={(value) => void setEnabled(value)}',
      'accessibilityLabel="Push notifications from this Gate"',
      'const saveQuietHours = () => {',
      'parseQuietHoursInput(quietStart, quietEnd)',
      'label={saving ? \'Saving…\' : \'Save quiet hours\'}',
      'void setPatch({ richBody: value })',
      'void setPatch({ widgetUpdates: value })',
      'void setPatch({ quietHoursAllowApprovals: value })',
      'onPress={() => void sendTest()}',
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('saved rows still expand, connect and remove', () => {
    const source = savedList();
    for (const needle of [
      'onPress={onSelect}',
      'label="Remove"',
      'onPress={() => setUrlExpanded((prev) => !prev)}',
      'accessibilityLabel={urlExpanded ? \'Collapse gateway URL\' : \'Expand gateway URL\'}',
      'onDelete: (gateway: GatewayProfile) => void;',
      '? tokens.statusConnected',
      '? tokens.statusConnecting',
      '? tokens.statusDisconnected',
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('capability show-all, freshness stamp and pill mapping still behave', () => {
    const source = capabilities();
    for (const needle of [
      'onPress={() => setShowAll((value) => !value)}',
      'accessibilityLabel={showAll ? \'Hide unsupported capabilities\' : \'Show all capabilities\'}',
      '<CapabilityFreshness checkedAt={checkedAt} status={snapStatus} />',
      'staleMinutes',
      "status === 'experimental'",
      "status.replace('-', ' ')",
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('hive selection haptics and the ready count still drive the grid', () => {
    const source = hive();
    for (const needle of [
      'void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);',
      'setSelected((current) => (current === group.id ? null : group.id));',
      'const ready = counted.filter((group) => group.status === \'ready\' || group.status === \'available\').length;',
      '{ready}/{counted.length} ready',
      'onPress={onPress}',
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('channel rows still open chat and expand their detail', () => {
    const source = channels();
    for (const needle of [
      'onPress={onPress}',
      'model.tone === \'attention\' && styles.rowAttention',
      'setDetailExpanded((prev) => !prev)',
      'event.stopPropagation()',
      'describeChannelStatusRow(group)',
      'if (!model.visible) return null;',
    ]) {
      expect(source).toContain(needle);
    }
  });
});
