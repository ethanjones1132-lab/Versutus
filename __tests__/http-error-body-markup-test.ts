import { messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';

describe('messageFromHttpErrorBody on a non-JSON error body', () => {
  test('keeps reading a JSON message exactly as before', () => {
    expect(messageFromHttpErrorBody(JSON.stringify({ error: { message: 'boom' } }), 502)).toBe('boom');
  });

  test('a JSON body the extractor does not understand is left to the old path', () => {
    // The JSON branch stays byte-identical: the markup rule must not fire on a
    // body that parsed, even when it carries no human sentence.
    const body = JSON.stringify({ error: { code: 'x' } });
    expect(messageFromHttpErrorBody(body, 502)).toBe(body);
  });

  test('an HTML page is not shown raw: the status and the page are named instead', () => {
    const body = '<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>';
    const message = messageFromHttpErrorBody(body, 502);

    // The whole reported class of leak: markup in the operator's caption.
    expect(message).not.toContain('<');
    expect(message).not.toContain('<!doctype');
    expect(message).not.toContain('Unexpected token');
    expect(message).toContain('502');
    expect(message).toMatch(/web page/i);
    expect(message).toMatch(/JSON/i);
  });

  test('leading whitespace and a partial fragment still count as markup', () => {
    const message = messageFromHttpErrorBody('\n  <html><head><title>Proxy</title></head></html>', 503);

    expect(message).not.toContain('<');
    expect(message).toContain('503');
    expect(message).toMatch(/web page/i);
  });

  test('the markup sentence is bounded rather than echoing the body', () => {
    const body = `<html><body>${'filler '.repeat(4000)}</body></html>`;
    const message = messageFromHttpErrorBody(body, 502);

    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain('filler');
  });

  test('a long non-markup body keeps today’s text, length unchanged', () => {
    // So this change touches markup only.
    const body = `upstream said no ${'in detail '.repeat(200)}`.trim();
    expect(messageFromHttpErrorBody(body, 500)).toBe(body);
  });

  test('a plain sentence is still passed through', () => {
    expect(messageFromHttpErrorBody('An internal server error has occurred', 500)).toBe(
      'An internal server error has occurred',
    );
  });

  test('an empty body still falls back to the bare status', () => {
    expect(messageFromHttpErrorBody('', 502)).toBe('HTTP 502');
  });
});
