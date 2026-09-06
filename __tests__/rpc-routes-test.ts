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

  test('session.fork has no route: Hermes exposes no remote fork endpoint', () => {
    expect(METHOD_TO_ROUTE['session.fork']).toBeUndefined();
    expect(resolveRoute('session.fork', { sessionId: 's-7' })).toBeNull();
  });

  test('session.fork fails honestly with a new-session next step', () => {
    expect(METHOD_GUIDANCE['session.fork']).toMatch(/No remote fork endpoint/);
    expect(METHOD_GUIDANCE['session.fork']).toMatch(/POST \/api\/sessions/);
  });

  test('responses.get/delete have no route: the Gate serves no /v1/responses surface', () => {
    expect(METHOD_TO_ROUTE['responses.get']).toBeUndefined();
    expect(METHOD_TO_ROUTE['responses.delete']).toBeUndefined();
    expect(resolveRoute('responses.get', { responseId: 'resp_1' })).toBeNull();
    expect(resolveRoute('responses.delete', { responseId: 'resp_1' })).toBeNull();
  });

  test('responses.get/delete fail honestly with a run-read next step', () => {
    for (const method of ['responses.get', 'responses.delete']) {
      expect(METHOD_GUIDANCE[method]).toMatch(/\/v1\/responses.*404|no \/v1\/responses/);
      expect(METHOD_GUIDANCE[method]).toMatch(/\/v1\/runs\//);
    }
  });
});
