// The spec's own verify step, made a pin: the Android half of the widget was
// diagnosed on 2026-09-11 against a real prebuild (a generated manifest held
// zero `appwidget` receivers and no res/xml widget info — FUTURE-ITEMS.md
// "Android home-screen widget"), fixed by switching the entry on, and then the
// verification was never run again. Nothing in this tree re-proves that a
// package upgrade changing how expo-widgets generates its Android output does
// not silently undo placement — exactly what the repo's app.json pins cannot
// see, because they read the config, not what the plugin does with it. So this
// suite drives the plugin's own builder modules — the code a prebuild would
// execute — and compiles the resulting mods over a scaffold-shaped stub
// project, asserting on the artifacts the Android build would actually ship.
//
// These are the installed plugin's own compiled modules, so nothing here
// re-implements generation; it holds whatever the installed expo-widgets does.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeRequire = (
  jest.requireActual('module') as typeof import('module')
).createRequire([__dirname, '..', 'node_modules', 'expo-widgets', 'app.plugin.js'].join(SEP));

type AndroidSizing = {
  minWidth?: number;
  minHeight?: number;
  targetCellWidth?: number;
  targetCellHeight?: number;
  resizeMode?: string;
};

type Widget = {
  name: string;
  displayName?: string;
  description?: string;
  supportedFamilies?: string[];
  android?: AndroidSizing;
};

function nodeFs(): typeof import('fs') {
  return jest.requireActual('fs');
}

function nodePath(): typeof import('path') {
  return jest.requireActual('path');
}

function nodeOs(): typeof import('os') {
  return jest.requireActual('os');
}

function compileMods(): (
  config: unknown,
  props: { projectRoot: string; assertMissingModProviders?: boolean },
) => Promise<unknown> {
  return nodeRequire('@expo/config-plugins').compileModsAsync;
}

// The stub config carries the entry props this repo actually ships — read from
// app.json at run time so the two suites cannot drift. If enableAndroid is
// ever turned back off, this suite goes blind, so the read refuses to lie.
function repoWidget(): Widget {
  const appJson = JSON.parse(
    nodeFs().readFileSync([__dirname, '..', 'app.json'].join(SEP), 'utf8'),
  ) as { expo: { plugins: unknown[] } };
  const entry = appJson.expo.plugins.find(
    (plugin): plugin is [string, { enableAndroid?: boolean; widgets: Widget[] }] =>
      Array.isArray(plugin) && plugin[0] === 'expo-widgets',
  );
  if (!entry) {
    throw new Error('the expo-widgets entry is gone from app.json');
  }
  if (!entry[1].enableAndroid) {
    throw new Error(
      'enableAndroid must stay true, or no Android widget is generated at all',
    );
  }
  if (entry[1].widgets.length !== 1) {
    throw new Error(
      'expected exactly one widget entry, as the factory and the pins assume',
    );
  }
  return entry[1].widgets[0];
}

// A scaffold-shaped stub android/ project: a manifest the way a prebuild
// writes it, inside a temp directory so nothing in the repo is touched.
// The generated artifacts are read back from the same files a device build
// would ship, not from the plugin's return value.
async function generate(widgets: Widget[]): Promise<{
  projectRoot: string;
  manifestXml: string;
  widgetInfoXml: string;
  providerKotlin: string;
}> {
  const withWidgets = nodeRequire(
    'expo-widgets/plugin/build/android/withAndroidWidgets.js',
  ).default as (config: unknown, props: { widgets: Widget[] }) => unknown;

  const projectRoot = nodeFs().mkdtempSync(
    nodePath().join(nodeOs().tmpdir(), 'versutus-widget-'),
  );
  const androidRoot = nodePath().join(projectRoot, 'android');
  const main = nodePath().join(androidRoot, 'app/src/main');
  nodeFs().mkdirSync(main, { recursive: true });
  nodeFs().writeFileSync(
    nodePath().join(main, 'AndroidManifest.xml'),
    // The way a prebuild scaffold writes it: one application, no widgetceiver yet.
    nodeFs().readFileSync(
      [__dirname, 'fixtures', 'android-stub-manifest.xml'].join(SEP),
      'utf8',
    ),
  );

  try {
    const config = withWidgets(
      // The repo's Android package — the plugin reads it from the config
      // itself (withAndroidWidgetFiles.js:45).
      { name: 'versutus', android: { package: 'com.versutus.app' } },
      { widgets },
    );
    await compileMods()(config, {
      projectRoot: projectRoot,
      assertMissingModProviders: false,
    });

    const manifestXml = nodeFs().readFileSync(
      nodePath().join(main, 'AndroidManifest.xml'),
      'utf8',
    );
    const widgetInfoXml = nodeFs().readFileSync(
      nodePath().join(main, 'res/xml', 'versutus_status_info.xml'),
      'utf8',
    );
    const providerKotlin = nodeFs().readFileSync(
      nodePath().join(
        main,
        'java',
        ...'com.versutus.app'.split('.'),
        'VersutusStatusProvider.kt',
      ),
      'utf8',
    );
    return { projectRoot, manifestXml, widgetInfoXml, providerKotlin };
  } finally {
    nodeFs().rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe('the installed expo-widgets plugin builds the Android widget this repo promises', () => {
  const widget = repoWidget();
  let generated: Awaited<ReturnType<typeof generate>>;

  beforeAll(async () => {
    generated = await generate([widget]);
  });

  test('the widget-info XML is emitted with the sizing app.json spells out, not plugin defaults', () => {
    // app.json spells each dimension out precisely so a silent change to the
    // plugin's own defaults is caught (see the app.json pins in
    // widget-target-test.ts); this holds the generated artifact to the same
    // numbers. updatePeriodMillis="0" is the plugin's own choice — the widget
    // updates on snapshot writes, not on a timer — and widgetCategory
    // home_screen is what lists it in the picker at all.
    const info = generated.widgetInfoXml;
    expect(info).toContain('android:targetCellWidth="4"');
    expect(info).toContain('android:targetCellHeight="2"');
    expect(info).toContain('android:updatePeriodMillis="0"');
    expect(info).toContain('android:widgetCategory="home_screen"');
    expect(info).toContain('android:minWidth="180dp"');
    expect(info).toContain('android:minHeight="110dp"');
    expect(info).toContain('android:resizeMode="horizontal"');
  });

  test("the provider class is named for the one widget, in the repo's package", () => {
    const kt = generated.providerKotlin;
    expect(kt).toContain('package com.versutus.app');
    expect(kt).toContain('class VersutusStatusProvider');
  });

  test("the manifest gains a receiver carrying the plugin's widget-name meta-data", () => {
    const manifest = generated.manifestXml;
    expect(manifest).toContain('<receiver android:name=".VersutusStatusProvider"');
    expect(manifest).toContain(
      '<meta-data android:name="android.appwidget.provider" android:resource="@xml/versutus_status_info"/>',
    );
    expect(manifest).toContain(
      '<meta-data android:name="expo.modules.widgets.NAME" android:value="VersutusStatus"/>',
    );
    // The receiver must react to both the system's update sweep and the
    // plugin's own interaction action — placement dies without the first,
    // taps without the second.
    expect(manifest).toContain('android:name="android.appwidget.action.APPWIDGET_UPDATE"');
    expect(manifest).toContain('android:name="expo.modules.widgets.ACTION_WIDGET_INTERACTION"');
  });
});

export {};
