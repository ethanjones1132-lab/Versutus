/**
 * The raw-TextInput retirement (Tier 2.4): every typing surface renders the
 * kit TextField, and `react-native`'s TextInput may be imported only inside
 * the kit's own implementation files. This guard keeps the retirement from
 * silently rotting back — a new raw import anywhere else in src/ fails here,
 * so adding one has to be a conscious edit to the allowlist below.
 *
 * Node built-ins are reached through jest.requireActual because the project
 * ships without @types/node (see the tsconfig-scope trap in the portal skill);
 * the scan logic itself stays a pure helper over {path, content} pairs.
 */
declare const __dirname: string;

const ALLOWED = new Set([
  'src/components/ui/TextField.tsx',
  'src/components/ui/TextField.ios.tsx',
]);

/** A react-native import clause that pulls in TextInput (aliases included). */
const RAW_IMPORT = /import\s+(?:type\s+)?\{[^}]*\bTextInput\b[^}]*\}\s*from\s*['"]react-native['"]/;

export type SourceFile = { path: string; content: string };

export function findRawTextInputOffenders(files: SourceFile[]): string[] {
  return files.filter((file) => !ALLOWED.has(file.path) && RAW_IMPORT.test(file.content)).map((file) => file.path);
}

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readdirSync(path: string, options: { withFileTypes: boolean }): { name: string; isDirectory(): boolean }[];
  readFileSync(path: string, encoding: string): string;
};

function listSourceFiles(dir: string): string[] {
  return nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}${SEP}${entry.name}`;
    if (entry.isDirectory()) return listSourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) return [];
    return [full];
  });
}

describe('raw TextInput retirement', () => {
  test('flags a raw react-native TextInput import outside the allowlist', () => {
    expect(
      findRawTextInputOffenders([
        { path: 'src/components/chat/chat-composer.tsx', content: "import { TextInput } from 'react-native';" },
        { path: 'src/components/chat/chat-composer.tsx', content: "import { View } from 'react-native';" },
        { path: 'src/app/index.tsx', content: "import { TextInput as LegacyInput } from 'react-native';" },
      ]),
    ).toEqual(['src/components/chat/chat-composer.tsx', 'src/app/index.tsx']);
  });

  test('the kit field implementations are the only allowed importers', () => {
    expect(
      findRawTextInputOffenders([
        { path: 'src/components/ui/TextField.tsx', content: "import { StyleSheet, TextInput } from 'react-native';" },
        {
          path: 'src/components/ui/TextField.ios.tsx',
          content: '// SwiftUI host renders its own field; no direct TextInput here.',
        },
      ]),
    ).toEqual([]);
  });

  test('mentions of the name without a react-native import are not offenders', () => {
    expect(
      findRawTextInputOffenders([
        {
          path: 'src/components/terminal/terminal-screen.tsx',
          content: '// Migrated off the raw TextInput onto the kit TextField.',
        },
      ]),
    ).toEqual([]);
  });

  test('the live src/ tree keeps every raw TextInput inside the kit field', () => {
    const srcRoot = [__dirname, '..', 'src'].join(SEP);
    const files = listSourceFiles(srcRoot).map((full) => ({
      path: `src/${full.slice(srcRoot.length + 1).split(SEP).join('/')}`,
      content: nodeFs.readFileSync(full, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(50);
    expect(findRawTextInputOffenders(files)).toEqual([]);
  });
});
