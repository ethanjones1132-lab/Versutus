import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import { METHOD_GUIDANCE, METHOD_TO_ROUTE, resolveRoute } from '@/lib/gateway/rpc-routes';

describe('Hermes route map', () => {
  test('interpolates path params and builds GET query', () => {
    expect(resolveRoute('session.get', { sessionId: 'session/one', detail: 'full' })).toEqual({
      route: { method: 'GET', path: '/api/sessions/{sessionId}' },
      path: '/api/sessions/session%2Fone?detail=full',
      body: {},
    });
  });

  test('covers every registry RPC method with a route or explanation', () => {
    const methods = GATEWAY_COMMANDS
      .filter((command) => command.transport === 'rpc' && command.method)
      .map((command) => command.method!);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(METHOD_TO_ROUTE[method] || METHOD_GUIDANCE[method]).toBeTruthy();
    }
  });

  test('maps run creation to Hermes', () => {
    expect(METHOD_TO_ROUTE['runs.create']).toEqual({ method: 'POST', path: '/v1/runs' });
  });
});
