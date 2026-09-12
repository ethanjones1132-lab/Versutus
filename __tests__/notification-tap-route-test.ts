import {
  REPLY_NOTICE_DATA_KIND,
  RUN_NOTICE_DATA_KIND,
  routeForTap,
  type TapRoute,
} from '@/lib/notifications/tap-route';
import {
  ROUTINE_NOTICE_DATA_KIND,
  routineNoticeData,
} from '@/lib/notifications/routine-schedule';
import {
  WEEKLY_REPORT_NOTICE_DATA_KIND,
  weeklyReportNoticeData,
} from '@/lib/notifications/weekly-report-schedule';

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

const layout = () => readSource('src', 'app', '_layout.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('routeForTap (pure notification tap routing)', () => {
  test('a routine notice routes to its routine by kind', () => {
    const route: TapRoute | null = routeForTap(routineNoticeData('job-1', 'scout'));
    expect(route).toEqual({ kind: 'routine', jobId: 'job-1', botId: 'scout' });
  });

  test('a run notice routes to its run by kind', () => {
    expect(routeForTap({ kind: RUN_NOTICE_DATA_KIND, runId: 'run-7' })).toEqual({
      kind: 'run',
      runId: 'run-7',
    });
  });

  test('an A5 routine notice routes to its routine by kind', () => {
    const route: TapRoute | null = routeForTap({ kind: 'routine', jobId: 'job-1', botId: 'scout' });
    expect(route).toEqual({ kind: 'routine', jobId: 'job-1', botId: 'scout' });
  });

  test('a half-shaped A5 routine notice is not routed', () => {
    expect(routeForTap({ kind: 'routine', jobId: 'job-1' })).toBeNull();
    expect(routeForTap({ kind: 'routine', botId: 'scout' })).toBeNull();
    expect(routeForTap({ kind: 'routine', jobId: '', botId: 'scout' })).toBeNull();
  });

  test('the local routine-due spelling still routes', () => {
    const route: TapRoute | null = routeForTap(routineNoticeData('job-1', 'scout'));
    expect(route).toEqual({ kind: 'routine', jobId: 'job-1', botId: 'scout' });
  });

  test('a run notice drops extra bot metadata', () => {
    expect(
      routeForTap({ kind: RUN_NOTICE_DATA_KIND, runId: 'run-7', botId: 'scout' }),
    ).toEqual({ kind: 'run', runId: 'run-7' });
  });

  test('a reply notice routes to its session and carries its optional bot', () => {
    const route: TapRoute | null = routeForTap({
      kind: REPLY_NOTICE_DATA_KIND,
      sessionId: 'session-7',
      botId: 'scout',
    });
    expect(route).toEqual({ kind: 'reply', sessionId: 'session-7', botId: 'scout' });
  });

  test('a reply without a session id is not routed', () => {
    expect(routeForTap({ kind: REPLY_NOTICE_DATA_KIND, botId: 'scout' })).toBeNull();
    expect(routeForTap({ kind: REPLY_NOTICE_DATA_KIND, sessionId: '' })).toBeNull();
  });

  test('a weekly report notice routes on its own kind, and carries no id', () => {
    // D3 Build 4: the weekly notice's tap opens the scorecard surface, which
    // computes when it opens — so the destination takes no argument and the
    // payload is only its kind.
    expect(routeForTap(weeklyReportNoticeData())).toEqual({ kind: 'weekly-report' });
  });

  test('a weekly report payload that later carries real figures still routes by kind', () => {
    // D3: when Solution A ships, the Gate can send the week's real numbers in
    // this payload (the A5 payload-shape rule). The kind is the contract that
    // decides the route; extra keys ride along unread.
    expect(
      routeForTap({ kind: WEEKLY_REPORT_NOTICE_DATA_KIND, runs: 12, spendUsd: 3.5 }),
    ).toEqual({ kind: 'weekly-report' });
  });

  test('a payload with no kind is unrecognized — the Activity fallback', () => {
    expect(routeForTap(undefined)).toBeNull();
    expect(routeForTap(null)).toBeNull();
    expect(routeForTap({})).toBeNull();
    expect(routeForTap('routine-due')).toBeNull();
    expect(routeForTap(42)).toBeNull();
  });

  test('a gateway-down notice is not a tap route', () => {
    // The down notice carries its own kind; a tap on it must not be routed
    // as a run or a routine just because it has a payload.
    expect(routeForTap({ kind: 'gateway-down', gatewayKey: 'gw-1' })).toBeNull();
  });

  test('an approval payload is unrecognized until the approval action ships', () => {
    // Phase 0 only routes routine and run taps; approvals keep landing on
    // Activity, which is where the operator decides them.
    expect(routeForTap({ kind: 'approval', runId: 'run-7' })).toBeNull();
    expect(routeForTap({ kind: 'nonsense', runId: 'run-7' })).toBeNull();
  });

  test('a kind whose ids are missing is unrecognized, not a half-route', () => {
    expect(routeForTap({ kind: ROUTINE_NOTICE_DATA_KIND, jobId: 'job-1' })).toBeNull();
    expect(routeForTap({ kind: ROUTINE_NOTICE_DATA_KIND, botId: 'scout' })).toBeNull();
    expect(routeForTap({ kind: ROUTINE_NOTICE_DATA_KIND, jobId: '', botId: 'scout' })).toBeNull();
    expect(routeForTap({ kind: ROUTINE_NOTICE_DATA_KIND, jobId: 3, botId: 'scout' })).toBeNull();
    expect(routeForTap({ kind: RUN_NOTICE_DATA_KIND })).toBeNull();
    expect(routeForTap({ kind: RUN_NOTICE_DATA_KIND, runId: '' })).toBeNull();
    expect(routeForTap({ kind: RUN_NOTICE_DATA_KIND, runId: 7 })).toBeNull();
  });
});

describe('NotificationRouter', () => {
  test('routes on the response payload rather than on every tap alike', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('response.notification.request.content.data');
    expect(src).toContain('routeForTap');
  });

  test('a routine tap opens Chat; runs and unrecognized taps stay on Activity', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain("route?.kind === 'routine'");
    expect(src).toContain("'/chat'");
    expect(src).toContain("'/activity'");
  });

  test('a weekly report tap opens the scorecard surface on Activity, not Chat', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    // A routine route and a reply route open Chat; a weekly report does not. A
    // weekly report's destination takes no argument — the Scorecards section
    // reads this device's runs when it opens — so the weekly route keeps the
    // Activity landing the section is mounted on.
    expect(src).toContain(
      "route?.kind === 'routine' || route?.kind === 'reply' ? '/chat' : '/activity'",
    );
  });

  test('the launch tap is still read once and retired before it can route twice', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('launchReadRef.current');
    expect(src).toContain('isLaunchReplay(');
  });

  test('the deep-link router keeps its add / gateway/add handling', () => {
    const src = between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');
    // Both spellings are `deepLinkTarget`'s own cases now (that suite reads
    // `add` and `gateway/add`); the router still hands the link's path and
    // query to the fold and pushes that target's params to the same sheet.
    expect(src).toContain('deepLinkTarget(parsed.path, parsed.queryParams ?? {})');
    expect(src).toContain("pathname: '/gateway/add'");
    expect(src).toContain('params: target.params');
  });
});

describe('a finished model reply opens the conversation it is about', () => {
  const routerSource = () =>
    between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');

  const listener = () =>
    between(
      routerSource(),
      'addNotificationResponseReceivedListener',
      'return () => subscription.remove()',
    );

  test('a reply tap opens Chat, not Activity', () => {
    const src = routerSource();

    // The reply route exists to land in its conversation, and a conversation
    // lives on Chat — so a reply joins the routine route as a Chat destination
    // instead of the Activity fallback that used to swallow it.
    expect(src).toContain("route?.kind === 'reply'");
    expect(src).toContain(
      "route?.kind === 'routine' || route?.kind === 'reply' ? '/chat' : '/activity'",
    );
  });

  test('only a reply route becomes a session open', () => {
    const src = routerSource();

    // The destination drops the id — Chat is one tab — so the session rides
    // beside it. A routine, a run, a weekly report and an unrecognized payload
    // all ask for no open at all.
    expect(src).toContain("route?.kind === 'reply' ? { sessionId: route.sessionId } : null");
  });

  test('the session open is asked for right after the navigation', () => {
    const src = listener();

    const navigate = src.indexOf('router.navigate(destination)');
    const ask = src.indexOf('replySessionRef.current?.(replySession.sessionId)');
    expect(navigate).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(navigate);
    expect(src).toContain(
      'const replySession = replySessionFor(response.notification.request.content.data)',
    );
  });

  test('the open is validated by session.get, and a miss is named, never thrown', () => {
    const src = routerSource();

    // The proven open-by-id pairing: validate through `session.get` before
    // switching, because a push-delivered id can be stale. A rejected read
    // surfaces the same failure copy the thread sheet posts, as a local notice
    // rather than a throw or a silent no-op.
    expect(src).toContain('openSessionById(gatewayRequest, sessionId)');
    expect(src).toContain('if (!result.ok)');
    expect(src).toContain('openSessionByIdFailureText(sessionId, result.error)');
    expect(src).toContain('void notifySessionOpenFailed(');
    expect(src).toContain('replySessionRef.current = (sessionId: string) =>');
  });

  test('a reply tap that launched the app keeps its open across the bootstrap wait', () => {
    const src = routerSource();

    // Held in the same slot the destination is, for the same reason the run
    // focus is: a reply notice is usually tapped from a cold start.
    expect(src).toContain(
      'pendingReplySessionRef.current = replySessionFor(',
    );
    expect(src).toContain('const replySession = pendingReplySessionRef.current');
    expect(src).toContain('pendingReplySessionRef.current = null');
    // Both call sites apply it the same way — the launch-replay path behaves
    // identically to the live listener path.
    expect((src.match(/if \(replySession\) replySessionRef\.current\?\.\(replySession\.sessionId\);/g) ?? []).length).toBe(2);
  });

  test('the session open reaches the tab through a ref, so the listener is registered once', () => {
    const src = routerSource();

    expect(src).toContain('replySessionRef.current = (sessionId: string) =>');
    const listenerEnd = src.slice(src.indexOf('addNotificationResponseReceivedListener'));
    expect(listenerEnd).toContain('}, [router, isBootstrapped]);');
  });

  test('routine and run routing are unchanged', () => {
    const src = routerSource();

    expect(src).toContain("route?.kind === 'routine'");
    expect(src).toContain("route?.kind === 'run' ? { runId: route.runId } : null");
    expect(src).toContain('if (runFocus) runFocusRef.current?.(runFocus);');
  });
});
