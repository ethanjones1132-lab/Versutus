// ─── Donated app shortcuts speak the app's deep-link vocabulary ─────────────
// The deep-link fold already parses `versutus://chat?bot=<id>` into a Bot's
// Bot Chat (src/lib/gateway/deep-link.ts) and the router opens it once the
// gateway is connected — the donation half was the missing entrance. This
// plugin gives the platform buttons (Siri on iOS, long-press on Android) links
// in exactly that spelling, so the shortcut fills the vocabulary an entrance
// already reads and this file carries no routing logic of its own (the
// one-router-many-entrances rule).
//
// The iOS half is an `App Shortcuts` Info.plist entry declaring one static
// "Talk to a Bot" intent whose runtime parameter (`bot`, spoken as the Bot's
// name) donates `versutus://chat?bot=<bot>`. The Android half is a
// `res/xml/shortcuts.xml` resource with one "Open a Bot" shortcut whose intent
// opens a `versutus://chat` link and carries the Bot in the `bot` extras key,
// declared on the launcher activity under `android.app.shortcuts`.
//
// The `bot` parameter is runtime data — there is no per-Bot action to install —
// so one static declaration per platform is the whole shape.

const { withInfoPlist, withAndroidManifest, withDangerousMod } =
  require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

/** The scheme `deepLinkTarget` answers on — kept in step with app.json. */
const SCHEME = 'versutus';

const SHORTCUT_TITLE = 'Talk to a Bot';
const SHORTCUTS_METADATA = 'android.app.shortcuts';

/**
 * The URL a donated shortcut carries, spelled with the exact parser alphabet:
 * a bare `chat` path and a `bot` query param, no variants — the same rule the
 * fold follows for a hand-built link.
 */
function chatDeepLink(botParam) {
  return `${SCHEME}://chat?bot=${botParam}`;
}

function withAppShortcuts(config) {
  config = withInfoPlist(config, (config) => {
    const existing = config.modResults.AppShortcuts ?? [];
    const alreadyDonated = existing.some((entry) => entry.shortcutTitle === SHORTCUT_TITLE);
    if (!alreadyDonated) {
      config.modResults.AppShortcuts = [
        ...existing,
        {
          _comment:
            'One static App Shortcut whose `bot` runtime parameter donates the versutus://chat?bot=<bot> deep link; no in-app code runs it.',
          AppShortcut: [
            {
              shortcutTitle: SHORTCUT_TITLE,
              intent: {
                identifier: 'versutus-chat-deep-link',
                parameters: [
                  {
                    // Siri asks "which Bot?" and the answer rides straight
                    // into the `bot` query param via the link below — no
                    // runtime code sees it first.
                    name: 'bot',
                    displayName: 'Bot',
                    description: 'The Bot to talk to',
                    isVariadic: false,
                    supportsBackgroundExecution: false,
                    output: false,
                    optional: false,
                  },
                ],
                phrases: ['Talk to a Bot', 'Talk to a Bot with <bot>'],
              },
            },
          ],
        },
      ];
    }
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      const xmlDirectory = path.join(projectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDirectory, { recursive: true });
      const shortcutsPath = path.join(xmlDirectory, 'shortcuts.xml');
      // Idempotent: a re-run of prebuild rewrites nothing it already wrote.
      const body = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
    android:shortcutId="talk-to-a-bot"
    android:enabled="true"
    android:shortcutShortLabel="@string/shortcut_talk_to_a_bot_short"
    android:shortcutLongLabel="@string/shortcut_talk_to_a_bot_long">
    <intent
      android:action="android.intent.action.VIEW"
      android:data="${chatDeepLink('{bot}')}" />
    <extra android:name="bot" />
  </shortcut>
</shortcuts>
`;
      if (!fs.existsSync(shortcutsPath)) {
        fs.writeFileSync(shortcutsPath, body);
      }
      return config;
    },
  ]);

  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.$) manifest.$ = {};
    manifest.$['xmlns:android'] =
      manifest.$['xmlns:android'] ?? 'http://schemas.android.com/apk/res/android';
    const application = manifest.application?.[0];
    if (!application) return config;
    const activity = application.activity?.find(
      (entry) => entry.$?.['android:name'] === '.MainActivity',
    );
    if (!activity) return config;
    const alreadyDeclared = (activity['meta-data'] ?? []).some(
      (entry) => entry.$?.['android:name'] === SHORTCUTS_METADATA,
    );
    if (!alreadyDeclared) {
      activity['meta-data'] = [
        ...(activity['meta-data'] ?? []),
        {
          $: {
            'android:name': SHORTCUTS_METADATA,
            'android:resource': '@xml/shortcuts',
          },
        },
      ];
    }
    return config;
  });

  return config;
}

module.exports = withAppShortcuts;
