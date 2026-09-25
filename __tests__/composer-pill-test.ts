declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

/**
 * S2 — the pill composer (CHARTER priority 2, docs/visual-direction-2026-09
 * locked structure): the thread's dock is ONE rounded pill — a borderless `+`
 * on the left, the field, and a single trailing control that is the mic on an
 * empty draft and the round send the moment there is text. No chip row, no
 * floating terminal, no boxed attach/call/mic/send cluster; everything the
 * pill has no room for is one tap behind the `+`.
 *
 * Behaviour kept: attach, hands-free call, the one-tap commands, browse,
 * mic hold, send/stop, queued copy, palettes, attachment chips.
 */

function readComposerSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

/** The one Card the composer renders — the pill itself. */
function readPillBlock(): string {
  const src = readComposerSource();
  const open = src.indexOf('<Card');
  const close = src.indexOf('</Card>');
  if (open === -1 || close === -1) throw new Error('the composer pill (its one Card) is gone');
  return src.slice(open, close + '</Card>'.length);
}

function styleBlock(src: string, key: string): string {
  const start = src.indexOf(`${key}: {`);
  if (start === -1) throw new Error(`${key} style not found in chat-composer.tsx`);
  return src.slice(start, src.indexOf('},', start) + 2);
}

test('the dock renders one rounded pill and no chip row above it', () => {
  const src = readComposerSource();
  const pill = styleBlock(src, 'pill');
  expect(pill).toMatch(/borderRadius: Radius\.full/);
  expect(pill).toMatch(/marginHorizontal: Spacing\.four/);
  // Exactly one Card in the whole file: the pill. The quick-action chip row
  // and the floating browse button that used to sit above it are gone.
  expect((src.match(/<Card/g) ?? [])).toHaveLength(1);
  expect(src).not.toContain('utilityRow');
  expect(src).not.toContain('quickChip');
  expect(src).not.toContain('utilityButton');
});

test('the `+` is the pill\'s left control and carries no box of its own', () => {
  const src = readComposerSource();
  const pill = readPillBlock();
  const plusAt = pill.indexOf('accessibilityLabel="Add image or command"');
  const fieldAt = pill.indexOf('<TextField');
  expect(plusAt).toBeGreaterThan(-1);
  // Left of the field, in source order — the pill reads + · field · control.
  expect(fieldAt).toBeGreaterThan(plusAt);
  const plusStyle = styleBlock(src, 'plusButton');
  expect(plusStyle).not.toMatch(/borderWidth/);
  expect(plusStyle).not.toMatch(/backgroundColor/);
  expect(plusStyle).toMatch(/borderRadius: Radius\.full/);
});

test('the trailing slot holds exactly one control, and it morphs on text', () => {
  const pill = readPillBlock();
  // Both controls are gated by the one flag: the mic only on an empty draft,
  // the round send/stop only when there is text (or a reply is streaming).
  expect(pill).toContain('!showSend && micState.kind !== \'hidden\'');
  expect(pill).toMatch(/\{showSend \? \(/);
  // Nothing else draws beside the field inside the pill: the attach and
  // hands-free call controls used to sit inline here.
  expect(pill).not.toContain('HANDSFREE_START_LABEL');
  expect(pill).not.toContain('Attach an image');
  expect(pill).not.toContain('paperclip');
  // The send keeps the accent fill, now on a round shape.
  const send = styleBlock(readComposerSource(), 'sendButton');
  expect(send).toMatch(/borderRadius: Radius\.full/);
  expect(readComposerSource()).toContain(
    'backgroundColor: isStreaming ? tokens.accentWarm : tokens.accent',
  );
});

test('the mic is drawn empty-handed: no box, no fill, just the glyph', () => {
  const mic = styleBlock(readComposerSource(), 'micButton');
  expect(mic).not.toMatch(/borderWidth/);
  expect(mic).toMatch(/borderRadius: Radius\.full/);
  expect(mic).toMatch(/width: 44/);
});

test('everything the pill cannot hold is one tap behind the `+`', () => {
  const src = readComposerSource();
  const menuEnd = src.indexOf('{mentionPicks.length > 0');
  const menu = src.slice(src.indexOf('{menuOpen && canOpenMenu ?'), menuEnd);
  expect(menu).toContain('accessibilityLabel="Attach an image"');
  expect(menu).toContain('accessibilityLabel={HANDSFREE_START_LABEL}');
  expect(menu).toContain('accessibilityLabel={`Quick action ${action.label}`}');
  expect(menu).toContain('accessibilityLabel="Browse commands"');
  // The menu is opt-in state, never a panel that renders on its own, and it
  // closes on a row tap so one press does one thing.
  expect(src).toContain('{menuOpen && canOpenMenu ? (');
  expect((menu.match(/setMenuOpen\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
});

test('the field keeps the whole line for the placeholder at phone width', () => {
  const src = readComposerSource();
  const input = styleBlock(src, 'input');
  // Tight internal padding, transparent fill (the pill owns the chrome).
  expect(input).toMatch(/paddingHorizontal: Spacing\.two/);
  expect(input).toMatch(/backgroundColor: 'transparent'/);
  expect(src).toContain('placeholder={copy.placeholder}');
  // With the cluster gone, the empty draft's only neighbour is the mic —
  // the placeholder is never competing with three buttons for the line.
  expect(readComposerSource()).toMatch(/!showSend && micState\.kind !== 'hidden'/);
});
