declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('terminal with hasDock true keeps the bottom edge on Android', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: true })).toEqual(['top', 'bottom']);
});

test('terminal helper matches iOS and web expectations', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: true })).toEqual(['top', 'bottom']);
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
});

test('terminal Screen wires screenEdgesFor with hasDock:true', () => {
  const file = nodeFs.readFileSync(
    [__dirname, '..', 'src/components/terminal/terminal-screen.tsx'].join(SEP),
    'utf8',
  );
  expect(file).toMatch(/screenEdgesFor\(\{[^}]*platform:\s*Platform\.OS[^}]*hasDock:\s*true[^}]*\}\)/);
  expect(file).toMatch(/import\s*\{\s*screenEdgesFor\s*\}\s*from\s*['\"]@\/lib\/motion\/screen-edges['\"]/);
  expect(file).toMatch(/<Screen[^>]*edges=\{screenEdgesFor\(/);
});
