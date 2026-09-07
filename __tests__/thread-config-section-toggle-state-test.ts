declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readThreadConfigSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'thread-config-sheet.tsx'].join(SEP),
    'utf8',
  );
}

// The thread-config-sheet model picker renders a collapsible section header
// (thread-config-sheet.tsx:496-501) for each provider group. The header is a
// PressableScale whose label flips between "Collapse <group> models" and
// "Expand <group> models" based on `open = isExpanded(section.key)` (the
// `expanded` useState at :400 plus the `fallbackExpandedKey` default at :414)
// — but RN's <Pressable> does not auto-emit accessibilityState, so a screen
// reader focused on the header hears only the label and never the runtime
// expanded state. PressableScale spreads PressableProps (which includes
// accessibilityState) onto its inner Pressable, so adding the prop is a
// one-line call-site change that mirrors the established
// gateway-capabilities.tsx:48 / environment-card.tsx:53 / run-card.tsx:135
// pattern.
describe('Thread-config section-header screen-reader state', () => {
  test('the section-header PressableScale declares accessibilityState.expanded bound to open', () => {
    const src = readThreadConfigSource();
    // The header block at :496-501 must carry an accessibilityState whose
    // expanded value mirrors the `open` boolean (from isExpanded at :494,
    // fed by the expanded useState at :400) — the same value that drives
    // the chevron swap at :502-506 and the data slice at :552. Anchor on
    // the unique `styles.sectionHeader` style to scope the match to the
    // section-header block (the other PressableScale blocks in the file
    // use styles.sessionCard / styles.modelCard).
    expect(src).toMatch(
      /style=\{styles\.sectionHeader\}[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{\`\$\{open \? 'Collapse' : 'Expand'\} \$\{section\.title\} models`\}[\s\S]*?accessibilityState=\{\{\s*expanded:\s*open\s*\}\}[\s\S]*?\/>[\s\S]*?<\/PressableScale>/,
    );
  });

  test('the section-header PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readThreadConfigSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it. The
    // role is set unconditionally here (unlike chat-header's conditional
    // role), so the pin is the literal source line — there are several
    // accessibilityRole="button" lines in the file, so anchor to the
    // section-header block by requiring the surrounding sectionHeader
    // style identifier.
    expect(src).toContain('style={styles.sectionHeader}\n          accessibilityRole="button"');
  });

  test('the section-header PressableScale keeps the accessibilityLabel ternary byte-identical', () => {
    const src = readThreadConfigSource();
    // The label is the user-facing sentence the screen reader reads; the
    // new accessibilityState must not change what the button is announced
    // as — only what state it is in. The label is the ternary that swaps
    // on the same boolean as accessibilityState.
    expect(src).toContain(
      'accessibilityLabel={`${open ? \'Collapse\' : \'Expand\'} ${section.title} models`}',
    );
  });

  test('the section-header PressableScale keeps toggleSection(section.key) handler byte-identical', () => {
    const src = readThreadConfigSource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap. The visible expansion is
    // driven by this handler, so accessibilityState.expanded must follow it,
    // not bypass it.
    expect(src).toMatch(/onPress=\{\(\) => toggleSection\(section\.key\)\}/);
  });

  test('the section-header chevron Icon swap on the open boolean is byte-identical', () => {
    const src = readThreadConfigSource();
    // The chevron direction is the visible cue for sighted users; it must
    // not change. The Icon name ternary swaps between chevron.down/
    // expand_more (open) and chevron.right/chevron_right (closed).
    expect(src).toContain(
      "open\n                ? { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }\n                : { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }",
    );
  });

  test('the section-header Badge label={String(section.data.length)} is byte-identical', () => {
    const src = readThreadConfigSource();
    // The model count badge per section is the second visible signal; the
    // accessibilityState addition must not change the rendered Badge.
    expect(src).toContain(
      '<Badge label={String(section.data.length)} tone="neutral" dot={false} />',
    );
  });

  test('the expanded useState still declares the boolean default', () => {
    const src = readThreadConfigSource();
    // The initial collapse keeps every group closed by default; the
    // fallbackExpandedKey at :414 opens only the current model's group.
    // The toggle flips it.
    expect(src).toMatch(/const \[expanded, setExpanded\] = useState<Record<string, boolean>>\(\{\}\);/);
  });

  test('the isExpanded callback still reads fallbackExpandedKey for the default-open group', () => {
    const src = readThreadConfigSource();
    // The fallbackExpandedKey (current model's group, or the first group)
    // is what isExpanded uses when no user toggle has been recorded yet —
    // accessibilityState.expanded must follow the same default logic.
    expect(src).toMatch(
      /\(key: string\) => \(searching \? true : \(expanded\[key\] \?\? key === fallbackExpandedKey\)\)/,
    );
  });

  test('accessibilityState appears on the section-header PressableScale and nowhere else in the file', () => {
    const src = readThreadConfigSource();
    // Only the section-header PressableScale carries accessibilityState.
    // The other PressableScale blocks in the file (the session-card at
    // :204-245 with the delete-button at :225-232, and the model-card at
    // :445-485) are flat selection controls with no boolean state the
    // header's pattern applies to — they must remain accessibilityRole=
    // "button" with no accessibilityState. The exclusivity pin guards
    // against a future change that accidentally grows a state prop on the
    // wrong control (or duplicates the prop on this one). Anchor on the
    // unique `styles.sectionHeader` style to scope the match to the
    // section-header block, capturing from <PressableScale to its
    // </PressableScale> closing tag.
    const headerBlock = src.match(
      /<PressableScale\s+style=\{styles\.sectionHeader\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(headerBlock).toBeDefined();
    expect(headerBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*open\s*\}\}/,
    );

    // Ensure no other PressableScale block in the file carries an
    // accessibilityState prop. The session-card (onPress of `async () =>
    // { ... onSelect?.(item.id); }` at :214), the session-delete-button
    // (onPress of `() => confirmDelete(item)` at :226), and the model-card
    // (onPress of `async () => { ... onSelect?.(item.id, item.providerId
    // ?? item.provider); }` at :457) are flat selection controls with no
    // expansion state — they must NOT grow an accessibilityState prop.
    // The accessibilityState prop is unique to the section-header block.
    const stateCount = (src.match(/accessibilityState=/g) ?? []).length;
    expect(stateCount).toBe(1);
  });
});
