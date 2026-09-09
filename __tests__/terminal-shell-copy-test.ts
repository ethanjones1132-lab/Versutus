import { ansiPlainText } from '@/lib/terminal/ansi';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const readScreen = () =>
  nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP),
    'utf8',
  );

const readOutput = () =>
  nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'terminal', 'terminal-output.tsx'].join(SEP),
    'utf8',
  );

const readLogSheet = () =>
  nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'terminal', 'command-log-sheet.tsx'].join(SEP),
    'utf8',
  );

describe('terminal shell live-output copy', () => {
  test('ansiPlainText strips colour sequences for a plain copy', () => {
    expect(ansiPlainText('\u001B[31merror\u001B[0m ok')).toBe('error ok');
  });

  test('the shell banner offers a Copy control wired to the clipboard', () => {
    const file = readScreen();
    expect(file).toMatch(/Copy/);
    expect(file).toMatch(/Clipboard\.setStringAsync/);
    expect(file).toMatch(/ansiPlainText\(line\.text\)\)\.join\('\\n'\)/);
  });

  test('copy feedback confirms with a success haptic and a copied state', () => {
    const file = readScreen();
    expect(file).toMatch(/Haptics\.NotificationFeedbackType\.Success/);
    expect(file).toMatch(/setOutputCopied\(true\)/);
    expect(file).toMatch(/outputCopied \? 'Copied' : 'Copy'/);
  });

  test('the banner status dot and connection copy are byte-identical', () => {
    const file = readScreen();
    expect(file).toMatch(/terminalBannerDot/);
    expect(file).toMatch(/terminalConnected\s*\? 'connected'/);
    expect(file).toMatch(/activeHello\?\.server\?\.version\s*\? ` · v\$\{activeHello\.server\.version\}` : ''/);
  });

  test('TerminalOutput keeps no clipboard path and its ANSI rendering is untouched', () => {
    const file = readOutput();
    expect(file).not.toMatch(/Clipboard/);
    expect(file).toMatch(/parseAnsiText\(text\)/);
    expect(file).toMatch(/ansiPlainText\(text\)/);
  });

  test('CommandLogSheet copyAll is byte-identical', () => {
    const file = readLogSheet();
    expect(file).toMatch(/await Clipboard\.setStringAsync\(log\);/);
    expect(file).toMatch(/Haptics\.NotificationFeedbackType\.Success/);
  });
});
