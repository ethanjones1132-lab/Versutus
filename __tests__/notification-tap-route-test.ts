import {
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
    // Only a routine route opens Chat. A weekly report's destination takes no
    // argument — the Scorecards section reads this device's runs when it opens
    // — so the weekly route keeps the Activity landing the section is mounted on.
    expect(src).toContain("route?.kind === 'routine' ? '/chat' : '/activity'");
  });

  test('the launch tap is still read once and retired before it can route twice', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('launchReadRef.current');
    expect(src).toContain('isLaunchReplay(');
  });

  test('the deep-link router keeps its add / gateway/add handling', () => {
    const src = between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');
    expect(src).toContain("path !== 'add' && path !== 'gateway/add'");
    expect(src).toContain("pathname: '/gateway/add'");
  });
});
