import {
  overflowNewSessionHop,
  resolveThreadConfigMode,
  threadConfigBackendsAllowed,
  threadConfigOfferedModes,
  threadConfigTitle,
} from '@/lib/gateway/thread-config';

// Polish roadmap 2.2: sessions/models/backends consolidated into ONE sheet.
// The host owns no visibility state — it derives its mode from the same flags
// the old separate sheets answered to. These pins hold the derivation and the
// title contract so the consolidation cannot silently change which section a
// race resolves to or what the sheet is called per mode.

test('closed when every visibility flag is off', () => {
  expect(
    resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: false, backendsVisible: false }),
  ).toBeNull();
});

test('each flag alone selects its own section', () => {
  expect(
    resolveThreadConfigMode({ sessionsVisible: true, modelsVisible: false, backendsVisible: false }),
  ).toBe('sessions');
  expect(
    resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: true, backendsVisible: false }),
  ).toBe('models');
  expect(
    resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: false, backendsVisible: true }),
  ).toBe('backends');
});

test('precedence mirrors the old stacked mount order: models, then sessions, then backends', () => {
  // The model picker mounted last in chat-screen, so a same-tick collision
  // resolved to it; the derived mode must do exactly the same.
  expect(
    resolveThreadConfigMode({ sessionsVisible: true, modelsVisible: true, backendsVisible: false }),
  ).toBe('models');
  expect(
    resolveThreadConfigMode({ sessionsVisible: true, modelsVisible: false, backendsVisible: true }),
  ).toBe('sessions');
  expect(
    resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: true, backendsVisible: true }),
  ).toBe('models');
  expect(
    resolveThreadConfigMode({ sessionsVisible: true, modelsVisible: true, backendsVisible: true }),
  ).toBe('models');
});

test('titles match the sheets this consolidates', () => {
  expect(threadConfigTitle('sessions')).toBe('Sessions');
  expect(threadConfigTitle('backends')).toBe('Chat backend');
});

test('overflow New session hops to the named Sessions section', () => {
  expect(overflowNewSessionHop()).toBe('sessions');
  expect(threadConfigTitle(overflowNewSessionHop())).toBe('Sessions');
  expect(overflowNewSessionHop()).not.toBe('models');
  expect(overflowNewSessionHop()).not.toBe('backends');
});

test('models title keeps the picker mode wording, including agent targeting', () => {
  expect(threadConfigTitle('models')).toBe('Apply model');
  expect(threadConfigTitle('models', 'default')).toBe('Apply model');
  expect(threadConfigTitle('models', 'fallbacks')).toBe('Fallback models');
  expect(threadConfigTitle('models', 'agent', 'researcher')).toBe('Model for agent researcher');
  // An agent-mode open without an id falls back to the plain title rather
  // than rendering "for agent undefined".
  expect(threadConfigTitle('models', 'agent')).toBe('Apply model');
});

// The backends section's availability gate (rook 2026-08-24): chat-screen's
// offered modes and its close-an-orphaned-section guard share this predicate,
// so an active 'backends' mode can never outlive a list that went away.
describe('threadConfigBackendsAllowed', () => {
  test('configurable thread with loaded backends offers the section', () => {
    expect(threadConfigBackendsAllowed('configurable', 2)).toBe(true);
    expect(threadConfigBackendsAllowed('configurable', 1)).toBe(true);
  });

  test('no backends, no section — even on the configurable thread', () => {
    expect(threadConfigBackendsAllowed('configurable', 0)).toBe(false);
  });

  test('any other surface refuses the section regardless of backends', () => {
    for (const kind of ['bot', 'roster', 'group']) {
      expect(threadConfigBackendsAllowed(kind, 3)).toBe(false);
    }
  });
});

// The agreement invariant (rook 2026-08-24, HIGHEST): the sheet's active mode
// is `resolveThreadConfigMode(visibility)`, and the segmented control renders
// `threadConfigOfferedModes(...)`. When the resolved mode is missing from the
// offered options, the control falls back to highlighting index 0 over a body
// that belongs to another section and taps do nothing until the sheet closes —
// that exact defect was fixed in the screen, and these pins hold the contract
// the screen now renders from, over the whole input space.
describe('mode/offered-modes agreement', () => {
  const visibilities: Array<{
    label: string;
    visibility: { sessionsVisible: boolean; modelsVisible: boolean; backendsVisible: boolean };
  }> = [
    { label: 'all closed', visibility: { sessionsVisible: false, modelsVisible: false, backendsVisible: false } },
    { label: 'sessions', visibility: { sessionsVisible: true, modelsVisible: false, backendsVisible: false } },
    { label: 'models', visibility: { sessionsVisible: false, modelsVisible: true, backendsVisible: false } },
    { label: 'backends', visibility: { sessionsVisible: false, modelsVisible: false, backendsVisible: true } },
    { label: 'sessions+models', visibility: { sessionsVisible: true, modelsVisible: true, backendsVisible: false } },
    { label: 'sessions+backends', visibility: { sessionsVisible: true, modelsVisible: false, backendsVisible: true } },
    { label: 'models+backends', visibility: { sessionsVisible: false, modelsVisible: true, backendsVisible: true } },
    { label: 'all open', visibility: { sessionsVisible: true, modelsVisible: true, backendsVisible: true } },
  ];
  const surfaceKinds = ['configurable', 'bot', 'roster', 'group', 'unknown'];
  const backendsCounts = [0, 1, 2, 5];

  test('the resolved mode is always one of the offered options', () => {
    for (const { visibility } of visibilities) {
      for (const surfaceKind of surfaceKinds) {
        for (const backendsCount of backendsCounts) {
          const mode = resolveThreadConfigMode(visibility);
          const offered = threadConfigOfferedModes({ backendsVisible: visibility.backendsVisible, surfaceKind, backendsCount });
          if (mode !== null) {
            expect(offered).toContain(mode);
          }
          // Order is stable: sessions, models, then backends when offered.
          expect(offered[0]).toBe('sessions');
          expect(offered[1]).toBe('models');
        }
      }
    }
  });

  test('an open backends section stays offered even where availability died (rook regression)', () => {
    // The scenario that broke before 94fa7bb: the picker was open while the
    // surface flipped to a kind that cannot host backends (or the backend list
    // emptied) — the active mode resolved to 'backends' but the offered list
    // no longer contained it, so the SegmentedControl highlighted index 0
    // ('Sessions') over the backends body.
    for (const surfaceKind of ['bot', 'roster', 'group', 'unknown']) {
      const mode = resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: false, backendsVisible: true });
      const offered = threadConfigOfferedModes({ backendsVisible: true, surfaceKind, backendsCount: 0 });
      expect(mode).toBe('backends');
      expect(offered).toContain('backends');
    }
  });

  test('availability gates NEW opens while keeping the open flag honest', () => {
    // Configurable thread with backends, picker NOT visible: 'backends' is
    // offered (the section can be opened) but never the resolved mode.
    const offered = threadConfigOfferedModes({ backendsVisible: false, surfaceKind: 'configurable', backendsCount: 2 });
    expect(offered).toEqual(['sessions', 'models', 'backends']);
    expect(
      resolveThreadConfigMode({ sessionsVisible: false, modelsVisible: false, backendsVisible: false }),
    ).toBeNull();
    // No backends anywhere: the section is not offered at all.
    expect(threadConfigOfferedModes({ backendsVisible: false, surfaceKind: 'configurable', backendsCount: 0 })).toEqual([
      'sessions',
      'models',
    ]);
  });
});
