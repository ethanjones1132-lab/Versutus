import { rosterCapabilityNotes } from '@/lib/gateway/bots';

test('a gateway that cannot create agents names itself and what still works', () => {
  // Hiding "New Agent" was honest about the refusal but silent about the
  // reason; the note has to say both what is missing and that chat and runs
  // are unaffected.
  expect(rosterCapabilityNotes({ hasBotManagement: false, hasGroupRooms: true })).toEqual([
    'This gateway does not create agents — chat and runs still work.',
  ]);
});

test('a gateway without group rooms gets its own line', () => {
  expect(rosterCapabilityNotes({ hasBotManagement: true, hasGroupRooms: false })).toEqual([
    'This gateway does not host group rooms.',
  ]);
});

test('both capabilities missing produce both notes, in row order', () => {
  // The notes sit exactly where the hidden rows would have sat, so they
  // inherit the rows' order: New Agent first, New Group Room second.
  expect(rosterCapabilityNotes({ hasBotManagement: false, hasGroupRooms: false })).toEqual([
    'This gateway does not create agents — chat and runs still work.',
    'This gateway does not host group rooms.',
  ]);
});

test('a fully capable gateway stays silent', () => {
  // No missing capability, no caption — a complete roster explains nothing
  // because nothing was taken away.
  expect(rosterCapabilityNotes({ hasBotManagement: true, hasGroupRooms: true })).toEqual([]);
});
