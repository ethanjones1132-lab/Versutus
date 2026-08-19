import { GatewayHttpError, isAuthRejection, isGatewayTokenRequiredMessage, isUserAbort } from '@/lib/gateway/errors';

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

describe('isUserAbort', () => {
  it('is true when our own abort signal fired', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isUserAbort(new Error('stream closed'), controller.signal)).toBe(true);
  });

  it('is true for an AbortError regardless of signal', () => {
    expect(isUserAbort(abortError())).toBe(true);
  });

  it('is false for a server error that merely mentions abort', () => {
    // The whole point: "aborted" in a server message is a real failure the
    // user must see, not a cancellation that silently drops the reply.
    const controller = new AbortController();
    expect(isUserAbort(new Error('connection aborted by peer'), controller.signal)).toBe(false);
    expect(isUserAbort(new Error('Aborted by upstream provider'))).toBe(false);
  });

  it('is false for unrelated failures', () => {
    expect(isUserAbort(new Error('502 Bad Gateway'))).toBe(false);
    expect(isUserAbort('something went wrong')).toBe(false);
    expect(isUserAbort(undefined)).toBe(false);
  });

  it('recognises the DOM abort error code', () => {
    expect(isUserAbort({ code: 'ABORT_ERR' })).toBe(true);
  });
});

describe('A2 regression lock — typed HTTP error classification', () => {
  it('isAuthRejection matches 401/403 GatewayHttpError exactly', () => {
    expect(isAuthRejection(new GatewayHttpError('nope', 401))).toBe(true);
    expect(isAuthRejection(new GatewayHttpError('nope', 403))).toBe(true);
    expect(isAuthRejection(new GatewayHttpError('nope', 500))).toBe(false);
  });

  it('isAuthRejection falls back to message text for transports that lose status', () => {
    expect(isAuthRejection(new Error('invalid api key'))).toBe(true);
    expect(isAuthRejection(new Error('Unauthorized request'))).toBe(true);
    expect(isAuthRejection(new Error('something else'))).toBe(false);
  });

  it('isGatewayTokenRequiredMessage matches setup-token markers', () => {
    expect(isGatewayTokenRequiredMessage('setup token required')).toBe(true);
    expect(isGatewayTokenRequiredMessage('auth token missing')).toBe(true);
    expect(isGatewayTokenRequiredMessage('token required')).toBe(true);
    expect(isGatewayTokenRequiredMessage('unknown failure')).toBe(false);
    expect(isGatewayTokenRequiredMessage(null)).toBe(false);
  });
});
