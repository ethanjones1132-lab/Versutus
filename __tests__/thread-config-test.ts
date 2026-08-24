import {
  resolveThreadConfigMode,
  threadConfigBackendsAllowed,
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
