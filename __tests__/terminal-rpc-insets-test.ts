import { TERMINAL_RPC_BASE_PADDING, terminalRpcContentPaddingBottom } from '@/lib/terminal/rpc-insets';

const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

test('android gesture bar adds inset to rpc padding', () => {
  expect(terminalRpcContentPaddingBottom({ platform: 'android', insetBottom: 42 })).toBe(
    TERMINAL_RPC_BASE_PADDING + 42,
  );
});

test('android zero/negative/nonsense inset falls back to base', () => {
  expect(terminalRpcContentPaddingBottom({ platform: 'android', insetBottom: 0 })).toBe(
    TERMINAL_RPC_BASE_PADDING,
  );
  expect(terminalRpcContentPaddingBottom({ platform: 'android', insetBottom: -10 })).toBe(
    TERMINAL_RPC_BASE_PADDING,
  );
  expect(terminalRpcContentPaddingBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(
    TERMINAL_RPC_BASE_PADDING,
  );
});

test('ios keeps base regardless of inset (NativeTabs owns bottom)', () => {
  expect(terminalRpcContentPaddingBottom({ platform: 'ios', insetBottom: 42 })).toBe(
    TERMINAL_RPC_BASE_PADDING,
  );
});

test('web keeps base regardless of inset', () => {
  expect(terminalRpcContentPaddingBottom({ platform: 'web', insetBottom: 42 })).toBe(
    TERMINAL_RPC_BASE_PADDING,
  );
});

test('custom base honoured on android and ios', () => {
  expect(terminalRpcContentPaddingBottom({ platform: 'android', insetBottom: 24, base: 24 })).toBe(48);
  expect(terminalRpcContentPaddingBottom({ platform: 'ios', insetBottom: 24, base: 24 })).toBe(24);
});

test('terminal-screen RPC ScrollView uses rpc insets helper and handled taps', () => {
  const src = nodeFs.readFileSync('src/components/terminal/terminal-screen.tsx', 'utf8');
  expect(src).toContain('terminalRpcContentPaddingBottom');
  expect(src).toContain('insets.bottom');
  // RPC ScrollView is the only ScrollView with commandContent/commandScroll — ensure it has handled taps
  expect(src).toContain('keyboardShouldPersistTaps="handled"');
});
