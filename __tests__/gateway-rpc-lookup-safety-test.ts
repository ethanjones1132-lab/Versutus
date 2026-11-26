import { resolveRoute } from '@/lib/gateway/rpc-routes';
import { buildRpcMethodSlashMap, rpcMethodSlash } from '@/lib/gateway/rpc-methods';

/**
 * Plain-object method lookups answered Object.prototype members, so a method
 * named `constructor` or `toString` came back as a built-in function instead
 * of being reported unsupported.
 */
describe('RPC method lookups are own-property reads', () => {
  test('resolveRoute treats an Object-member method name as unsupported', () => {
    for (const method of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(resolveRoute(method, {})).toBeNull();
    }
  });

  test('the slash reader keeps an Object-member method name unsupported', () => {
    const map = buildRpcMethodSlashMap([{ method: 'cron.list', slash: '/cron list' }]);
    expect(rpcMethodSlash('constructor', map)).toBeUndefined();
    expect(rpcMethodSlash('toString', map)).toBeUndefined();
    expect(rpcMethodSlash('hasOwnProperty', map)).toBeUndefined();
  });

  test('a registry that really does register such a name keeps its own entry', () => {
    // The old write-side check saw Object.prototype's `constructor` and
    // skipped the real entry, so the map silently lost the first slash.
    const map = buildRpcMethodSlashMap([
      { method: 'constructor', slash: '/constructor' },
      { method: 'constructor', slash: '/later wins' },
    ]);
    expect(rpcMethodSlash('constructor', map)).toBe('/constructor');
  });

  test('a real method still resolves to its own route and slash', () => {
    expect(resolveRoute('jobs.remove', { jobId: 'job-1' })).toEqual({
      route: { method: 'DELETE', path: '/api/jobs/{jobId}' },
      path: '/api/jobs/job-1',
      body: {},
    });
    const map = buildRpcMethodSlashMap([{ method: 'cron.list', slash: '/cron list' }]);
    expect(rpcMethodSlash('cron.list', map)).toBe('/cron list');
  });
});

/**
 * A required {param} with no value used to stay in the path, so callers sent
 * `DELETE /api/jobs/{jobId}` to the host as if it were a real id.
 */
describe('route placeholders must have a value before a request is built', () => {
  test('a missing placeholder fails locally instead of returning template text', () => {
    expect(() => resolveRoute('jobs.remove', {})).toThrow(/\{jobId\}/);
    expect(() => resolveRoute('jobs.run', { jobId: undefined })).toThrow(/\{jobId\}/);
    expect(() => resolveRoute('session.get', {})).toThrow(/\{sessionId\}/);
  });

  test('the error names the method and the route it cannot build', () => {
    expect(() => resolveRoute('jobs.remove', {})).toThrow(
      /jobs\.remove is missing a value for \{jobId\}.*DELETE \/api\/jobs\/\{jobId\}/,
    );
  });

  test('a valid call sends exactly the request it did before the guard', () => {
    expect(resolveRoute('session.get', { sessionId: 'session/one', detail: 'full' })).toEqual({
      route: { method: 'GET', path: '/api/sessions/{sessionId}' },
      path: '/api/sessions/session%2Fone?detail=full',
      body: {},
    });
  });
});
