/**
 * The haptic-wrapper retirement: `src/lib/haptics.ts` is the only place that
 * may talk to `expo-haptics`. Its stated contract is that "interaction
 * feedback must never make an action fail" — but ~70 call sites across 22
 * files awaited the RAW library instead, most of them before the action they
 * decorate (a navigation, a state write, a handler call), with no `.catch`
 * and no `try`. A device whose build dropped the native module
 * (`UnavailabilityError('Haptic', …)`), a lost React context, or a vendor
 * vibrator that is not a `VibratorManager` all reject, and the action after
 * the await never ran. This guard keeps the class from growing back: a new raw
 * import or raw call anywhere else under `src/` fails here, naming the files.
 *
 * Node built-ins are reached through jest.requireActual because the project
 * ships without @types/node; the scan logic itself stays a pure helper over
 * {path, content} pairs.
 */
declare const __dirname: string;

/** The one file allowed to name the native module. */
const OWNER = 'src/lib/haptics.ts';

const RAW_IMPORT = /from\s*['"]expo-haptics['"]/;
const RAW_CALL = /\bHaptics\s*\./;

export type SourceFile = { path: string; content: string };

/** Every file under src/ that reaches the native haptic API directly. */
export function findRawHapticsOffenders(files: SourceFile[]): string[] {
  return files
    .filter((file) => file.path !== OWNER)
    .filter((file) => RAW_IMPORT.test(file.content) || RAW_CALL.test(file.content))
    .map((file) => file.path);
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

describe('the haptic wrapper is the only caller of expo-haptics', () => {
  test('flags a raw import or a raw call outside the wrapper', () => {
    expect(
      findRawHapticsOffenders([
        { path: 'src/app/runs.tsx', content: "import * as Haptics from 'expo-haptics';\n" },
        { path: 'src/components/ui/BaseSheet.tsx', content: 'void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);' },
        { path: 'src/components/ui/BaseSheet.tsx', content: "import { haptics } from '@/lib/haptics';\nvoid haptics.light();" },
      ]),
    ).toEqual(['src/app/runs.tsx', 'src/components/ui/BaseSheet.tsx']);
  });

  test('the wrapper itself is the allowed caller', () => {
    expect(
      findRawHapticsOffenders([
        {
          path: OWNER,
          content:
            "import * as Haptics from 'expo-haptics';\nlight: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),",
        },
      ]),
    ).toEqual([]);
  });

  test('the live src/ tree reaches the native API only through the wrapper', () => {
    const srcRoot = [__dirname, '..', 'src'].join(SEP);
    const files = listSourceFiles(srcRoot).map((full) => ({
      path: `src/${full.slice(srcRoot.length + 1).split(SEP).join('/')}`,
      content: nodeFs.readFileSync(full, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(50);
    expect(findRawHapticsOffenders(files)).toEqual([]);
  });
});
