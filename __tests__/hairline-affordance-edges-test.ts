declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/**
 * S4b (`docs/visual-direction-2026-09.md`): the shared surface no longer rings
 * itself, so the widened elevation step is what separates a card from the
 * stage. The flip side of that rule is that a *ring now means something* — it
 * is only correct where an affordance needs an edge.
 *
 * These are the edges that mean something. Each one used to sit on top of the
 * GlassSurface default hairline, and each one already declares its own width,
 * so they survived the default going silent. This test pins that: without it,
 * a later "tidy up the redundant borders" pass would quietly strip the focus
 * ring off a text field, the edge off a failure, or the lift off a sheet, and
 * nothing else in the app would notice.
 */
const AFFORDANCE_EDGES = [
  {
    label: 'a focused or invalid text field still shows which field you are in',
    parts: ['src', 'components', 'ui', 'TextField.tsx'],
    keep: ["const borderWidth = validationState === 'default' ? StyleSheet.hairlineWidth : 1.5;"],
  },
  {
    label: 'the iOS text field matches it',
    parts: ['src', 'components', 'ui', 'TextField.ios.tsx'],
    keep: ["borderWidth: validationState === 'default' ? StyleSheet.hairlineWidth : 1.5,"],
  },
  {
    label: 'a failure says so with its own edge, not the default one',
    parts: ['src', 'components', 'ui', 'ErrorCard.tsx'],
    keep: [
      '{ borderColor: tokens.statusDisconnected }',
      'borderWidth: StyleSheet.hairlineWidth,',
    ],
  },
  {
    label: 'a floating sheet keeps a lift edge over the transcript',
    parts: ['src', 'components', 'ui', 'BaseSheet.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth * 2,'],
  },
  {
    label: 'a secondary button keeps a button edge on the flat stage',
    parts: ['src', 'components', 'ui', 'Button.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth,'],
  },
  {
    label: 'a badge keeps its tone edge',
    parts: ['src', 'components', 'ui', 'Badge.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth,'],
  },
  {
    label: 'a chip keeps a resting edge so unselected still reads as a pill',
    parts: ['src', 'components', 'ui', 'Chip.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth,'],
  },
  {
    label: 'the selected segment keeps the indicator edge',
    parts: ['src', 'components', 'ui', 'SegmentedControl.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth,'],
  },
  {
    label: 'a live call banner over the thread keeps its own edge',
    parts: ['src', 'components', 'voice', 'handsfree-call-banner.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth * 2,'],
  },
  {
    label: 'a pairing connection pill declares the pairing edge explicitly',
    parts: ['src', 'components', 'connection-badge.tsx'],
    keep: ['borderWidth: StyleSheet.hairlineWidth * 2,'],
  },
] as const;

it.each(AFFORDANCE_EDGES)('$label', ({ parts, keep }) => {
  const src = readSource(...parts);
  for (const needle of keep) {
    expect(src).toContain(needle);
  }
});

it('the shared surface is the only place a default width was removed', () => {
  // The rule is "silence by default, declared where it means something" — so
  // the three platform surfaces must not reintroduce a width of their own, and
  // no other primitive may quietly depend on one.
  for (const file of ['GlassSurface.tsx', 'GlassSurface.ios.tsx', 'GlassSurface.web.tsx']) {
    const src = readSource('src', 'components', 'ui', file);
    expect(src).not.toMatch(/borderWidth: StyleSheet\.hairlineWidth/);
  }
  const variants = readSource('src', 'components', 'ui', 'glass-variants.ts');
  const mapping = variants.slice(variants.indexOf('export const glassVariantStyles'));
  expect((mapping.match(/borderWidth: 0/g) ?? []).length).toBe(4);
});
