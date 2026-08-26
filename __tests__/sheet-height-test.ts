import { sheetMaxHeight, sheetMaxWidth, SHEET_MARGIN } from '@/lib/motion/sheet-height';

test('a sheet never claims more than the screen minus system chrome', () => {
  // Reported 2026-08-25: the session picker grew past the top of the screen,
  // so its header — eyebrow, title, "New session" — was simply not reachable.
  const height = sheetMaxHeight({ windowHeight: 2340, insetTop: 96, insetBottom: 48 });
  const { outer, inner } = SHEET_MARGIN.bottom;
  expect(height).toBe(2340 - 96 - 48 - outer - inner);
  expect(height).toBeLessThan(2340);
});

test('the top-anchored variant uses its own smaller margins', () => {
  const bottom = sheetMaxHeight({ windowHeight: 1000, position: 'bottom' });
  const top = sheetMaxHeight({ windowHeight: 1000, position: 'top' });
  expect(top).toBeGreaterThan(bottom);
});

test('system insets are what keep it off the status and navigation bars', () => {
  const withoutInsets = sheetMaxHeight({ windowHeight: 2340 });
  const withInsets = sheetMaxHeight({ windowHeight: 2340, insetTop: 96, insetBottom: 48 });
  expect(withoutInsets - withInsets).toBe(144);
});

test('an unmeasured window yields a usable floor, not a collapsed sheet', () => {
  // First paint can report 0. Returning 0 would render an invisible sheet,
  // which is a worse failure than being briefly too short.
  expect(sheetMaxHeight({ windowHeight: 0 })).toBe(240);
  expect(sheetMaxHeight({ windowHeight: Number.NaN })).toBe(240);
  expect(sheetMaxHeight({ windowHeight: -100 })).toBe(240);
});

test('a very short screen still gets the floor rather than a negative height', () => {
  expect(sheetMaxHeight({ windowHeight: 200, insetTop: 90, insetBottom: 90 })).toBe(240);
});

test('nonsense insets cannot inflate the ceiling', () => {
  // A negative inset would otherwise ADD height and reintroduce the overflow.
  expect(sheetMaxHeight({ windowHeight: 1000, insetTop: -500 })).toBe(
    sheetMaxHeight({ windowHeight: 1000, insetTop: 0 }),
  );
});

test('a tablet sheet is a 560-wide column, not window minus 24', () => {
  expect(sheetMaxWidth({ windowWidth: 1024 })).toBe(560);
});

test('a phone sheet keeps the 24px inset on each side', () => {
  expect(sheetMaxWidth({ windowWidth: 390 })).toBe(342);
});
