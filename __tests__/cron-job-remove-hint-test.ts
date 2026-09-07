declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-job-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readButtonSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'Button.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readButtonTypesSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'types.ts'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('cron-job-sheet remove hint', () => {
  test('the kit Button type declares an optional accessibilityHint prop', () => {
    // The sheet passes `accessibilityHint` on the Remove button; the kit
    // Button's prop type must accept it before the call site type-checks.
    // Reading types.ts directly avoids relying on the (working) TS build:
    // a future regression that drops the prop field would surface here
    // before reaching the runtime. The hint field already shipped on
    // ButtonProps during the paired-devices Revoke hint iteration.
    const types = readButtonTypesSource();
    expect(types).toMatch(/accessibilityHint\?:/);
    expect(types).toMatch(/export\s+type\s+ButtonProps\s*=\s*\{[\s\S]*?accessibilityHint\?:/);
  });

  test('the kit Button forwards accessibilityHint to PressableScale', () => {
    // PressableScale already spreads PressableProps onto its inner
    // Pressable, so the only plumbing the kit needs is to destructure
    // accessibilityHint out of ButtonProps and pass it through. A
    // regression that destructures but forgets to forward would silently
    // drop the hint for every caller — pin both halves.
    const button = readButtonSource();
    expect(button).toMatch(/accessibilityHint,\n\s+expanded,\n\s*\}\s*:\s*ButtonProps/);
    expect(button).toMatch(/accessibilityHint=\{accessibilityHint\}/);
  });

  test('the Remove button carries the destructive accessibilityHint', () => {
    // The Remove button is destructive: it opens a ConfirmSheet whose
    // consequence ("this scheduled job will be removed … its run history
    // stops here") is invisible to a screen-reader user until focus
    // arrives there. The hint names the consequence *before* the tap,
    // mirroring the wording the visible ConfirmSheet message uses. The
    // hint says what happens, the ConfirmSheet confirms it on tap.
    const src = readSheetSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this scheduled job and stops its run history\."/,
    );
    // The hint must live on the Remove button block specifically — not
    // on the Run now / Pause/Resume buttons or the row. Pin the
    // call-site adjacency.
    expect(src).toMatch(
      /label="Remove"[\s\S]*?accessibilityHint="Opens a confirmation, then removes this scheduled job and stops its run history\./,
    );
  });

  test('the Run now and Pause/Resume buttons never carry accessibilityHint', () => {
    // Both controls are reversible and gated by the same `acting` flag
    // the Remove button uses. A hint on either would be noise and would
    // mislead a screen-reader user into expecting consequence where
    // there is none. Pin both absences so a future "hint on every
    // ghost button" regression fails loudly.
    const src = readSheetSource();
    // The Run now block stays exactly as iter-121 left it.
    expect(src).toMatch(/label=\{acting \? 'Working…' : 'Run now'\}[\s\S]*?onPress=\{\(\) => void submitRun\(\)\}/);
    const runNowBlock = src.match(/<Button\s+label=\{acting \? 'Working…' : 'Run now'\}[\s\S]*?\/>/)?.[0];
    expect(runNowBlock).toBeDefined();
    expect(runNowBlock!).not.toMatch(/accessibilityHint/);
    // The Pause/Resume block stays exactly as iter-121 left it.
    expect(src).toMatch(/label=\{cronJobPauseLabel\(\{ paused \}\)\}[\s\S]*?onPress=\{\(\) => void submitTogglePause\(\)\}/);
    const pauseBlock = src.match(/<Button\s+label=\{cronJobPauseLabel\(\{ paused \}\)\}[\s\S]*?\/>/)?.[0];
    expect(pauseBlock).toBeDefined();
    expect(pauseBlock!).not.toMatch(/accessibilityHint/);
  });

  test('the Remove Button acting disabled gate and setRemoveTarget handler stay byte-identical', () => {
    // A hint addition that nudged the gate would render a destructive
    // button on a job the operator already mid-handles, or wired the
    // handler to something else. Pin both: disabled={acting} and the
    // setRemoveTarget(jobId) arrow.
    const src = readSheetSource();
    const removeBlock = src.match(/<Button\s+label="Remove"[\s\S]*?\/>/)?.[0];
    expect(removeBlock).toBeDefined();
    expect(removeBlock!).toMatch(/variant="ghost"/);
    expect(removeBlock!).toMatch(/size="sm"/);
    expect(removeBlock!).toMatch(/disabled=\{acting\}/);
    expect(removeBlock!).toMatch(/onPress=\{\(\) => jobId && setRemoveTarget\(jobId\)\}/);
  });

  test('the destructive ConfirmSheet stays byte-identical', () => {
    // The on-tap wording already names the consequence for sighted
    // users. The hint is for screen-reader users *before* the tap; the
    // ConfirmSheet itself must not change wording, copy, or semantics.
    const src = readSheetSource();
    expect(src).toMatch(/title="Remove scheduled job\?"/);
    expect(src).toMatch(
      /message=\{`\$\{job\.title \|\| job\.id\} will be removed from this gateway\. Its run history stops here\.`\}/,
    );
    expect(src).toMatch(/confirmLabel="Remove"/);
    expect(src).toMatch(/danger\s*\n\s*onCancel=/);
  });
});