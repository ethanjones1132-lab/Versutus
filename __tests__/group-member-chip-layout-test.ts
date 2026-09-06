import {
  GROUP_MEMBER_CHIP_PIN_MAX_WIDTH,
  groupMemberChipPinMaxWidth,
} from '@/lib/motion/group-member-chip-layout';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

test('base pin maxWidth is 120 at normal scale', () => {
  expect(GROUP_MEMBER_CHIP_PIN_MAX_WIDTH).toBe(120);
  expect(groupMemberChipPinMaxWidth()).toBe(120);
  expect(groupMemberChipPinMaxWidth(1)).toBe(120);
  expect(groupMemberChipPinMaxWidth(1.0)).toBe(120);
});

test('large fontScale shrinks pin below 100 so 360dp chips still wrap', () => {
  expect(groupMemberChipPinMaxWidth(1.4)).toBeLessThanOrEqual(100);
  expect(groupMemberChipPinMaxWidth(1.4)).toBe(Math.round(120 / 1.4));
});

test('intermediate scale shrinks proportionally', () => {
  expect(groupMemberChipPinMaxWidth(1.2)).toBe(Math.round(120 / 1.2));
  expect(groupMemberChipPinMaxWidth(1.2)).toBeLessThan(120);
  expect(groupMemberChipPinMaxWidth(1.2)).toBeGreaterThan(groupMemberChipPinMaxWidth(1.4));
});

test('fontScale beyond Text cap is clamped to 1.4', () => {
  expect(groupMemberChipPinMaxWidth(2.5)).toBe(groupMemberChipPinMaxWidth(1.4));
  expect(groupMemberChipPinMaxWidth(10)).toBe(groupMemberChipPinMaxWidth(1.4));
});

test('invalid or zero scale falls back to base', () => {
  expect(groupMemberChipPinMaxWidth(0)).toBe(120);
  expect(groupMemberChipPinMaxWidth(-1)).toBe(120);
  expect(groupMemberChipPinMaxWidth(Number.NaN)).toBe(120);
  expect(groupMemberChipPinMaxWidth(undefined as unknown as number)).toBe(120);
});

test('chip pin total width on 360 stays within wrap budget even with long model id', () => {
  // 360dp wrap: two chips per row with 10px gap. Each chip is avatar 22 + name ~80 + paddings ~20 + gap 6 + pin.
  // At base scale: avatar+name+chrome ~= 22+80+20+6=128; + pin 120 = 248 -> wraps to single column (360 < 248*2+10).
  // With scaled pin at 1.0 the test documents intent; at 1.4 the chip tightens.
  // Estimate chip width and assert 360 can fit at least 1 chip without overflow.
  const chipChrome = 22 + 80 + 20 + 6; // avatar + name + paddings + gap
  const pinWidth = groupMemberChipPinMaxWidth(1);
  const chipWidth = chipChrome + pinWidth;
  // Single chip must fit on 360 with padding; two chips at 1.4 should fit width better
  expect(chipWidth).toBeLessThan(360);
  const chipWidthScaled = chipChrome + groupMemberChipPinMaxWidth(1.4);
  expect(chipWidthScaled).toBeLessThan(chipWidth);
  expect(chipWidthScaled).toBeLessThanOrEqual(214); // 128+86
});

test('group room view wires dynamic pin maxWidth via helper', () => {
  const src = readSource('src', 'components', 'chat', 'group-room-view.tsx');
  expect(src).toContain('groupMemberChipPinMaxWidth');
  expect(src).toContain('useWindowDimensions');
  expect(src).toContain('fontScale');
  expect(src).toContain('memberPinMaxWidth');
  expect(src).toContain('maxWidth: memberPinMaxWidth');
  expect(src).toContain("numberOfLines={1}");
});
