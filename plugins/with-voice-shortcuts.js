const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// One static Android launcher shortcut: "Start a voice call". It rides the
// shipped deep-link vocabulary (`versutus://call`), so the shortcut and the
// router can never disagree. Per-Bot dynamic shortcuts are a later runtime
// `ShortcutManager` call; this is the static contract.

const SHORTCUT_ID = 'voice-call';
const SHORTCUT_SHORT_LABEL = 'Voice call';
const SHORTCUT_LONG_LABEL = 'Start a Versutus voice call';
const SHORTCUT_URL = 'versutus://call';

function buildShortcutsXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
    '  <shortcut',
    `    android:shortcutId="${SHORTCUT_ID}"`,
    '    android:enabled="true"',
    '    android:icon="@mipmap/ic_launcher"',
    `    android:shortcutShortLabel="${SHORTCUT_SHORT_LABEL}"`,
    `    android:shortcutLongLabel="${SHORTCUT_LONG_LABEL}">`,
    '    <intent',
    '      android:action="android.intent.action.VIEW"',
    `      android:data="${SHORTCUT_URL}"`,
    '      android:targetPackage="com.versutus.app"',
    '      android:targetClass="com.versutus.app.MainActivity" />',
    '    <categories android:name="android.shortcut.conversation" />',
    '  </shortcut>',
    '</shortcuts>',
    '',
  ].join('\n');
}

function withVoiceShortcuts(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    const activity = application?.activity?.find(
      (entry) => entry.$?.['android:name'] === '.MainActivity',
    );
    if (activity) {
      activity['meta-data'] = activity['meta-data'] ?? [];
      if (!activity['meta-data'].some((entry) => entry.$?.['android:name'] === 'android.app.shortcuts')) {
        activity['meta-data'].push({
          $: {
            'android:name': 'android.app.shortcuts',
            'android:resource': '@xml/shortcuts',
          },
        });
      }
    }
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const dir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'shortcuts.xml'), buildShortcutsXml());
      return config;
    },
  ]);

  return config;
}

module.exports = withVoiceShortcuts;
module.exports.buildShortcutsXml = buildShortcutsXml;
