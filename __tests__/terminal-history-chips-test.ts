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

describe('terminal history chips render the full stored history', () => {
  const readScreen = () =>
    nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP),
      'utf8',
    );

  test('the chip row maps every stored input, not a slice of three', () => {
    const file = readScreen();
    expect(file).not.toMatch(/inputHistory\.slice\(0,\s*3\)/);
    expect(file).toMatch(/\{inputHistory\.map\(/);
  });

  test('HISTORY_LIMIT stays 40 and the stored-history cap is intact', () => {
    const file = readScreen();
    expect(file).toMatch(/const HISTORY_LIMIT = 40;/);
    expect(file).toMatch(/\.slice\(0, HISTORY_LIMIT\)/);
  });

  test('ArrowUp / ArrowDown history navigation is unchanged', () => {
    const file = readScreen();
    expect(file).toMatch(/ArrowUp' && inputHistory\.length > 0/);
    expect(file).toMatch(/Math\.min\(historyIndex \+ 1, inputHistory\.length - 1\)/);
    expect(file).toMatch(/ArrowDown' && historyIndex >= 0/);
    expect(file).toMatch(/onKeyPress=\{handleInputKeyPress\}/);
  });

  test('Send still fires sendToTerminal and sendToTerminal still guards the session', () => {
    const file = readScreen();
    expect(file).toMatch(/onSubmitEditing=\{\(\) => void sendToTerminal\(\)\}/);
    expect(file).toMatch(/<Button label="Send" size="sm" onPress=\{\(\) => void sendToTerminal\(\)\} \/>/);
    expect(file).toMatch(/if \(!session \|\| !gateway \|\| !value\) return;/);
  });

  test('a tapped chip still writes the command into the input', () => {
    const file = readScreen();
    expect(file).toMatch(/onPress=\{\(\) => setInput\(command\)\}/);
  });
});
