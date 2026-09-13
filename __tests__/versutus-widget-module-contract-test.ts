declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
};

function path(...parts: string[]): string {
  return [__dirname, '..', ...parts].join(SEP);
}

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync(path(...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('the Android widget module', () => {
  test('registers an Android-only Expo module named VersutusWidget', () => {
    const config = JSON.parse(readSource('modules', 'versutus-widget', 'expo-module.config.json'));
    expect(config.platforms).toEqual(['android']);
    expect(config.android.modules).toEqual(['com.versutus.widget.VersutusWidgetModule']);
    expect(readSource('modules', 'versutus-widget', 'src', 'VersutusWidgetModule.ts')).toContain(
      "requireNativeModule<VersutusWidgetNativeModule>('VersutusWidget')",
    );
  });

  test('declares a non-exported-by-default Glance receiver with its provider info', () => {
    const manifest = readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'AndroidManifest.xml');
    expect(manifest).toContain('android:name="com.versutus.widget.VersutusStatusReceiver"');
    expect(manifest).toContain('android.appwidget.action.APPWIDGET_UPDATE');
    expect(manifest).toContain('android:resource="@xml/versutus_status_widget_info"');
  });

  test('the provider info paints a preview and resizes both ways', () => {
    const info = readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'res', 'xml', 'versutus_status_widget_info.xml');
    expect(info).toContain('android:previewLayout="@layout/versutus_status_widget_preview"');
    expect(info).toContain('android:resizeMode="horizontal|vertical"');
    expect(info).toContain('android:targetCellWidth="4"');
  });

  test('uses the stable Glance release the plan pins', () => {
    const gradle = readSource('modules', 'versutus-widget', 'android', 'build.gradle');
    expect(gradle).toContain("androidx.glance:glance-appwidget:1.2.0'");
    expect(gradle).toContain("androidx.glance:glance-material3:1.2.0'");
    expect(gradle).toContain("apply plugin: 'org.jetbrains.kotlin.plugin.compose'");
  });
});

describe('the Android widget renders and updates honestly', () => {
  const kotlin = (file: string) =>
    readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'java', 'com', 'versutus', 'widget', file);

  test('the card paints a themed background with launcher corners and opens the app', () => {
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).toContain('.background(GlanceTheme.colors.widgetBackground)');
    expect(widget).toContain('.cornerRadius(android.R.dimen.system_app_widget_background_radius)');
    expect(widget).toContain('actionStartActivity(openAppIntent(context, "versutus://chat"))');
    expect(widget).toContain('SizeMode.Responsive(');
  });

  test('a payload is validated before it is stored, and every placed widget is redrawn', () => {
    const module = kotlin('VersutusWidgetModule.kt');
    expect(module).toContain('Name("VersutusWidget")');
    const parseAt = module.indexOf('WidgetPayload.parse(json)');
    const writeAt = module.indexOf('WidgetPayloadStore.write(context, json)');
    expect(parseAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(parseAt);
    expect(module).toContain('VersutusStatusWidget().updateAll(context)');
  });
});

describe('M1: looks native on any wallpaper', () => {
  const kotlin = (file: string) =>
    readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'java', 'com', 'versutus', 'widget', file);

  test('below Android 12 the card falls back to opaque brand colours', () => {
    const colors = kotlin('WidgetColors.kt');
    expect(colors).toContain('darkColorScheme(');
    expect(colors).toContain('Color(0xFF08080A)');
    expect(colors).toContain('lightColorScheme(');
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).toContain('Build.VERSION.SDK_INT >= 31');
    expect(widget).toContain('WidgetColors.colors');
  });

  test('the card reads as one sentence to TalkBack', () => {
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).toContain('contentDescription');
    expect(widget).toContain('"Versutus: ');
    expect(widget).toContain('.semantics');
  });
});

describe('M2: actions that respect the app safety rules', () => {
  const kotlin = (file: string) =>
    readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'java', 'com', 'versutus', 'widget', file);

  test('nothing in the widget runs a callback that could decide an approval', () => {
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).not.toContain('actionRunCallback');
    expect(widget).not.toContain('sendBroadcast');
  });

  test('an approval offers a Decide row that only opens the app', () => {
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).toContain('Decide in Versutus');
    expect(widget).toContain('actionStartActivity(openAppIntent(context, "versutus://chat"))');
  });
});

describe('M3: fresh while the app is closed', () => {
  const kotlin = (file: string) =>
    readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'java', 'com', 'versutus', 'widget', file);

  test('a periodic worker redraws every widget with no network constraint', () => {
    const worker = kotlin('WidgetRefreshWorker.kt');
    expect(worker).toContain('VersutusStatusWidget().updateAll(');
    expect(worker).toContain('NetworkType');
    expect(worker).not.toContain('NetworkType.CONNECTED');
  });

  test('the module enqueues the refresh with KEEP when a payload is stored', () => {
    const module = kotlin('VersutusWidgetModule.kt');
    expect(module).toContain('WidgetRefreshPolicy.enqueue(');
    const parseAt = module.indexOf('WidgetPayloadStore.write(context, json)');
    const enqueueAt = module.indexOf('WidgetRefreshPolicy.enqueue(');
    expect(parseAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeGreaterThan(parseAt);
  });
});
