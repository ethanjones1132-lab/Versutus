// ─── Settings → Notifications wiring (Solution A5/A6) ──────────────────────
// The Gate setup screen grows a Notifications tab rendering the relay
// preferences section: enable toggle, rich bodies, quiet hours, Bot filter,
// widget updates and the Gate's test round trip. Pinned off the source so a
// refactor that drops the tab or a control fails here, not on the phone.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function existsSource(...parts: string[]): boolean {
  return nodeFs.existsSync([__dirname, '..', ...parts].join(SEP));
}

describe('settings notifications wiring', () => {
  test('the setup screen has a Notifications tab rendering the section', () => {
    const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
    expect(setup).toContain('notifications');
    expect(setup).toContain('NotificationsSection');
  });

  test('the section and its hook exist and speak the notifications RPCs', () => {
    expect(existsSource('src', 'components', 'gateway', 'notifications-section.tsx')).toBe(true);
    expect(existsSource('src', 'hooks', 'use-notification-preferences.ts')).toBe(true);
    const hook = readSource('src', 'hooks', 'use-notification-preferences.ts');
    expect(hook).toContain('notifications.preferences.get');
    expect(hook).toContain('notifications.preferences.set');
    expect(hook).toContain('notifications.test');
    expect(hook).toContain('requestPermissionsAsync');
    expect(hook).toContain('syncPushRegistration');
  });

  test('approvals pierce quiet hours only when the device opted in', () => {
    const section = readSource('src', 'components', 'gateway', 'notifications-section.tsx');
    expect(section).toContain('quietHoursAllowApprovals');
    expect(section).toContain('Let approval notices through during quiet hours');
    const hook = readSource('src', 'hooks', 'use-notification-preferences.ts');
    expect(hook).toContain('quietHoursAllowApprovals: false');
  });

  test('the Android app points at the Firebase services file', () => {
    const raw = readSource('app.json');
    const config = JSON.parse(raw) as {
      expo?: { android?: { googleServicesFile?: string; package?: string } };
    };
    expect(config.expo?.android?.package).toBe('com.versutus.app');
    expect(config.expo?.android?.googleServicesFile).toBe('./google-services.json');
  });
});
