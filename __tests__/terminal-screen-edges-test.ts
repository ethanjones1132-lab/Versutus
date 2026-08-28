declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('terminal tab on Android leaves bottom edge to NativeTabs (no double pad)', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: false })).toEqual(['top']);
});

test('terminal tab helper matches iOS and web expectations', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: false })).toEqual(['top']);
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
});

test('terminal Screen wires screenEdgesFor with hasDock:false', () => {
  const file = nodeFs.readFileSync(
    [__dirname, '..', 'src/components/terminal/terminal-screen.tsx'].join(SEP),
    'utf8',
  );
  expect(file).toMatch(/screenEdgesFor\(\{[^}]*platform:\s*Platform\.OS[^}]*hasDock:\s*false[^}]*\}\)/);
  expect(file).toMatch(/import\s*\{\s*screenEdgesFor\s*\}\s*from\s*['\"]@\/lib\/motion\/screen-edges['\"]/);
  expect(file).toMatch(/<Screen[^>]*edges=\{screenEdgesFor\(/);
});
