declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRunCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'activity', 'run-card.tsx'].join(SEP),
    'utf8',
  );
}

// The RunCard event-log toggle PressableScale (run-card.tsx:128-145) toggles the
// inline event-log expansion via `setExpanded((open) => !open)` at line 131, and
// `expanded` is a real `useState(false)` at line 64, but the PressableScale only
// declares `accessibilityLabel={expanded ? 'Hide event log' : 'Show event log'}`
// and never forwards `expanded` as `accessibilityState`. A VoiceOver/TalkBack user
// therefore hears the label toggle without knowing whether the log is currently
// open. PressableScale spreads PressableProps (which includes accessibilityState)
// onto its inner Pressable, so adding the prop is a one-line call-site change.
describe('RunCard event-log toggle screen-reader state', () => {
  test('the event-log PressableScale declares accessibilityState.expanded bound to expanded', () => {
    const src = readRunCardSource();
    // The event-log toggle PressableScale block at :128-145 must carry an
    // accessibilityState prop whose expanded value mirrors the existing
    // `useState(false)` at :64 — the same value that already drives the label
    // ternary at :134 and the chevron / "Hide events" / "<n> events" text at
    // :136-143.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityLabel=\{expanded \? 'Hide event log' : 'Show event log'\}[\s\S]*?accessibilityState=\{\{\s*expanded\s*\}\}[\s\S]*?style=\{styles\.actionButton\}/,
    );
  });

  test('the event-log PressableScale keeps accessibilityLabel byte-identical', () => {
    const src = readRunCardSource();
    // The label string is the user-facing sentence the screen reader reads;
    // the new accessibilityState must not change what the button is announced
    // as — only what state it is in. The ternary already pairs the right label
    // with the right chevron and count, so adding accessibilityState must not
    // even rename the variable.
    expect(src).toContain(
      "accessibilityLabel={expanded ? 'Hide event log' : 'Show event log'}",
    );
  });

  test('the event-log PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readRunCardSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the event-log PressableScale keeps setExpanded((open) => !open) byte-identical', () => {
    const src = readRunCardSource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap. The visible expansion is
    // driven by this handler, so accessibilityState.expanded must follow it,
    // not bypass it.
    expect(src).toMatch(/setExpanded\(\(open\) => !open\)/);
  });

  test('the event-log PressableScale keeps the count/Hide-events caption byte-identical', () => {
    const src = readRunCardSource();
    // The visible caption is what sighted users see under the chevron: the
    // count of events when collapsed, "Hide events" when expanded. The new
    // accessibilityState must not touch it.
    expect(src).toMatch(
      /expanded \? 'Hide events' : `\$\{run\.events\.length\} events`/,
    );
  });

  test('the event-log PressableScale keeps the run.events.length > 0 gate byte-identical', () => {
    const src = readRunCardSource();
    // A run with no events must not render the toggle at all — there is
    // nothing to expand. The new accessibilityState lives inside the same
    // `run.events.length > 0 ? ... : null` gate, so a run with zero events
    // never grows a stray screen-reader-only button. The JSX ternary ends
    // with `: null}` (the null is wrapped in braces, not a bare `null)`).
    expect(src).toMatch(/run\.events\.length > 0 \?\s*\([\s\S]*?null\}/);
  });

  test('accessibilityState appears on the event-log toggle and is not duplicated on sibling buttons', () => {
    const src = readRunCardSource();
    // Only the event-log PressableScale carries an accessibilityState prop.
    // The sibling buttons in the same actions row (Stop run at :147-160,
    // View run transcript at :162-179, Retry run at :181-198) are flat
    // navigation buttons with no expansion state to announce and must remain
    // accessibilityRole="button" with no accessibilityState. The exclusivity
    // pin guards against a future change that accidentally grows a state prop
    // on the wrong button.
    const eventLogBlock = src.match(
      /run\.events\.length > 0 \?\s*\(\s*<PressableScale[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(eventLogBlock).toBeDefined();
    expect(eventLogBlock).toMatch(/accessibilityState=\{\{\s*expanded\s*\}\}/);
    // Every <PressableScale ... /> (self-closing or block) in the file.
    const allPressables = src.match(/<PressableScale[\s\S]*?\/>/g) ?? [];
    const stateCarriers = allPressables.filter((p) =>
      /accessibilityState=\{\{/.test(p),
    );
    expect(stateCarriers).toHaveLength(1);
  });
});