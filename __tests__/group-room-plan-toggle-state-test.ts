declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
}

// The group-room view renders a collapsible room-plan toggle
// (group-room-view.tsx:461-475) at the top of the room card. The toggle is
// a PressableScale whose label flips between "Collapse room plan" and
// "Show full room plan" based on the `planExpanded` useState at :167 —
// but RN's <Pressable> does not auto-emit accessibilityState, so a screen
// reader focused on the toggle hears only the label and never the runtime
// expanded state (the visible <Text> numberOfLines clamp at :466 is the
// sighted signal). PressableScale spreads PressableProps (which includes
// accessibilityState) onto its inner Pressable, so adding the prop is a
// one-line call-site change that mirrors the established
// chat-roster.tsx:320 / run-card.tsx:135 / gateway-capabilities.tsx:48 /
// environment-card.tsx:53 / thread-config-sheet.tsx:500 pattern.
describe('Group-room plan-toggle screen-reader state', () => {
  test('the room-plan toggle PressableScale declares accessibilityState.expanded bound to planExpanded', () => {
    const src = readGroupRoomViewSource();
    // The room-plan toggle block at :461-475 must carry an accessibilityState
    // whose expanded value mirrors the `planExpanded` boolean — the same
    // value that drives the visible <Text> numberOfLines clamp at :466 and
    // the describeRoomPlan(...) call at :467-473. Anchor on the unique
    // `styles.roomPlanTarget` style to scope the match to the room-plan
    // toggle block (the headActions pill buttons at :477, :490, :504 all
    // use styles.renamePill).
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{planExpanded \? 'Collapse room plan' : 'Show full room plan'\}[\s\S]*?accessibilityState=\{\{\s*expanded:\s*planExpanded\s*\}\}[\s\S]*?\/>/,
    );
  });

  test('the room-plan toggle PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the room-plan toggle PressableScale keeps the accessibilityLabel ternary byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The label is the user-facing sentence the screen reader reads; the
    // new accessibilityState must not change what the button is announced
    // as — only what state it is in. The label is the ternary that swaps
    // on the same boolean as accessibilityState.
    expect(src).toContain(
      "accessibilityLabel={planExpanded ? 'Collapse room plan' : 'Show full room plan'}",
    );
  });

  test('the room-plan toggle PressableScale keeps setPlanExpanded((prev) => !prev) handler byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap. The visible expansion and
    // the label flip are both driven by this handler, so
    // accessibilityState.expanded must follow it, not bypass it.
    expect(src).toMatch(/onPress=\{\(\) => setPlanExpanded\(\(prev\) => !prev\)\}/);
  });

  test('the visible <Text> numberOfLines clamp on planExpanded is byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The numberOfLines clamp is the sighted user's signal that the plan
    // is currently truncated; it must not change. The clamp lifts to
    // undefined when the plan is expanded (1 line → no clamp) and drops
    // back to 1 when collapsed — the same boolean as accessibilityState.
    expect(src).toContain(
      '<Text variant="caption" color="secondary" numberOfLines={planExpanded ? undefined : 1}>',
    );
  });

  test('the describeRoomPlan({...}) call inside the toggle keeps its argument shape byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The describeRoomPlan call is the source of the visible caption text;
    // its argument shape must not change. Pin the four named arguments
    // (plus rosterLoaded) verbatim so any future reordering or rename is
    // caught by the test.
    expect(src).toMatch(
      /describeRoomPlan\(\{[\s\S]*?speakerCount: speakers\.length,[\s\S]*?routableCount: routableSpeakerCount,[\s\S]*?silentNames: silentSpeakerNames,[\s\S]*?unknownNames: unknownSpeakerNames,[\s\S]*?rosterLoaded: inventoryLoaded,[\s\S]*?\}\)/,
    );
  });

  test('the planExpanded useState still declares the boolean default', () => {
    const src = readGroupRoomViewSource();
    // The initial collapse keeps the plan truncated by default; the toggle
    // flips it. accessibilityState.expanded must follow this default
    // until the user taps the toggle.
    expect(src).toMatch(/const \[planExpanded, setPlanExpanded\] = useState\(false\);/);
  });

  test('accessibilityState appears on the room-plan toggle, the member chip, and the Rename/Add pills, and nowhere else in the file', () => {
    const src = readGroupRoomViewSource();
    // Only the room-plan toggle PressableScale carries accessibilityState.
    // The other PressableScale blocks in the file (the Rename pill at
    // :477-488, the Add pill at :490-503, the Disband pill at :504-...) are
    // flat action pills with no boolean state — they must remain
    // accessibilityRole="button" with no accessibilityState. The
    // exclusivity pin guards against a future change that accidentally
    // grows a state prop on the wrong control (or duplicates the prop on
    // this one). Anchor on the unique `styles.roomPlanTarget` style to
    // scope the match to the room-plan toggle block, capturing from
    // <PressableScale to the matching </PressableScale> closing tag.
    const toggleBlock = src.match(
      /<PressableScale[\s\S]*?style=\{styles\.roomPlanTarget\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(toggleBlock).toBeDefined();
    expect(toggleBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*planExpanded\s*\}\}/,
    );

    // Ensure no other PressableScale block in the file carries an
    // accessibilityState prop beyond the four legitimate carriers: the
    // room-plan toggle (expanded), the member chip (disabled, added
    // after this test was written — same precedent as the iter-103
    // Retry-pin flip), and the Rename / Add pills (expanded, bound to
    // renameVisible / addVisible). The Disband pill is a flat
    // fire-and-confirm action with no open state — it must NOT grow
    // an accessibilityState prop.
    expect(src).toContain('accessibilityState={{ expanded: renameVisible }}');
    expect(src).toContain('accessibilityState={{ expanded: addVisible }}');
    const stateCount = (src.match(/accessibilityState=/g) ?? []).length;
    expect(stateCount).toBe(4);
  });
});
