declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'capabilities-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('capabilities registry retry', () => {
  test('a refused first read offers a Retry action wired to the load handler', () => {
    // A refused kinds/instances read left the operator with a bare caption
    // and no way forward except remounting the Gate setup screen. The
    // section now renders a retry button bound to the same re-read the
    // mount effect runs.
    const src = readSectionSource();
    expect(src).toMatch(/kinds\.length === 0 && instances\.length === 0 && !draft \? \(/);
    const failed = src.match(
      /kinds\.length === 0 && instances\.length === 0 && !draft \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/variant="ghost"/);
    expect(failed).toMatch(/onPress=\{\(\) => void load\(\)\}/);
  });

  test('the retry never renders over a draft, so validation errors stay button-free', () => {
    // Draft-validation errors ("Instance id must be lowercase...") are set
    // while a draft is open; the Retry gate requires no open draft, so a
    // refused save or an invalid id can never grow a retry button.
    const src = readSectionSource();
    expect(src).toMatch(/!draft/);
    expect(src).not.toMatch(/draftValidation/);
  });

  test('the retry never renders over a loaded list', () => {
    // A failed re-read after a successful load keeps the last good rows;
    // the retry must not render there, since the screen still shows data.
    const src = readSectionSource();
    expect(src).not.toMatch(/instances\.length > 0 && .*Retry/);
    expect(src).not.toMatch(/kinds\.length > 0 && .*Retry/);
  });

  test('the failed-read caption copy is byte-identical', () => {
    // The change adds an affordance beside the caption; it must not restyle
    // or reword the refusal itself.
    const src = readSectionSource();
    expect(src).toMatch(/<Text variant="caption" color="statusDisconnected" selectable>/);
  });

  test('save, delete, and the confirm-gated delete are untouched', () => {
    // The retry is a read affordance only: the draft save path, the secret
    // set path, and the confirm-gated delete must read exactly as before.
    const src = readSectionSource();
    expect(src).toMatch(/registry\.instances\.create/);
    expect(src).toMatch(/registry\.instances\.update/);
    expect(src).toMatch(/registry\.secrets\.set/);
    expect(src).toMatch(/registry\.instances\.delete/);
    expect(src).toMatch(/<ConfirmSheet/);
    expect(src).toMatch(/title="Delete capability\?"/);
  });
});
