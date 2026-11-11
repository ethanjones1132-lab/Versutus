import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ActivityRow } from '@/components/activity/activity-row';
import type { ActivityItem } from '@/lib/gateway/activity-feed';

jest.mock('@/components/ui/ListRow', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return { ListRow: (props: Record<string, unknown>) => createElement('ListRow', props) };
});
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#a0f',
    statusConnecting: '#fc0',
    statusDisconnected: '#f00',
    statusConnected: '#0f0',
  }),
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const item = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'b:session:1',
  backendId: 'backend-b',
  kind: 'session',
  sessionId: 'session-b',
  startedAt: '2026-11-10T10:00:00.000Z',
  status: 'complete',
  title: 'Backend B thread',
  metrics: {},
  ...overrides,
});

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function pressFirstRow(target: ActivityItem): Record<string, unknown> {
  const onOpenSession = jest.fn();
  act(() => {
    renderer = create(<ActivityRow item={target} onOpenSession={onOpenSession} />);
  });
  const row = renderer!.root.findByType('ListRow' as never);
  act(() => {
    (row.props as { onPress?: () => void }).onPress?.();
  });
  expect(onOpenSession).toHaveBeenCalledTimes(1);
  return onOpenSession.mock.calls[0][0] as Record<string, unknown>;
}

describe('a tapped Activity row carries its exact owner', () => {
  test('the row hands over its session, backend and Bot', () => {
    expect(pressFirstRow(item({ botId: 'bot-b' }))).toEqual({
      sessionId: 'session-b',
      backendId: 'backend-b',
      botId: 'bot-b',
    });
  });

  test('an OpenCode Bot row hands over its session, backend and Bot', () => {
    expect(pressFirstRow(item({
      id: 'opencode:session:ses_1',
      backendId: 'opencode',
      sessionId: 'ses_1',
      botId: 'build',
    }))).toEqual({
      sessionId: 'ses_1',
      backendId: 'opencode',
      botId: 'build',
    });
  });

  test('a row with no Bot names no Bot, so it cannot inherit the selected one', () => {
    expect(pressFirstRow(item())).toEqual({
      sessionId: 'session-b',
      backendId: 'backend-b',
    });
  });
});

describe('selectSession adopts an explicit row scope', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

  function selectSessionBody(src: string): string {
    const start = src.indexOf('const selectSession = useCallback');
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('selectSessionRef.current = selectSession', start));
  }

  test('the tap can name its backend and Bot, and a missing Bot means no Bot', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('scope?: { backendId: string; botId?: string }');
    expect(body).toContain('scope ?? { backendId: selectedBackendIdRef.current, botId: selectedBotIdRef.current }');
    const helper = provider().slice(
      provider().indexOf('const adoptThreadScope = useCallback'),
      provider().indexOf('const selectSession = useCallback'),
    );
    expect(helper).toContain('client?.setBotId?.(scope.botId)');
    expect(helper).toContain('selectedBotIdRef.current = scope.botId;');
    expect(helper).toContain('const previous = {');
    expect(helper).not.toContain('selectedBotIdRef.current ??');
  });

  test('the scope is adopted only after validation, before the pin and history read', () => {
    const body = selectSessionBody(provider());
    const validationAt = body.indexOf('validateThreadSwitch');
    const adoptAt = body.indexOf('adoptThreadScope(scope)');
    const pinAt = body.indexOf('pinLiveSession');
    expect(validationAt).toBeGreaterThanOrEqual(0);
    expect(adoptAt).toBeGreaterThan(validationAt);
    expect(pinAt).toBeGreaterThan(adoptAt);
  });

  test('a refused validation returns before the scope or thread changes', () => {
    const body = selectSessionBody(provider());
    const failureAt = body.indexOf('threadSwitchFailureText');
    const returnAt = body.indexOf('return;', failureAt);
    const adoptAt = body.indexOf('adoptThreadScope(scope)');
    expect(returnAt).toBeGreaterThan(failureAt);
    expect(returnAt).toBeLessThan(adoptAt);
  });

  test('a refused history read puts the previous scope back with the previous thread', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('const previousScope = scope ? adoptThreadScope(scope) : undefined;');
    expect(body).toContain('if (previousScope) adoptThreadScope(previousScope);');
  });

  test('a row from another backend moves the stored profile to that backend before the pin', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('activeGateway.backendId !== scope.backendId');
    expect(body).toContain('backendId: scope.backendId,');
    // The backend's remembered model moves with it, as selectBackend restores it.
    expect(body).toContain('effectiveModel(activeGateway, scope.backendId)');
    expect(body).toContain('...(scopedModel && scopedModel !== activeGateway.model ? { model: scopedModel } : {}),');
    expect(body).toContain('profile: scopedGateway ?? undefined,');
    expect(body).toContain('const gateway = pinned ?? scopedGateway;');
    // The rollback still restores the profile as it was before the tap.
    expect(body).toContain('profile: previousGateway ?? undefined,');
  });

  test('Activity passes the row object through to selectSession', () => {
    const activity = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(activity).toContain('onOpenSession={({ sessionId, backendId, botId }) => {');
    expect(activity).toContain('selectSession(sessionId, { backendId, botId });');
  });
});
