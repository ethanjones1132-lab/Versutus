import { gatewayRootUrl, manifestUrlForGateway } from '@/lib/gateway/gateway-origin';

describe('gatewayRootUrl', () => {
  test('strips a provider child /p/{id} suffix so root-only endpoints resolve', () => {
    expect(gatewayRootUrl('http://gate.test:8760/p/nvidia')).toBe('http://gate.test:8760');
  });

  test('leaves a parent origin unchanged', () => {
    expect(gatewayRootUrl('http://gate.test:8760')).toBe('http://gate.test:8760');
  });

  test('trims a trailing slash on the parent', () => {
    expect(gatewayRootUrl('http://gate.test:8760/')).toBe('http://gate.test:8760');
  });
});

describe('manifestUrlForGateway', () => {
  test('uses the parent URL when the profile is a child', () => {
    expect(
      manifestUrlForGateway(
        { url: 'http://gate.test:8760/p/nvidia', parentId: 'parent' },
        'http://gate.test:8760',
      ),
    ).toBe('http://gate.test:8760');
  });

  test('falls back to stripping /p/{id} when the parent URL is unknown', () => {
    expect(manifestUrlForGateway({ url: 'http://gate.test:8760/p/nvidia', parentId: 'parent' })).toBe(
      'http://gate.test:8760',
    );
  });

  test('uses the profile URL for a parent gateway', () => {
    expect(manifestUrlForGateway({ url: 'http://gate.test:8760' })).toBe('http://gate.test:8760');
  });
});
