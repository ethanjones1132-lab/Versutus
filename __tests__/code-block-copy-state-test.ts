declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCodeBlockSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'markdown', 'code-block.tsx'].join(SEP),
    'utf8',
  );
}

// The CodeBlock copy PressableScale (code-block.tsx:37-42) renders the
// `accessibilityLabel={copied ? 'Copied' : 'Copy code'}` ternary and toggles
// the boolean via `handleCopy` (set true by Clipboard.setStringAsync + a 1600ms
// setTimeout reset at :20-25). RN's <Pressable> does not auto-emit
// accessibilityState, so a screen reader focused on the button hears the
// label flip but never the busy state during the ~1.6s confirmation window.
// PressableScale (PressableScale.tsx:9-19) is `Omit<PressableProps, 'style'>`
// with `{...props}` spread to its inner AnimatedPressable, so adding
// `accessibilityState={{ busy: copied }}` directly below the label flows
// straight through to RN's runtime announcement — matching the established
// iter-133/135/136/140/141 accessibilityState pattern.
describe('CodeBlock copy button screen-reader state', () => {
  test('the PressableScale declares accessibilityState.busy bound to copied', () => {
    const src = readCodeBlockSource();
    // The copy PressableScale block at :37-42 must carry an
    // accessibilityState whose busy value mirrors the `copied` useState(false)
    // at :18 — the same value that drives the accessibilityLabel ternary at
    // :41, the icon swap at :45-48, and the visible label at :52-53.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{copied \? 'Copied' : 'Copy code'\}[\s\S]*?accessibilityState=\{\{\s*busy:\s*copied\s*\}\}[\s\S]*?style=\{styles\.copyButton\}>/,
    );
  });

  test('the PressableScale keeps accessibilityLabel byte-identical', () => {
    const src = readCodeBlockSource();
    // The label is the user-facing sentence the screen reader reads; the new
    // accessibilityState must not change what the button is announced as —
    // only what state it is in. The ternary already pairs "Copy code" with
    // the doc-on-doc icon and "Copied" with the checkmark icon, so adding
    // accessibilityState must not even rename the variable.
    expect(src).toContain(
      "accessibilityLabel={copied ? 'Copied' : 'Copy code'}",
    );
  });

  test('the PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readCodeBlockSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the useState hook still declares the boolean default false', () => {
    const src = readCodeBlockSource();
    // The initial copy button shows "Copy code" with the doc-on-doc icon;
    // the tap flips it. The accessibilityState.busy follows the same boolean.
    expect(src).toMatch(/const \[copied, setCopied\] = useState\(false\);/);
  });

  test('handleCopy still sets copied=true and resets it after 1600ms', () => {
    const src = readCodeBlockSource();
    // The confirmation window is exactly 1600ms — long enough for the user
    // to see the checkmark and short enough to revert. The new
    // accessibilityState must not change either number or the order of
    // statements (Clipboard.setStringAsync, haptics.success, setCopied(true),
    // setTimeout reset).
    expect(src).toMatch(/setCopied\(true\)/);
    expect(src).toMatch(/setTimeout\(\(\) => setCopied\(false\), 1600\)/);
  });

  test('the visible Icon swap and Text label byte-identical across both branches', () => {
    const src = readCodeBlockSource();
    // The visible UI is what sighted users see: doc-on-doc icon + "Copy"
    // when not copied, checkmark icon + "Copied" when copied. The new
    // accessibilityState must not touch any of these — it only declares
    // what the screen reader hears.
    expect(src).toContain(
      "{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }",
    );
    expect(src).toContain(
      "{ ios: 'checkmark', android: 'check', web: 'check' }",
    );
    expect(src).toContain("copied ? 'Copied' : 'Copy'");
  });

  test('accessibilityState appears on the copy PressableScale and nowhere else', () => {
    const src = readCodeBlockSource();
    // Only the copy PressableScale carries an accessibilityState prop. The
    // language caption Text at :34 and the code RNText at :58 are not
    // controls and must remain accessibilityState-free. The exclusivity
    // pin guards against a future change that accidentally grows a state
    // prop on the wrong element.
    const copyButtonBlock = src.match(
      /<PressableScale[\s\S]*?accessibilityState=\{\{\s*busy:\s*copied\s*\}\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(copyButtonBlock).toBeDefined();
    const stateCount = (src.match(/accessibilityState=/g) ?? []).length;
    expect(stateCount).toBe(1);
  });
});