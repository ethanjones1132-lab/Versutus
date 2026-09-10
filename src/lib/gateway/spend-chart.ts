import { relativeMeter, type WeekBucket } from './session-analytics';

export type SpendChartFrame = { width: number; height: number };

/**
 * The box P5's 7-day chart is drawn into, on both render paths — Skia on
 * native, plain views on web and as the Skia mount's fallback — so a bar's
 * geometry means the same thing wherever it is painted.
 *
 * The width is fixed rather than measured, the same choice the 7-day
 * sparkline makes (`SPARK_W = 220`, `session-analytics.tsx:17`). A 320pt phone
 * is the narrowest the Spend screen's card can be on: `Spacing.four` (24) of
 * screen padding and `Spacing.three` (16) of card padding each side leave 240,
 * and the chart takes 232 of it so the card's own border cannot clip a bar.
 */
export const SPEND_CHART_FRAME: SpendChartFrame = { width: 232, height: 64 };

/** The gutter between two days' bars, so seven of them do not read as a block. */
const SPEND_CHART_BAR_GAP = 3;

/** One day of the 7-day chart, in the frame's own coordinates. */
export type SpendChartBar = {
  /** The bucket's local-day start: the bar's identity, never its position. */
  startMs: number;
  /** The bucketed tokens the bar's height was scaled from. */
  tokens: number;
  /** Left edge, in frame coordinates. */
  x: number;
  /** Drawn width — its slot less the gutter beside the neighbouring day. */
  width: number;
  /** Drawn height: the day's share of the week's peak. */
  height: number;
  /** Top edge, in frame coordinates: the frame's floor less the height. */
  y: number;
};

/**
 * Bar geometry for P5's 7-day chart, over the buckets `weekBuckets` already
 * folded — the chart adds no aggregation of its own, it only places what the
 * week fold returned.
 *
 * The tallest day fills the frame (`relativeMeter` against the week's own
 * peak) and every other day is its share of that, so the chart's shape is the
 * week's shape at whatever frame it is drawn in. A week with nothing in it is
 * seven zero-height bars rather than a minimum: an empty week must not draw
 * something that reads as spend.
 */
export function spendChartBars(buckets: WeekBucket[], frame: SpendChartFrame): SpendChartBar[] {
  const peak = Math.max(...buckets.map((bucket) => bucket.tokens), 0);
  return buckets.map((bucket, index) => {
    const slot = frame.width / buckets.length;
    const height = relativeMeter(bucket.tokens, peak).ratio * frame.height;
    return {
      startMs: bucket.startMs,
      tokens: bucket.tokens,
      x: index * slot + SPEND_CHART_BAR_GAP / 2,
      width: Math.max(0, slot - SPEND_CHART_BAR_GAP),
      height,
      y: frame.height - height,
    };
  });
}
