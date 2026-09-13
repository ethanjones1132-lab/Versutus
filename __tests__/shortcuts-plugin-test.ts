import { readFileSync } from 'fs';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

type StringItem = { $: { name: string }; _: string };
type StringsXml = { resources: { string?: StringItem[] } };

const plugin = jest.requireActual('../plugins/with-voice-shortcuts.js') as {
  buildShortcutsXml(): string;
  withShortcutLabelStrings(stringsXml: StringsXml): StringsXml;
};

describe('the static Android shortcut', () => {
  test('targets the one call link the router answers', () => {
    const xml = plugin.buildShortcutsXml();
    expect(xml).toContain('android:shortcutId="voice-call"');
    expect(xml).toContain('android:data="versutus://call"');
    expect(xml).toContain('android.intent.action.VIEW');
    // Nothing here invents a second route: the shortcut is a deep link.
    expect(xml).not.toContain('android:targetClass="com.versutus.app.CallActivity"');
  });

  test('labels are string resources, the only form aapt links for a shortcut', () => {
    const xml = plugin.buildShortcutsXml();
    expect(xml).toContain('android:shortcutShortLabel="@string/voice_call_shortcut_short_label"');
    expect(xml).toContain('android:shortcutLongLabel="@string/voice_call_shortcut_long_label"');
    // A literal label fails :app:processReleaseResources ("incompatible with
    // attribute shortcutShortLabel (attr) reference"), which no JS test sees.
    expect(xml).not.toMatch(/shortcut(Short|Long)Label="[^@]/);
  });

  test('the plugin writes both label strings, once, into strings.xml', () => {
    const next = plugin.withShortcutLabelStrings({ resources: {} });
    const labels = (next.resources.string ?? []).map((item) => [item.$.name, item._]);
    expect(labels).toEqual(
      expect.arrayContaining([
        ['voice_call_shortcut_short_label', 'Voice call'],
        ['voice_call_shortcut_long_label', 'Start a Versutus voice call'],
      ]),
    );
    // Prebuild re-runs mods over an existing project; a second pass must not duplicate.
    const again = plugin.withShortcutLabelStrings(next);
    const names = (again.resources.string ?? []).map((item) => item.$.name);
    expect(names.filter((name) => name === 'voice_call_shortcut_short_label')).toHaveLength(1);
    expect(names.filter((name) => name === 'voice_call_shortcut_long_label')).toHaveLength(1);
  });

  test('the plugin wires the manifest to the generated shortcuts resource', () => {
    const source = readSource('plugins', 'with-voice-shortcuts.js');
    expect(source).toContain('android.app.shortcuts');
    expect(source).toContain('@xml/shortcuts');
    expect(source).toContain('shortcuts.xml');
    expect(source).toContain('withAndroidManifest');
    expect(source).toContain('withDangerousMod');
    expect(source).toContain('withStringsXml');
  });

  test('app.json registers the plugin', () => {
    const appJson = JSON.parse(readSource('app.json')) as {
      expo: { plugins: unknown[] };
    };
    expect(appJson.expo.plugins).toContain('./plugins/with-voice-shortcuts.js');
  });
});
