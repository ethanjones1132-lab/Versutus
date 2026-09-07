declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readConfirmSheet(): string {
  return readSource(['src', 'components', 'ui', 'ConfirmSheet.tsx']);
}

function readRoom(): string {
  return readSource(['src', 'components', 'chat', 'group-room-view.tsx']);
}

// The Disband ConfirmSheet swaps its label to 'Disbanding…' around the real
// `disbanding` boolean but announced nothing to a screen reader while the
// delete was in flight. The fix adds an optional `busy` to
// `ConfirmSheetProps`, forwards it onto the confirm Button (which spreads it
// defined-only into accessibilityState), and passes `busy={disbanding}` at
// the disband call site only — mirroring the `Button.tsx:38` pattern.
describe('confirm sheet busy state', () => {
  test('ConfirmSheetProps declares an optional busy boolean', () => {
    const src = readConfirmSheet();
    // Optional so a plain confirm never newly announces `busy`.
    expect(src).toMatch(/busy\?: boolean;/);
  });

  test('ConfirmSheet destructures the busy prop', () => {
    const src = readConfirmSheet();
    expect(src).toMatch(/danger = true,\n\s+busy,\n\s+onCancel,/);
  });

  test('ConfirmSheet forwards busy onto the confirm Button only', () => {
    const src = readConfirmSheet();
    expect(src).toContain('busy={busy}');
    // Exactly one busy wiring: the confirm Button. The Cancel Button stays
    // a plain reversible action with no state to announce.
    expect(src.match(/busy=\{/g)?.length ?? 0).toBe(1);
  });

  test('the Cancel Button stays byte-identical', () => {
    const src = readConfirmSheet();
    expect(src).toContain('<Button label="Cancel" variant="ghost" onPress={onCancel} />');
  });

  test('the confirm Button keeps its variant and haptics wiring', () => {
    const src = readConfirmSheet();
    expect(src).toContain("variant={danger ? 'primary' : 'secondary'}");
    expect(src).toContain('Haptics.NotificationFeedbackType.Success');
    expect(src).toContain('onConfirm();');
  });

  test('the disband ConfirmSheet passes busy={disbanding}', () => {
    const src = readRoom();
    expect(src).toContain('busy={disbanding}');
  });

  test('busy={disbanding} wires exactly once in the room view', () => {
    const src = readRoom();
    expect(src.match(/busy=\{disbanding\}/g)?.length ?? 0).toBe(1);
  });

  test('the Disband confirmLabel ternary stays byte-identical', () => {
    const src = readRoom();
    expect(src).toContain("confirmLabel={disbanding ? 'Disbanding…' : 'Disband'}");
  });

  test('the Disband title and message stay byte-identical', () => {
    const src = readRoom();
    expect(src).toContain('title="Disband room"');
    expect(src).toContain(
      'message={`${group.name} leaves the roster and its transcript is deleted from the Gate. This cannot be undone.`}',
    );
  });

  test('the Disband cancel guard stays byte-identical', () => {
    const src = readRoom();
    expect(src).toMatch(/onCancel=\{\(\) => \{\n\s+if \(disbanding\) return;/);
  });

  test('the member-remove ConfirmSheet in the same file carries no busy', () => {
    const src = readRoom();
    const start = src.indexOf('visible={pendingRemoval !== null}');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('/>', start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('busy');
  });

  test('no other ConfirmSheet call site passes busy', () => {
    const others = [
      ['src', 'components', 'chat', 'thread-config-sheet.tsx'],
      ['src', 'components', 'chat', 'group-room-action-sheet.tsx'],
      ['src', 'components', 'activity', 'cron-job-sheet.tsx'],
      ['src', 'components', 'gateway', 'environment-actions-sheet.tsx'],
      ['src', 'components', 'gateway', 'gateway-home-dashboard.tsx'],
      ['src', 'components', 'gateway', 'capabilities-section.tsx'],
      ['src', 'components', 'gateway', 'paired-devices-pane.tsx'],
      ['src', 'components', 'gateway', 'gateway-management-section.tsx'],
      ['src', 'components', 'gateway', 'provider-actions-sheet.tsx'],
    ];
    for (const rel of others) {
      const src = readSource(rel);
      const blocks = src.match(/<ConfirmSheet[\s\S]*?\/>/g) ?? [];
      // Every file above renders at least one ConfirmSheet; an empty match
      // would mean the pin silently stopped checking that file.
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).not.toContain('busy');
      }
    }
  });

  test('the Disband pill hint stays the only hint in the room view', () => {
    const src = readRoom();
    expect(src).toContain(
      'accessibilityHint="Opens a confirmation, then removes this room from the roster and deletes its transcript. This cannot be undone."',
    );
    expect(src.match(/accessibilityHint/g)?.length ?? 0).toBe(1);
  });
});
