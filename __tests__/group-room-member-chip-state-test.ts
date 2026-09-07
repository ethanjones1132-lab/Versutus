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

// The group-room view renders one chip per member
// (group-room-view.tsx:532-548). Each chip is a PressableScale whose
// label flips between "Remove X" and "Name. <floor reason>." based on
// the `evictable` boolean from `memberIsRemovable(memberId)` at :530
// (itself `removable || deadMemberIds.includes(memberId)` at :206-207)
// — but RN's <Pressable> does not auto-emit accessibilityState, so a
// screen reader focused on a non-evictable chip hears only the label
// and never the disabled state (the untappable chip is the sighted
// signal). PressableScale spreads PressableProps (which includes
// accessibilityState) onto its inner Pressable, so adding the prop is
// a one-line call-site change that mirrors the established
// chat-composer.tsx:336 / chat-header.tsx:94 disabled-state pattern.
describe('Group-room member-chip screen-reader state', () => {
  test('each member chip declares accessibilityState.disabled bound to !evictable', () => {
    const src = readGroupRoomViewSource();
    // Anchor on the chip's unique `styles.memberChip` style to scope the
    // match to the member-chip block (the room-plan toggle at :461-475
    // uses styles.roomPlanTarget; the headActions pills at :477, :490,
    // :504 use styles.renamePill).
    expect(src).toMatch(
      /<PressableScale[\s\S]*?onPress=\{evictable \? \(\) => setPendingRemoval\(memberId\) : undefined\}[\s\S]*?disabled=\{!evictable\}[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityState=\{\{\s*disabled:\s*!evictable\s*\}\}[\s\S]*?styles\.memberChip/,
    );
  });

  test('the member chip keeps accessibilityRole="button" byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The role is what the screen reader uses to decide the control's
    // verb; accessibilityState supplements the role, it does not
    // replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the member chip keeps the evictable ? onPress : undefined gate byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The gate is what actually suppresses the tap on a non-evictable
    // chip; the new accessibilityState must not change which action
    // fires on tap — only what state is announced.
    expect(src).toContain(
      'onPress={evictable ? () => setPendingRemoval(memberId) : undefined}',
    );
  });

  test('the member chip keeps the disabled={!evictable} prop byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The disabled prop is the real platform-disabled state the new
    // accessibilityState mirrors; it must not change.
    expect(src).toContain('disabled={!evictable}');
  });

  test('the member chip keeps the label ternary byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The label is the user-facing sentence the screen reader reads;
    // the new accessibilityState must not change what the chip is
    // announced as — only what state it is in. The non-evictable
    // branch names the floor reason via GROUP_MEMBER_FLOOR_REASON.
    expect(src).toContain('GROUP_MEMBER_FLOOR_REASON}.`');
  });

  test('the room-plan toggle keeps its expanded state byte-identical', () => {
    const src = readGroupRoomViewSource();
    // The room-plan toggle at :461-475 already carries
    // accessibilityState={{ expanded: planExpanded }}; this item must
    // not touch it.
    expect(src).toContain('accessibilityState={{ expanded: planExpanded }}');
  });

  test('exactly two accessibilityState props exist in the file', () => {
    const src = readGroupRoomViewSource();
    // The room-plan toggle (expanded) plus the member chip (disabled).
    // The Rename / Add / Disband pill PressableScale blocks in the same
    // headActions block are flat action pills with no boolean state and
    // must not grow one.
    const count = (src.match(/accessibilityState=/g) ?? []).length;
    expect(count).toBe(2);
  });
});
