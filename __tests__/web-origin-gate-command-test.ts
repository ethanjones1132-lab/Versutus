import {
  currentWebOrigin,
  exactWebOrigin,
  savedAddressUnreachableCopy,
  webGateStartCommand,
  webUnreachableCopy,
} from '@/lib/gateway/web-origin';

// VS-158: the web build is cross-origin to the Gate, so the command onboarding
// prints has to carry the page's exact origin. These tests pin the two halves
// that must never drift: the exact origin survives into the command, and a
// browser that cannot connect is not told to fix Tailscale.

describe('exactWebOrigin', () => {
  test.each([
    'http://localhost:8081',
    'http://192.168.1.20:8090',
    'https://demo.example.ts.net',
    'HTTPS://Demo.Example.TS.net:443',
  ])('%s is a usable browser origin', (origin) => {
    expect(exactWebOrigin(origin)).toBe(origin);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ["an opaque origin's \"null\"", 'null'],
    ['a file URL', 'file:///C:/versutus/index.html'],
    ['an origin with a path', 'http://192.168.1.20:8090/app'],
    ['an origin with a trailing slash', 'http://192.168.1.20:8090/'],
    ['an origin with whitespace inside', 'http://192.168.1.20 :8090'],
    ['a non-http scheme', 'capacitor://localhost'],
  ])('%s is not a usable browser origin', (_label, origin) => {
    expect(exactWebOrigin(origin)).toBeNull();
  });
});

describe('webGateStartCommand', () => {
  test('carries the exact origin, port and all', () => {
    expect(webGateStartCommand('http://192.168.1.20:8090')).toBe(
      'node gate/cli.mjs start --allow-origin http://192.168.1.20:8090',
    );
  });

  test('carries an https Tailscale Serve origin exactly', () => {
    expect(webGateStartCommand('https://demo.example.ts.net')).toBe(
      'node gate/cli.mjs start --allow-origin https://demo.example.ts.net',
    );
  });

  test('never widens the allow-list to a wildcard', () => {
    const command = webGateStartCommand('http://192.168.1.20:8090');
    expect(command).not.toContain('*');
    expect(command.match(/--allow-origin/g)).toHaveLength(1);
  });

  test.each([undefined, null, '', 'null', 'http://192.168.1.20:8090/app'])(
    'an unusable page origin (%p) stays a runnable command, not a dangling flag',
    (origin) => {
      expect(webGateStartCommand(origin)).toBe('node gate/cli.mjs start');
    },
  );
});

describe('currentWebOrigin', () => {
  const win = global.window as unknown as { location?: { origin?: unknown } };
  const hadLocation = Object.prototype.hasOwnProperty.call(win, 'location');
  const previousLocation = win.location;

  afterEach(() => {
    if (hadLocation) win.location = previousLocation;
    else delete (win as { location?: unknown }).location;
  });

  test('reads the running page origin', () => {
    win.location = { origin: 'http://192.168.1.20:8090' };
    expect(currentWebOrigin()).toBe('http://192.168.1.20:8090');
  });

  test('is undefined when the runtime has no location', () => {
    delete (win as { location?: unknown }).location;
    expect(currentWebOrigin()).toBeUndefined();
  });

  test('is undefined when location has no string origin', () => {
    win.location = { origin: 42 };
    expect(currentWebOrigin()).toBeUndefined();
  });
});

describe('unreachable copy', () => {
  test('the web failure names the exact origin to allow, never Tailscale', () => {
    const copy = webUnreachableCopy('http://192.168.1.20:8090');
    expect(copy).toContain('--allow-origin http://192.168.1.20:8090');
    expect(copy).not.toMatch(/tailscale/i);
    expect(copy).not.toMatch(/turn on/i);
  });

  test('the web failure still names --allow-origin when the origin is unusable', () => {
    const copy = webUnreachableCopy('null');
    expect(copy).toContain('--allow-origin');
    expect(copy).not.toContain('null');
    expect(copy).not.toMatch(/tailscale/i);
  });

  test('the web probe line names the exact origin and not Tailscale', () => {
    const copy = savedAddressUnreachableCopy({
      web: true,
      origin: 'http://192.168.1.20:8090',
    });
    expect(copy).toContain('allows http://192.168.1.20:8090');
    expect(copy).not.toMatch(/tailscale/i);
  });

  test('the web probe line names the page origin when it is unusable', () => {
    const copy = savedAddressUnreachableCopy({ web: true, origin: undefined });
    expect(copy).toContain("allows this page’s origin");
    expect(copy).not.toMatch(/tailscale/i);
  });

  test('the native probe line is unchanged and may still name Tailscale', () => {
    expect(savedAddressUnreachableCopy({ web: false })).toBe(
      'Saved your address, but could not reach the gateway. Make sure it is running and exposed over Tailscale or local network.',
    );
  });
});
