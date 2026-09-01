import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// File-content assertions, deliberately: this repo has jest-expo but no
// renderer (no @testing-library/react-native, no react-test-renderer), so a
// component's props cannot be asserted at runtime here. These still fail on the
// regression they guard -- a new <RNText> added without the cap breaks the scan.
const SOURCE = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'markdown', 'markdown-text.tsx'),
  'utf8',
);

describe('MarkdownText caps the OS font scale for compact rows', () => {
  test('every RNText carries maxFontSizeMultiplier', () => {
    // Parse each opening tag rather than pattern-match the file. A regex here
    // silently counted an uncapped element as capped when this test was first
    // written, so split on the tag and inspect only that tag's own attributes.
    const tags = SOURCE.split('<RNText')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf('>')));
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((tag) => !tag.includes('maxFontSizeMultiplier'))).toEqual([]);
  });

  test('compact defaults to 1.4 -- the cap ui/Text.tsx gives the caption variant', () => {
    expect(SOURCE).toContain('maxFontSizeMultiplier ?? (compact ? 1.4 : undefined)');
  });

  test('body scale stays uncapped so large-text users get the size they asked for', () => {
    // The `: undefined` half is the invariant: assistant turns render through
    // the non-compact path and must not inherit the 1.4 cap.
    expect(SOURCE).toContain('compact ? 1.4 : undefined');
  });

  test('the caption cap this restores is still 1.4 in the design system', () => {
    // If ui/Text.tsx changes the caption cap, this fix drifts from the
    // component it was written to match.
    const text = readFileSync(join(__dirname, '..', 'src', 'components', 'ui', 'Text.tsx'), 'utf8');
    expect(text).toMatch(/caption:\s*1\.4/);
  });
});
