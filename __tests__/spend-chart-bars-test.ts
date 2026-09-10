import {
  SESSION_SPEND_LIST_LIMIT,
  spendWindowCopy,
  weekBuckets,
  type WeekBucket,
} from '@/lib/gateway/session-analytics';
import {
  SPEND_CHART_FRAME,
  spendChartBars,
  type SpendChartFrame,
} from '@/lib/gateway/spend-chart';

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

const gatewayComponents = (...parts: string[]) =>
  readSource('src', 'components', 'gateway', ...parts);
const spendChart = () => gatewayComponents('spend-chart.tsx');
const nativePlot = () => gatewayComponents('spend-chart-plot.native.tsx');
const webPlot = () => gatewayComponents('spend-chart-plot.web.tsx');
const defaultPlot = () => gatewayComponents('spend-chart-plot.tsx');
const fallbackPlot = () => gatewayComponents('spend-chart-plot-fallback.tsx');
const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');
const sparkline = () => readSource('src', 'components', 'chat', 'session-analytics.tsx');

/** Seven buckets, one per local day, with the tokens a case wants. */
function bucketsOf(tokens: number[], startMs = 1_700_000_000_000): WeekBucket[] {
  return tokens.map((value, index) => ({
    startMs: startMs + index * 86_400_000,
    tokens: value,
    costUsd: 0,
  }));
}

const SMALL: SpendChartFrame = { width: 70, height: 40 };

// P5's 7-day chart: `weekBuckets` folded into one bar per day, drawn in Skia
// on native and in plain views on web and whenever the Skia mount fails. The
// geometry is one pure helper, so neither render path aggregates the week a
// second time — these cases pin the geometry, the empty week, the window line
// the chart is captioned with, and the native/web split.
describe('one bar per day, placed in the frame the week fold was read in', () => {
  test('a bar keeps its bucket identity and the buckets keep their order', () => {
    const buckets = bucketsOf([1, 2, 3, 4, 5, 6, 7]);
    const bars = spendChartBars(buckets, SMALL);
    expect(bars).toHaveLength(7);
    expect(bars.map((bar) => bar.startMs)).toEqual(buckets.map((bucket) => bucket.startMs));
    expect(bars.map((bar) => bar.tokens)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('the bars tile the frame in order, each inside its own slot', () => {
    const bars = spendChartBars(bucketsOf([1, 2, 3, 4, 5, 6, 7]), SMALL);
    const slot = SMALL.width / 7;
    for (const [index, bar] of bars.entries()) {
      expect(bar.x).toBeGreaterThanOrEqual(index * slot);
      expect(bar.x + bar.width).toBeLessThanOrEqual((index + 1) * slot);
      expect(bar.width).toBeGreaterThan(0);
    }
    // Evenly spaced: every bar sits the same distance from the one before it.
    const gaps = bars.slice(1).map((bar, index) => bar.x - bars[index].x);
    expect(new Set(gaps).size).toBe(1);
  });

  test('the tallest day fills the frame and every other day is its share of it', () => {
    const bars = spendChartBars(bucketsOf([0, 0, 0, 40, 20, 10, 0]), SMALL);
    expect(bars.map((bar) => bar.height)).toEqual([0, 0, 0, 40, 20, 10, 0]);
  });

  test('a bar stands on the floor of the frame and its top is the frame minus its height', () => {
    for (const bar of spendChartBars(bucketsOf([4, 0, 12, 9, 1, 0, 7]), SMALL)) {
      expect(bar.y).toBe(SMALL.height - bar.height);
      expect(bar.y + bar.height).toBe(SMALL.height);
      expect(bar.y).toBeGreaterThanOrEqual(0);
    }
  });

  test('the same week in a taller frame is the same shape, twice as tall', () => {
    const short = spendChartBars(bucketsOf([0, 5, 10, 20, 0, 0, 0]), { width: 70, height: 40 });
    const tall = spendChartBars(bucketsOf([0, 5, 10, 20, 0, 0, 0]), { width: 70, height: 80 });
    expect(tall.map((bar) => bar.height)).toEqual(short.map((bar) => bar.height * 2));
  });

  test('a week the fold did not produce is no bars', () => {
    expect(spendChartBars([], SMALL)).toEqual([]);
  });
});

// The chart draws what the shipped 7-day fold says, not a second reading of
// the sessions: `weekBuckets` is the aggregation, and it runs once, in the
// screen that already made the read.
describe('the bars are the shipped week fold, aggregated nowhere else', () => {
  test('the geometry is exactly the seven days weekBuckets already returned', () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    const buckets = weekBuckets(
      [{ id: 'today', input_tokens: 50, output_tokens: 50, last_active: now }],
      now,
    );
    expect(buckets).toHaveLength(7);
    const bars = spendChartBars(buckets, SMALL);
    // Today is the last bucket, and it is the only day with anything in it.
    expect(bars.map((bar) => bar.tokens)).toEqual([0, 0, 0, 0, 0, 0, 100]);
    expect(bars[6].height).toBe(SMALL.height);
    expect(bars.slice(0, 6).map((bar) => bar.height)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('the screen folds the week once, and the chart is handed it', () => {
    const src = spendScreen();
    expect(src.match(/weekBuckets\(/g)).toHaveLength(1);
    expect(src).toContain('weekBuckets(state.sessions, now)');
    expect(src).toContain('<SpendChart');
    expect(src).toContain('buckets={');
    // Still one transport, one read: the chart adds no fetch.
    expect(src.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(1);
  });

  test('neither render path re-folds the week for itself', () => {
    for (const src of [nativePlot(), fallbackPlot()]) {
      expect(src).toContain('spendChartBars(');
      expect(src).toContain("from '@/lib/gateway/spend-chart'");
      expect(src).not.toContain('weekBuckets(');
      expect(src).not.toContain('sessionUsage(');
      expect(src).not.toContain('totalUsage(');
    }
  });
});

describe('a week with nothing in it draws no bar', () => {
  test('an all-zero week is seven zero-height bars, never a minimum', () => {
    const bars = spendChartBars(bucketsOf([0, 0, 0, 0, 0, 0, 0]), SMALL);
    expect(bars.map((bar) => bar.height)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(Math.max(...bars.map((bar) => bar.height))).toBe(0);
    // Every bar sits on the floor: nothing stands up that could read as spend.
    expect(bars.map((bar) => bar.y)).toEqual(Array.from({ length: 7 }, () => SMALL.height));
  });

  test('the fallback paints no bar the geometry did not ask for', () => {
    const src = fallbackPlot();
    expect(src).toContain('height: bar.height');
    expect(src).toContain('bottom: 0');
    expect(src).not.toContain('Math.max(');
  });
});

describe('the chart is captioned with the read its window was folded from', () => {
  test('the caption is spendWindowCopy, over the read row count', () => {
    expect(spendChart()).toContain('{spendWindowCopy(rowCount)}');
    expect(spendChart()).toContain('rowCount');
  });

  test('a capped read names the bound, a partial one claims none', () => {
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT)).toBe('Last 7 days · newest 200 sessions');
    expect(spendWindowCopy(3)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(3)).not.toMatch(/newest/);
  });

  test('the chart names what the bars measure rather than leaving them unnamed', () => {
    expect(spendChart()).toContain('Tokens per day');
    expect(spendChart()).toContain('spendWindowCopy(rowCount)');
  });
});

// The same native/web split AmbientCanvas established: Skia on native behind a
// mount boundary, and plain views everywhere else — and no Skia import on any
// path that runs on web.
describe('native draws in Skia, and every other path draws plain views', () => {
  test('the native plot paints the bars in a Skia Canvas', () => {
    const src = nativePlot();
    expect(src).toContain("from '@shopify/react-native-skia'");
    expect(src).toContain('<Canvas');
    expect(src).toContain('<Rect');
    expect(src).toContain('spendChartBars(');
  });

  test('a Skia mount that throws falls back to the plain plot', () => {
    const src = nativePlot();
    expect(src).toContain('getDerivedStateFromError');
    expect(src).toContain('<SpendChartPlotFallback {...props} />');
  });

  test('web and the default resolution both re-export the plain plot', () => {
    expect(webPlot()).toBe(
      "export { SpendChartPlotFallback as SpendChartPlot } from './spend-chart-plot-fallback';\n",
    );
    expect(defaultPlot()).toContain('SpendChartPlotFallback as SpendChartPlot');
  });

  test('no Skia import reaches web, the default resolution, or the fallback', () => {
    for (const src of [webPlot(), defaultPlot(), fallbackPlot()]) {
      expect(src).not.toContain('@shopify/react-native-skia');
    }
  });

  test('both paths draw the same box, so a bar means the same thing on either', () => {
    for (const src of [nativePlot(), fallbackPlot()]) {
      expect(src).toContain('SPEND_CHART_FRAME');
    }
    expect(SPEND_CHART_FRAME.width).toBeGreaterThan(0);
    expect(SPEND_CHART_FRAME.height).toBeGreaterThan(0);
  });
});

describe('the screen shows the chart for a read it actually made', () => {
  test('the chart renders only off a loaded read', () => {
    const src = spendScreen();
    expect(src).toContain('state.loaded ? <SpendChart');
  });

  test('the sections stay in the spec order: total, week chart, per-Bot, sessions', () => {
    const src = spendScreen();
    const total = src.indexOf('{sessionSpendCopy(spend)}');
    const chart = src.indexOf('<SpendChart');
    const perBot = src.indexOf('<SpendPerBotSection');
    const table = src.indexOf('<SpendSessionTable');
    expect(total).toBeGreaterThanOrEqual(0);
    expect(chart).toBeGreaterThan(total);
    expect(perBot).toBeGreaterThan(chart);
    expect(table).toBeGreaterThan(perBot);
  });
});

describe('what must keep working', () => {
  test('weekBuckets still folds the same seven local days', () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    const buckets = weekBuckets([{ id: 'a', input_tokens: 10, last_active: now }], now);
    expect(buckets).toHaveLength(7);
    expect(buckets[6].tokens).toBe(10);
    expect(buckets[0].tokens).toBe(0);
  });

  test('spendWindowCopy is byte-identical for the sparkline and the chart', () => {
    expect(spendWindowCopy(0)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT)).toBe('Last 7 days · newest 200 sessions');
  });

  test('the sparkline keeps its own window line and the total keeps its bound line', () => {
    expect(sparkline()).toContain('{spendWindowCopy(rowCount)}');
    expect(spendScreen()).toContain('spendTotalBoundCopy(state.rowCount)');
  });
});
