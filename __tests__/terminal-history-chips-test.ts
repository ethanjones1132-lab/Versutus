import {
  TERMINAL_HISTORY_CHIP_MAX_WIDTH,
  terminalHistoryIsScrollable,
  terminalHistoryNeedsScroll,
} from '@/lib/terminal/history-layout';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('terminal history chips overflow', () => {
  test('at 360dp three chips overflow without scrolling', () => {
    expect(terminalHistoryNeedsScroll(360, 3)).toBe(true);
  });

  test('at 600dp three chips fit without scrolling', () => {
    expect(terminalHistoryNeedsScroll(600, 3)).toBe(false);
  });

  test('chip maxWidth stays 160', () => {
    expect(TERMINAL_HISTORY_CHIP_MAX_WIDTH).toBe(160);
  });

  test('wrapping in horizontal ScrollView makes all chips reachable', () => {
    expect(terminalHistoryIsScrollable()).toBe(true);
    const needsScroll = terminalHistoryNeedsScroll(360, 3);
    const reachableViaScroll = !needsScroll || terminalHistoryIsScrollable();
    expect(reachableViaScroll).toBe(true);
  });

  test('terminal-screen history row is a horizontal ScrollView', () => {
    const file = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP),
      'utf8',
    );
    expect(file).toMatch(/<ScrollView[^>]*horizontal/);
    expect(file).toMatch(/showsHorizontalScrollIndicator=\{false\}/);
    expect(file).toMatch(/keyboardShouldPersistTaps="handled"/);
    expect(file).toMatch(/contentContainerStyle=\{styles\.historyRow\}/);
  });

  test('history chip keeps maxWidth 160 in screen file', () => {
    const file = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP),
      'utf8',
    );
    expect(file).toMatch(/historyChip:\s*\{\s*maxWidth:\s*160/);
  });
});
