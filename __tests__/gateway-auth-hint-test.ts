import { gatewayAuthRejectionMessage } from '@/lib/gateway/client';

describe('the auth-rejection hint names something the operator can act on', () => {
  test('Windows keeps the %LOCALAPPDATA%\\hermes\\.env path', () => {
    expect(gatewayAuthRejectionMessage('win32')).toBe(
      'Gateway rejected the API key. Enter API_SERVER_KEY from %LOCALAPPDATA%\\hermes\\.env.',
    );
    // React Native Windows reports `windows`, not Node's `win32`.
    expect(gatewayAuthRejectionMessage('windows')).toContain('%LOCALAPPDATA%');
  });

  test.each(['android', 'ios'])('%s is pointed at the gateway host, not a Windows path', (platform) => {
    // The old line sent phone users (the app's main targets) to a Windows
    // environment-variable path their device does not have.
    const message = gatewayAuthRejectionMessage(platform);
    expect(message).not.toContain('LOCALAPPDATA');
    expect(message).not.toContain('\\hermes');
    expect(message).toContain('API_SERVER_KEY set on the gateway host');
  });
});
