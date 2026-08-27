import {
  chatHeaderChipLayout,
  chatHeaderSessionChip,
  chatHeaderTitle,
} from '@/lib/motion/chat-header-layout';

test('a 390-wide phone stacks when both chips are offered', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: true, session: true }),
  ).toBe('stacked');
});

test('a 768-wide window keeps both chips on the title row', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 768, model: true, session: true }),
  ).toBe('row');
});

test('a single chip still fits on a 390-wide phone', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: true, session: false }),
  ).toBe('row');
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: false, session: true }),
  ).toBe('row');
});

test('no chips stay on the title row', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: false, session: false }),
  ).toBe('row');
});

test('an unmeasured window stacks rather than clipping the chips', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 0, model: true, session: true }),
  ).toBe('stacked');
  expect(
    chatHeaderChipLayout({ windowWidth: Number.NaN, model: true, session: true }),
  ).toBe('stacked');
});

test('a group room titles the room, not the gateway', () => {
  expect(
    chatHeaderTitle({ gatewayName: 'Office Gate', groupName: 'Standup' }),
  ).toBe('Standup');
});

test('a group room still titles the room when a backend label is also present', () => {
  expect(
    chatHeaderTitle({
      gatewayName: 'Office Gate',
      backendLabel: 'Hermes',
      groupName: 'Standup',
    }),
  ).toBe('Standup');
});

test('a blank group name still titles the gateway', () => {
  expect(
    chatHeaderTitle({ gatewayName: 'Office Gate', groupName: '  ' }),
  ).toBe('Office Gate');
});

test('a thread titles the backend, else the gateway', () => {
  expect(
    chatHeaderTitle({ gatewayName: 'Office Gate', backendLabel: 'Hermes' }),
  ).toBe('Hermes');
  expect(chatHeaderTitle({ gatewayName: 'Office Gate' })).toBe('Office Gate');
});

test('a group room never shows a session chip', () => {
  expect(chatHeaderSessionChip({ surface: 'group' })).toBe(false);
});

test('a 360-wide phone at large fontScale stacks two chips while 390 at normal scale respects single-chip row', () => {
  // Backlog P2: 360dp + 1.4x font, two chips must stack; single chip still fits on 390 at 1.0.
  expect(chatHeaderChipLayout({ windowWidth: 360, model: true, session: true, fontScale: 1.4 })).toBe(
    'stacked',
  );
  expect(chatHeaderChipLayout({ windowWidth: 390, model: true, session: false, fontScale: 1.0 })).toBe(
    'row',
  );
});

test('large fontScale forces stacked earlier than normal scale', () => {
  // 600dp fits both chips at 1.0 but not at 1.4 because chip+title scale.
  expect(chatHeaderChipLayout({ windowWidth: 600, model: true, session: true, fontScale: 1.0 })).toBe(
    'row',
  );
  expect(chatHeaderChipLayout({ windowWidth: 600, model: true, session: true, fontScale: 1.4 })).toBe(
    'stacked',
  );
});

test('fontScale beyond the Text cap is clamped', () => {
  expect(chatHeaderChipLayout({ windowWidth: 600, model: true, session: true, fontScale: 2.5 })).toBe(
    chatHeaderChipLayout({ windowWidth: 600, model: true, session: true, fontScale: 1.4 }),
  );
});

test('a thread shows a session chip only when it can open Sessions', () => {
  expect(
    chatHeaderSessionChip({
      surface: 'thread',
      sessionLabel: 'Untitled',
      sessionPress: true,
    }),
  ).toBe(true);
  expect(
    chatHeaderSessionChip({
      surface: 'thread',
      sessionLabel: 'Untitled',
      sessionPress: false,
    }),
  ).toBe(false);
  expect(
    chatHeaderSessionChip({ surface: 'thread', sessionPress: true }),
  ).toBe(false);
});
