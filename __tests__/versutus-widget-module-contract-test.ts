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
