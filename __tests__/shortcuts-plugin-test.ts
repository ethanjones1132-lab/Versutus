import { readFileSync } from 'fs';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const plugin = jest.requireActual('../plugins/with-voice-shortcuts.js') as {
  buildShortcutsXml(): string;
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

  test('the plugin wires the manifest to the generated shortcuts resource', () => {
    const source = readSource('plugins', 'with-voice-shortcuts.js');
    expect(source).toContain('android.app.shortcuts');
    expect(source).toContain('@xml/shortcuts');
    expect(source).toContain('shortcuts.xml');
    expect(source).toContain('withAndroidManifest');
    expect(source).toContain('withDangerousMod');
  });

  test('app.json registers the plugin', () => {
    const appJson = JSON.parse(readSource('app.json')) as {
      expo: { plugins: unknown[] };
    };
    expect(appJson.expo.plugins).toContain('./plugins/with-voice-shortcuts.js');
  });
});
