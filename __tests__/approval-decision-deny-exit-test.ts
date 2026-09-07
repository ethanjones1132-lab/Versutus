declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCardSource(): string {
  // approval-decision-card.tsx is CRLF on disk; normalize so the regexes
  // below are line-ending independent.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'approval-decision-card.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('approval decision card deny exit motion', () => {
  const src = readCardSource();

  test('Deny animates scale, opacity, and borderProgress on the same branch', () => {
    // The whole point of the fix: a Deny used to animate only the red
    // border, so the card sat still with a flashing red border for the
    // full 320ms and then snapped out of existence. Now the scale + opacity
    // fold mirrors the Approve branch, so both exits leave with the same
    // rhythm — only the durations (and the border flash) differ.
    const denyBlock = src.match(/else\s*\{[\s\S]*?void haptics\.warning\(\)[\s\S]*?\n\s*\}/)?.[0];
    expect(denyBlock).toBeDefined();
    expect(denyBlock!).toMatch(/borderProgress\.value\s*=\s*withTiming\(\s*1\s*,\s*\{\s*duration:\s*approvalExitDuration\(\s*['"]denying['"]\s*\)\s*\}\s*\)/);
    expect(denyBlock!).toMatch(/scale\.value\s*=\s*withTiming\(\s*0\.92\s*,\s*\{\s*duration:\s*approvalExitDuration\(\s*['"]denying['"]\s*\)\s*\}\s*\)/);
    expect(denyBlock!).toMatch(/opacity\.value\s*=\s*withTiming\(\s*0\s*,\s*\{\s*duration:\s*approvalExitDuration\(\s*['"]denying['"]\s*\)\s*\}\s*\)/);
  });

  test('Deny uses the denying duration (320ms), not the approving duration', () => {
    // The deliberate asymmetric pair: Approve folds at 280ms, Deny at
    // 320ms (heavier — the border flash needs time to read). The new
    // scale + opacity calls must use the denying duration so the three
    // animations stay synchronized and finish with the existing setTimeout.
    const denyBlock = src.match(/else\s*\{[\s\S]*?void haptics\.warning\(\)[\s\S]*?\n\s*\}/)?.[0];
    expect(denyBlock).toBeDefined();
    // Each of the three withTiming calls in the Deny branch must reference
    // the denying duration — no Approve-duration leakage.
    const durations = denyBlock!.match(/approvalExitDuration\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
    expect(durations.length).toBe(3);
    durations.forEach((d) => {
      expect(d).toBe("approvalExitDuration('denying')");
    });
  });

  test('Approve still never touches borderProgress', () => {
    // Approve is the silent, neutral exit — no red flash. The border stays
    // at the warm accent while the card folds. Only Deny writes to
    // borderProgress; a fix that touched it on Approve would make a
    // friendly Approve flash red.
    const approveBlock = src.match(/if\s*\(\s*approved\s*\)\s*\{[\s\S]*?void haptics\.success\(\)[\s\S]*?\n\s*\}/)?.[0];
    expect(approveBlock).toBeDefined();
    expect(approveBlock!).not.toMatch(/borderProgress/);
  });

  test('Approve still animates scale and opacity to the approving duration', () => {
    // Must still: the Approve path is byte-identical to the pre-fix
    // behavior. A memo/diff that swapped the duration would read as the
    // same fix and pass the gate but ship a regression.
    const approveBlock = src.match(/if\s*\(\s*approved\s*\)\s*\{[\s\S]*?void haptics\.success\(\)[\s\S]*?\n\s*\}/)?.[0];
    expect(approveBlock).toBeDefined();
    expect(approveBlock!).toMatch(/scale\.value\s*=\s*withTiming\(\s*0\.92\s*,\s*\{\s*duration:\s*approvalExitDuration\(\s*['"]approving['"]\s*\)\s*\}\s*\)/);
    expect(approveBlock!).toMatch(/opacity\.value\s*=\s*withTiming\(\s*0\s*,\s*\{\s*duration:\s*approvalExitDuration\(\s*['"]approving['"]\s*\)\s*\}\s*\)/);
    const durations = approveBlock!.match(/approvalExitDuration\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
    expect(durations.length).toBe(2);
    durations.forEach((d) => {
      expect(d).toBe("approvalExitDuration('approving')");
    });
  });

  test('the locked / busy / setExit / setTimeout / onResolve forwarding is unchanged', () => {
    // The Deny fix is motion-only. The lifecycle decisions (locked.current,
    // busy, setExit(next), the setTimeout keyed on approvalExitDuration(next),
    // and the onResolve(approved, feedback) hand-off) all stay byte-identical
    // so a fix that breaks the gating would still pass the gate but ship
    // a card the user could double-decide on.
    const decideBlock = src.match(/const\s+decide\s*=\s*\([\s\S]*?\n\s*\};/)?.[0];
    expect(decideBlock).toBeDefined();
    expect(decideBlock!).toMatch(/if\s*\(\s*locked\.current\s*\)\s*return/);
    expect(decideBlock!).toMatch(/locked\.current\s*=\s*true/);
    expect(decideBlock!).toMatch(/setExit\(\s*next\s*\)/);
    expect(decideBlock!).toMatch(/const\s+trimmed\s*=\s*feedbackText\.trim\(\)/);
    expect(decideBlock!).toMatch(/const\s+feedback\s*=\s*approved\s*\?\s*undefined\s*:\s*trimmed/);
    expect(decideBlock!).toMatch(/const\s+duration\s*=\s*approvalExitDuration\(\s*next\s*\)/);
    expect(decideBlock!).toMatch(/setTimeout\(\(\)\s*=>\s*onResolve\(\s*approved\s*,\s*feedback\s*\),\s*duration\s*\)/);
  });

  test('the haptic split (success on Approve, warning on Deny) is unchanged', () => {
    // The two branches still lead with their distinct haptics — Approve
    // fires success, Deny fires warning. Adding scale + opacity to the
    // Deny branch must not have moved or duplicated either haptic.
    expect(src).toMatch(/void haptics\.success\(\)/);
    expect(src).toMatch(/void haptics\.warning\(\)/);
  });
});