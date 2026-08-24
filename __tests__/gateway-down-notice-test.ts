import {
  GATEWAY_DOWN_NOTICE_KIND,
  GATEWAY_DOWN_TITLE,
  downNoticeGatewayKey,
  gatewayDownNoticeData,
  isDownNoticeFor,
  type PresentedNoticeLike,
} from '@/lib/notifications/gateway-down-notice';

function notice(
  title: string | null | undefined,
  data?: Record<string, unknown> | null,
): PresentedNoticeLike {
  return {
    identifier: 'n',
    content: { title: title ?? undefined, data: data ?? undefined },
  };
}

describe('gateway-down notice matching (pure helpers)', () => {
  test('gatewayDownNoticeData names the kind and the gateway key', () => {
    expect(gatewayDownNoticeData('gw-a')).toEqual({
      kind: GATEWAY_DOWN_NOTICE_KIND,
      gatewayKey: 'gw-a',
    });
  });

  test('downNoticeGatewayKey reads the key back out of a scoped payload', () => {
    expect(downNoticeGatewayKey(notice('Gateway unreachable', { kind: 'gateway-down', gatewayKey: 'gw-a' }).content)).toBe('gw-a');
  });

  test('isDownNoticeFor matches the notice for exactly its gateway', () => {
    const posted = notice('Gateway unreachable', gatewayDownNoticeData('gw-a'));
    expect(isDownNoticeFor(posted, 'gw-a')).toBe(true);
  });

  test("a different gateway's payload never matches — the alternate-gateway regression pin", () => {
    // gw-a's notice must survive while gw-b answers: only the gateway that
    // actually answered retires its own notice.
    const gwANotice = notice('Gateway unreachable', gatewayDownNoticeData('gw-a'));
    expect(isDownNoticeFor(gwANotice, 'gw-b')).toBe(false);
  });

  test('a payload of another kind never matches even under the down title', () => {
    // The payload is authoritative: a notice that explicitly says it is not
    // a gateway-down notice is never treated as one.
    const other = notice('Gateway unreachable', { kind: 'approval', gatewayKey: 'gw-a' });
    expect(isDownNoticeFor(other, 'gw-a')).toBe(false);
  });

  test('a malformed scoped payload matches no gateway', () => {
    // Kind present but no usable key: the notice claims to be scoped, so
    // title fallback would risk retiring another gateway's notice — it
    // matches nothing instead.
    const malformed = notice('Gateway unreachable', { kind: 'gateway-down', gatewayKey: 42 });
    expect(isDownNoticeFor(malformed, 'gw-a')).toBe(false);
    expect(downNoticeGatewayKey(malformed.content)).toBeNull();
  });

  test('a legacy title-only notice matches any gateway (pre-payload migration)', () => {
    // Notices posted before the payload existed cannot be attributed; any
    // gateway answering may retire them. Modern notices are unaffected
    // because their payload scopes them first.
    const legacy = notice('Gateway unreachable');
    expect(isDownNoticeFor(legacy, 'gw-a')).toBe(true);
    expect(isDownNoticeFor(legacy, 'gw-b')).toBe(true);
    expect(downNoticeGatewayKey(legacy.content)).toBeNull();
  });

  test('an unrelated notice never matches', () => {
    expect(isDownNoticeFor(notice('Approval required'), 'gw-a')).toBe(false);
    expect(isDownNoticeFor(notice('Approval required', { kind: 'approval', gatewayKey: 'gw-a' }), 'gw-a')).toBe(false);
  });
});