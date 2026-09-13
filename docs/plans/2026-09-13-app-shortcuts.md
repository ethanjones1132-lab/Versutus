# App shortcuts on the existing deep-link router (2026-09-13)

Phase B item 2 (`FUTURE-ITEMS.md` item 8): donate Siri / Android launcher shortcuts that map
straight onto the shipped deep-link vocabulary. "One router, many entrances" — no second
router.

## State first

- `versutus://chat?bot=<id>` with composer focus already ships in
  `src/lib/gateway/deep-link.ts` (`chat` target) and `src/app/_layout.tsx`
  (`requestComposerFocus`).
- From M8 the vocabulary also has `versutus://call` (opens the Bot Chat and the confirm
  sheet), `compose`, and `add`.
- What is missing is the OS donation: a static Android shortcut and per-Bot dynamic data.

## Build

1. **Pure model** `src/lib/gateway/shortcuts.ts`: `botChatShortcut(botId)` →
   `{ id, shortLabel, longLabel, url }` with `url = versutus://chat?bot=<id>`;
   `recentBotShortcuts(bots, limit = 3)`; `CALL_SHORTCUT` with `versutus://call`. The model
   only ever produces links the shipped router already answers, pinned by round-tripping
   each `url` through `deepLinkTarget`.
2. **Android config plugin** `plugins/with-voice-shortcuts.js`: write
   `android/app/src/main/res/xml/shortcuts.xml` with the static **Start a voice call**
   shortcut (`versutus://call`) and add the main activity's
   `android.app.shortcuts` meta-data. Registered in `app.json`.
3. **iOS App Intents**: the Swift donation cannot be built or verified on this Windows
   checkout — PENDING-DEVICE, recorded with the rest of the iOS voice work.

## Steps

1. Failing Jest: `__tests__/shortcuts-test.ts` pins the three link shapes, the limit, and
   that each `url` folds through `deepLinkTarget` to the expected target.
2. Run it; it fails (module missing).
3. Implement `shortcuts.ts`; run green.
4. Failing test for `buildShortcutsXml()` and the manifest mod applied to a mock config;
   implement the plugin; register it in `app.json`.
5. `npm run verify` EXIT=0; commit.

## Acceptance

- **PENDING-DEVICE:** a launcher shortcut and a Siri phrase each land on the intended Bot
  Chat with the composer focused.

## Out of scope (recorded)

Dynamic per-Bot Android shortcuts need a runtime `ShortcutManager` call from the app; the
static shortcut plus this link model is the contract. iOS App Intents are Android-only on
this checkout.

