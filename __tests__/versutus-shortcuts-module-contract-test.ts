declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

describe('the per-Bot shortcut module', () => {
  test('registers an Expo module named VersutusShortcuts on both platforms', () => {
    const config = JSON.parse(readSource('modules', 'versutus-shortcuts', 'expo-module.config.json'));
    expect(config.platforms).toEqual(expect.arrayContaining(['android', 'apple']));
    expect(config.android.modules).toEqual(['com.versutus.shortcuts.VersutusShortcutsModule']);
    expect(config.apple.modules).toEqual(['VersutusShortcutsModule']);
    expect(readSource('modules', 'versutus-shortcuts', 'src', 'VersutusShortcutsModule.ts')).toContain(
      "requireNativeModule<VersutusShortcutsNativeModule>('VersutusShortcuts')",
    );
  });

  test('publishes shortcuts through the shared deep-link vocabulary', () => {
    const ts = readSource('modules', 'versutus-shortcuts', 'src', 'VersutusShortcutsModule.ts');
    expect(ts).toContain('setShortcuts(');
    const kotlin = readSource(
      'modules',
      'versutus-shortcuts',
      'android',
      'src',
      'main',
      'java',
      'com',
      'versutus',
      'shortcuts',
      'VersutusShortcutsModule.kt',
    );
    expect(kotlin).toContain('Name("VersutusShortcuts")');
    expect(kotlin).toContain('ShortcutManager');
    expect(kotlin).toContain('setDynamicShortcuts');
    expect(kotlin).toContain('Uri.parse(url)');
    expect(kotlin).toContain('ACTION_VIEW');
  });

  test('the JS seam swallows a missing native module', () => {
    const seam = readSource('src', 'lib', 'gateway', 'shortcut-donation-native.ts');
    expect(seam).toContain('loadShortcutModule');
    expect(seam).toContain('catch');
  });

  test('iOS exposes recent Bots through App Intents and opens the existing chat link', () => {
    const source = readSource('modules', 'versutus-shortcuts', 'ios', 'VersutusBotAppIntents.swift');
    expect(source).toContain('AppEntity');
    expect(source).toContain('EntityQuery');
    expect(source).toContain('AppShortcutsProvider');
    expect(source).toContain('AppIntentsPackage');
    expect(source).toContain('TalkToBotIntent');
    expect(source).toContain('versutus://chat?bot=');
    expect(source).toContain('updateAppShortcutParameters');
  });

  test('the app target links the Expo module App Intents package idempotently', () => {
    const appJson = JSON.parse(readSource('app.json')) as { expo: { plugins: unknown[] } };
    expect(appJson.expo.plugins).toContain('./plugins/with-bot-app-intents.js');
    const plugin = readSource('plugins', 'with-bot-app-intents.js');
    expect(plugin).toContain('withXcodeProject');
    expect(plugin).toContain('addSourceFile');
    expect(plugin).toContain('VersutusShortcutsAppIntentsPackage');
  });
});
