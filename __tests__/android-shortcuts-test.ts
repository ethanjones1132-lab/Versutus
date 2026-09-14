// The Android half of the shortcuts donation, pinned against what a prebuild
// would actually ship rather than what app.json declares — the same principle
// widget-android-plugin-test.ts states: the repo's config pins cannot see what
// a plugin does with the config. This suite drives the repo's own
// `plugins/with-app-shortcuts.js` through the real mod pipeline over a
// stub-shaped android/ project (the manifest fixture the widget suite uses)
// and asserts on the artifacts the build would compile.
//
// The one load-bearing spelling: the shortcut's `bot` extra key and its deep
// link must match the parser alphabet `deepLinkTarget` answers on — a bare
// `chat` path and a `bot` query param (src/lib/gateway/deep-link.ts:75-78).
// A renamed key would not fail any build; it would simply donate a link the
// router answers with nothing.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeRequire = (
  jest.requireActual('module') as typeof import('module')
).createRequire([__dirname, '..', 'package.json'].join(SEP));

function nodeFs(): typeof import('fs') {
  return jest.requireActual('fs');
}

function nodePath(): typeof import('path') {
  return jest.requireActual('path');
}

function nodeOs(): typeof import('os') {
  return jest.requireActual('os');
}

type AnyConfig = Record<string, unknown>;

// The shortcut entry must be wired in app.json or no prebuild runs the plugin
// at all — the same refusal-to-lie move widget-android-plugin-test.ts makes.
function repoConfig(): AnyConfig {
  const appJson = JSON.parse(
    nodeFs().readFileSync([__dirname, '..', 'app.json'].join(SEP), 'utf8'),
  ) as { expo: { scheme: string; plugins: unknown[] } };
  const wired = appJson.expo.plugins.includes('./plugins/with-app-shortcuts.js');
  if (!wired) {
    throw new Error(
      'the with-app-shortcuts entry is gone from app.json; the plugin never runs',
    );
  }
  return {
    name: 'Versutus',
    scheme: appJson.expo.scheme,
    _internal: { projectRoot: nodeFs().mkdtempSync('unused-') },
  };
}

async function generate(): Promise<{
  shortcutsXml: string;
  manifestXml: string;
}> {
  const { compileModsAsync, withDefaultBaseMods } = nodeRequire(
    '@expo/config-plugins',
  );
  const withAppShortcuts = nodeRequire(
    [__dirname, '..', 'plugins', 'with-app-shortcuts.js'].join(SEP),
  );

  const projectRoot = nodeFs().mkdtempSync(
    nodePath().join(nodeOs().tmpdir(), 'versutus-shortcuts-'),
  );
  const main = nodePath().join(projectRoot, 'android', 'app', 'src', 'main');
  nodeFs().mkdirSync(main, { recursive: true });
  nodeFs().writeFileSync(
    nodePath().join(main, 'AndroidManifest.xml'),
    nodeFs().readFileSync(
      [__dirname, 'fixtures', 'android-stub-manifest.xml'].join(SEP),
      'utf8',
    ),
  );

  const iosMain = nodePath().join(projectRoot, 'ios', 'stub');
  nodeFs().mkdirSync(iosMain, { recursive: true });
  nodeFs().writeFileSync(
    nodePath().join(iosMain, 'Info.plist'),
    // A minimal plist so the withDefaultBaseMods ios mods do not refuse to
    // locate one; this suite asserts the Android artifacts only.
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>',
  );

  try {
    const config = withAppShortcuts(withDefaultBaseMods(repoConfig()));
    await compileModsAsync(config, {
      projectRoot,
      assertMissingModProviders: false,
    });

    const shortcutsXml = nodeFs().readFileSync(
      nodePath().join(main, 'res', 'xml', 'shortcuts.xml'),
      'utf8',
    );
    const manifestXml = nodeFs().readFileSync(
      nodePath().join(main, 'AndroidManifest.xml'),
      'utf8',
    );
    return { shortcutsXml, manifestXml };
  } finally {
    nodeFs().rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe('the with-app-shortcuts plugin builds the Android shortcut donation', () => {
  let generated: Awaited<ReturnType<typeof generate>>;

  beforeAll(async () => {
    generated = await generate();
  });

  test('shortcuts.xml is emitted with one VIEW shortcut carrying the exact deep-link spelling', () => {
    const xml = generated.shortcutsXml;
    expect(xml).toContain('<shortcut');
    expect(xml).toContain('android:shortcutId="talk-to-a-bot"');
    // The link must be the one `deepLinkTarget` answers on — a bare `chat`
    // path and a `bot` query param — at runtime-parameter spelling ({bot} is
    // what Android substitutes when the user answers the shortcut's prompt).
    expect(xml).toContain('android:action="android.intent.action.VIEW"');
    expect(xml).toContain('android:data="versutus://chat?bot={bot}"');
    expect(xml).toContain('<extra android:name="bot" />');
  });

  test('the shortcut labels point at string resources the plugin writes into strings.xml', () => {
    // A `@string/…` reference with no resource fails the Android resource
    // compile at build time, so the labels must land with the XML that names
    // them — pinned by reading both artifacts back from the same prebuild.
    const xml = generated.shortcutsXml;
    expect(xml).toContain('android:shortcutShortLabel="@string/shortcut_talk_to_a_bot_short"');
    expect(xml).toContain('android:shortcutLongLabel="@string/shortcut_talk_to_a_bot_long"');
  });

  test('the launcher activity declares the shortcuts meta-data pointing at the resource', () => {
    const manifest = generated.manifestXml;
    expect(manifest).toContain(
      '<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts"/>',
    );
  });
});
