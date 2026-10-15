declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

type PluginEntry = string | [string, Record<string, unknown>?];
type AppConfig = {
  expo: { plugins: PluginEntry[]; android: { permissions: string[]; blockedPermissions?: string[] } };
};

function readConfig(): AppConfig {
  return JSON.parse(nodeFs.readFileSync([__dirname, '..', 'app.json'].join(SEP), 'utf8')) as AppConfig;
}

/**
 * Voice dictation (expo-speech-recognition) and the hands-free call both record from
 * the microphone, so the built Android app must keep android.permission.RECORD_AUDIO.
 *
 * The trap this pins: a config plugin can REMOVE a permission from the final merged
 * manifest even though app.json and another module declare it. expo-image-picker does
 * exactly that when its `microphonePermission` option is `false`: it blocks
 * RECORD_AUDIO for the whole app (`tools:node="remove"`), and every test that only
 * reads app.json's shape stays green while voice is dead on the phone.
 */
describe('app.json keeps the microphone permission the voice features need', () => {
  test('RECORD_AUDIO is declared and not blocked', () => {
    const { android } = readConfig().expo;
    expect(android.permissions).toContain('android.permission.RECORD_AUDIO');
    expect(android.blockedPermissions ?? []).not.toContain('android.permission.RECORD_AUDIO');
  });

  test('no plugin turns its microphonePermission off, which would block RECORD_AUDIO app-wide', () => {
    const offenders = readConfig()
      .expo.plugins.filter((entry): entry is [string, Record<string, unknown>] => Array.isArray(entry))
      .filter(([, options]) => options && options.microphonePermission === false)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test('the image picker states why the app uses the microphone instead of opting out', () => {
    const picker = readConfig()
      .expo.plugins.filter((entry): entry is [string, Record<string, unknown>] => Array.isArray(entry))
      .find(([name]) => name === 'expo-image-picker');
    expect(picker).toBeDefined();
    expect(typeof picker?.[1]?.microphonePermission).toBe('string');
    expect(String(picker?.[1]?.microphonePermission)).toContain('microphone');
  });
});
