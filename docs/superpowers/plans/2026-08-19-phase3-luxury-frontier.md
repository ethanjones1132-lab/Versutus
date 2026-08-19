# Phase 3 Luxury Frontier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the phone a Skia aurora/grain field with scroll parallax, session token/cost meters plus a 7-day sparkline in Chat overflow, and a choreographed Activity approval card.

**Architecture:** Three isolated units. Pure mappers (`mapAmbientParallax`, `sessionUsage`/`weekBuckets`/`relativeMeter`, `nextApprovalExit`) are the testable cores. React surfaces consume those only. Native `AmbientCanvas` paints aurora+grain in Skia and falls back to the existing Reanimated field; web never imports Skia.

**Tech Stack:** Expo SDK 57 / React Native 0.86 / React 19, jest-expo, Reanimated 4.5, `react-native-svg` 15.15.4 (already installed), `@shopify/react-native-skia` pinned via `npx expo install` per https://docs.expo.dev/versions/v57.0.0/sdk/skia/.

**Spec:** `docs/superpowers/specs/2026-08-18-phase3-luxury-frontier-design.md`

## Global Constraints

- Read https://docs.expo.dev/versions/v57.0.0/ before adding Skia or changing native UI. Pin Skia with `npx expo install @shopify/react-native-skia`.
- Do **not** import `@shopify/react-native-skia` from any `.web.tsx` file or from `ambient-fallback.tsx`.
- Stay cross-compatible where cheap; **Android wins** any real conflict.
- Do **not** modify `src/context/gateway-provider.tsx`, Gate server, session APIs, or run RPC.
- New JS logic is test-first. Visual timings come from `approvalExitDuration`, not magic numbers in JSX.
- Haptics go through `src/lib/haptics.ts` (never throw).
- Sparkline copy is exactly `Last 7 days · from recent sessions`. There is no quota and no invented billing week.
- No audio asset. No Screen-level scroll context. Onboarding stays at rest (no parallax).
- After each task: `npx tsc --noEmit` on touched files is implied; run the focused Jest file named in the task.
- Work in `C:\Projects\Versutus`. Preserve unrelated working-tree changes.

---

## File Structure

**New**

- `src/lib/motion/ambient-parallax.ts` — `mapAmbientParallax`, `useAmbientParallaxScroll`
- `src/lib/gateway/session-analytics.ts` — `sessionUsage`, `weekBuckets`, `relativeMeter`
- `src/lib/motion/approval-exit.ts` — `nextApprovalExit`, `approvalExitDuration`
- `src/components/chat/session-analytics.tsx` — meters + SVG sparkline
- `src/components/activity/approval-decision-card.tsx` — choreographed Activity card
- `src/components/layout/ambient-fallback.tsx` — Reanimated + PNG grain (web + Skia-mount fallback)
- `src/components/layout/AmbientCanvas.native.tsx` — Skia paint + sightline Views
- `src/components/layout/AmbientCanvas.web.tsx` — re-export fallback
- `__tests__/ambient-parallax-test.ts`
- `__tests__/session-analytics-test.ts`
- `__tests__/approval-exit-test.ts`

**Modified**

- `src/components/layout/AmbientCanvas.tsx` — re-export fallback as default
- `src/components/ui/types.ts` — `ScreenProps.parallaxX` / `parallaxY`
- `src/components/ui/Screen.tsx` — forward parallax to `AmbientCanvas`
- `src/app/(tabs)/index.tsx` — Home scroll → parallax
- `src/app/(tabs)/activity.tsx` — extract card, scroll → parallax
- `src/components/chat/chat-screen.tsx` — FlatList scroll → parallax; pass `sessionList`
- `src/components/terminal/terminal-screen.tsx` — Tools scroll → parallax
- `src/components/chat/chat-overflow-sheet.tsx` — `sessions` + `SessionAnalytics`
- `src/components/chat/approval-sheet.tsx` — haptic pairing only
- `package.json` / `package-lock.json` — Skia pin

**Not modified**

- `src/context/gateway-provider.tsx`
- anything under `gate/`

---

### Task 1: Ambient parallax mapper

**Files:**
- Create: `src/lib/motion/ambient-parallax.ts`
- Test: `__tests__/ambient-parallax-test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `mapAmbientParallax(scrollYPx: number): { parallaxX: number; parallaxY: number }`; `useAmbientParallaxScroll(): { parallaxX: number; parallaxY: number; onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void }`

- [ ] **Step 1: Write the failing test**

Create `__tests__/ambient-parallax-test.ts`:

```ts
import { mapAmbientParallax } from '@/lib/motion/ambient-parallax';

describe('mapAmbientParallax', () => {
  test('rest at 0', () => {
    expect(mapAmbientParallax(0)).toEqual({ parallaxX: 0, parallaxY: 0 });
  });

  test('480px maps to +1 and -480px maps to -1', () => {
    expect(mapAmbientParallax(480)).toEqual({ parallaxX: 0, parallaxY: 1 });
    expect(mapAmbientParallax(-480)).toEqual({ parallaxX: 0, parallaxY: -1 });
  });

  test('clamps extreme scroll and treats non-finite as rest', () => {
    expect(mapAmbientParallax(10_000)).toEqual({ parallaxX: 0, parallaxY: 1 });
    expect(mapAmbientParallax(-10_000)).toEqual({ parallaxX: 0, parallaxY: -1 });
    expect(mapAmbientParallax(Number.NaN)).toEqual({ parallaxX: 0, parallaxY: 0 });
    expect(mapAmbientParallax(Number.POSITIVE_INFINITY)).toEqual({ parallaxX: 0, parallaxY: 0 });
  });

  test('parallaxX is always 0 this phase', () => {
    expect(mapAmbientParallax(240).parallaxX).toBe(0);
    expect(mapAmbientParallax(240).parallaxY).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/ambient-parallax-test.ts --coverage=false`

Expected: FAIL — `Cannot find module '@/lib/motion/ambient-parallax'` or `mapAmbientParallax is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/motion/ambient-parallax.ts`:

```ts
import { useCallback, useRef, useState } from 'react';

export type AmbientParallax = {
  parallaxX: number;
  parallaxY: number;
};

export function mapAmbientParallax(scrollYPx: number): AmbientParallax {
  if (!Number.isFinite(scrollYPx)) return { parallaxX: 0, parallaxY: 0 };
  const y = Math.max(-1, Math.min(1, scrollYPx / 480));
  return { parallaxX: 0, parallaxY: y };
}

/** Scroll handler that only re-renders when the mapped Y moves by ≥ 0.04. */
export function useAmbientParallaxScroll(): AmbientParallax & {
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
} {
  const [parallax, setParallax] = useState<AmbientParallax>({ parallaxX: 0, parallaxY: 0 });
  const lastY = useRef(0);
  const onScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const next = mapAmbientParallax(event.nativeEvent.contentOffset.y);
    if (Math.abs(next.parallaxY - lastY.current) < 0.04) return;
    lastY.current = next.parallaxY;
    setParallax(next);
  }, []);
  return { ...parallax, onScroll };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/ambient-parallax-test.ts --coverage=false`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add __tests__/ambient-parallax-test.ts src/lib/motion/ambient-parallax.ts
git commit -m "feat: map ambient parallax from vertical scroll"
```

---

### Task 2: Session usage, week buckets, relative meters

**Files:**
- Create: `src/lib/gateway/session-analytics.ts`
- Test: `__tests__/session-analytics-test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `sessionUsage(session): { tokens: number; costUsd: number | null }`
  - `weekBuckets(sessions, now): { startMs: number; tokens: number; costUsd: number }[]` — length 7, index 0 oldest
  - `relativeMeter(value, weekMax): { value: number; peak: number; ratio: number }`

- [ ] **Step 1: Write the failing test**

Create `__tests__/session-analytics-test.ts`:

```ts
import { relativeMeter, sessionUsage, weekBuckets } from '@/lib/gateway/session-analytics';

describe('sessionUsage', () => {
  test('sums tokens and prefers actual cost', () => {
    expect(
      sessionUsage({
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.02,
        estimated_cost_usd: 0.99,
      }),
    ).toEqual({ tokens: 150, costUsd: 0.02 });
  });

  test('missing token fields count as 0 and missing costs are null', () => {
    expect(sessionUsage({})).toEqual({ tokens: 0, costUsd: null });
    expect(sessionUsage({ estimated_cost_usd: 1.5 })).toEqual({ tokens: 0, costUsd: 1.5 });
  });
});

describe('relativeMeter', () => {
  test('0/0 is ratio 0', () => {
    expect(relativeMeter(0, 0)).toEqual({ value: 0, peak: 0, ratio: 0 });
  });

  test('value above week max becomes the peak and ratio never exceeds 1', () => {
    expect(relativeMeter(10, 5)).toEqual({ value: 10, peak: 10, ratio: 1 });
    expect(relativeMeter(5, 10)).toEqual({ value: 5, peak: 10, ratio: 0.5 });
  });
});

describe('weekBuckets', () => {
  const noonOn = (year: number, monthIndex: number, day: number) =>
    new Date(year, monthIndex, day, 12, 0, 0).getTime();

  test('returns 7 local days ending today, oldest first', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets([], now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0].startMs).toBe(new Date(2026, 7, 13).getTime());
    expect(buckets[6].startMs).toBe(new Date(2026, 7, 19).getTime());
    expect(buckets.every((bucket) => bucket.tokens === 0 && bucket.costUsd === 0)).toBe(true);
  });

  test('groups by local day, skips missing timestamps, accepts unix seconds', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets(
      [
        { last_active: noonOn(2026, 7, 19) / 1000, input_tokens: 10, output_tokens: 5, actual_cost_usd: 0.4 },
        { last_active: noonOn(2026, 7, 13), input_tokens: 20, output_tokens: 0, estimated_cost_usd: 0.1 },
        { last_active: noonOn(2026, 7, 12), input_tokens: 999, output_tokens: 0 },
        { input_tokens: 50, output_tokens: 50 },
      ],
      now,
    );
    expect(buckets[6].tokens).toBe(15);
    expect(buckets[6].costUsd).toBe(0.4);
    expect(buckets[0].tokens).toBe(20);
    expect(buckets[0].costUsd).toBe(0.1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(35);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/session-analytics-test.ts --coverage=false`

Expected: FAIL — module or exports missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/gateway/session-analytics.ts`:

```ts
export type SessionUsageInput = {
  input_tokens?: number;
  output_tokens?: number;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  last_active?: number;
};

export type SessionUsage = { tokens: number; costUsd: number | null };

export type WeekBucket = { startMs: number; tokens: number; costUsd: number };

export type RelativeMeter = { value: number; peak: number; ratio: number };

function toEpochMs(timestamp: number): number {
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function startOfLocalDay(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

export function sessionUsage(session: SessionUsageInput): SessionUsage {
  const input = typeof session.input_tokens === 'number' ? session.input_tokens : 0;
  const output = typeof session.output_tokens === 'number' ? session.output_tokens : 0;
  const tokens = Math.max(0, input + output);
  const cost = session.actual_cost_usd ?? session.estimated_cost_usd;
  return { tokens, costUsd: typeof cost === 'number' ? cost : null };
}

export function relativeMeter(value: number, weekMax: number): RelativeMeter {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const safeWeek = Number.isFinite(weekMax) ? Math.max(0, weekMax) : 0;
  const peak = Math.max(safeValue, safeWeek, 0);
  return { value: safeValue, peak, ratio: peak === 0 ? 0 : safeValue / peak };
}

export function weekBuckets(sessions: SessionUsageInput[], now: number): WeekBucket[] {
  const today = startOfLocalDay(now);
  const buckets: WeekBucket[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const cursor = new Date(today);
    cursor.setDate(cursor.getDate() - offset);
    buckets.push({ startMs: cursor.getTime(), tokens: 0, costUsd: 0 });
  }
  const indexByStart = new Map(buckets.map((bucket, index) => [bucket.startMs, index]));
  for (const session of sessions) {
    if (typeof session.last_active !== 'number' || !Number.isFinite(session.last_active)) continue;
    const start = startOfLocalDay(toEpochMs(session.last_active));
    const index = indexByStart.get(start);
    if (index === undefined) continue;
    const usage = sessionUsage(session);
    buckets[index].tokens += usage.tokens;
    buckets[index].costUsd += usage.costUsd ?? 0;
  }
  return buckets;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/session-analytics-test.ts --coverage=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/session-analytics-test.ts src/lib/gateway/session-analytics.ts
git commit -m "feat: derive session meters and 7-day buckets"
```

---

### Task 3: Approval exit state machine

**Files:**
- Create: `src/lib/motion/approval-exit.ts`
- Test: `__tests__/approval-exit-test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ApprovalExit = 'idle' | 'approving' | 'denying'`; `nextApprovalExit(current, action)`; `approvalExitDuration(kind)` — idle 0, approving 280, denying 320

- [ ] **Step 1: Write the failing test**

Create `__tests__/approval-exit-test.ts`:

```ts
import { approvalExitDuration, nextApprovalExit } from '@/lib/motion/approval-exit';

describe('nextApprovalExit', () => {
  test('idle accepts approve and deny', () => {
    expect(nextApprovalExit('idle', 'approve')).toBe('approving');
    expect(nextApprovalExit('idle', 'deny')).toBe('denying');
  });

  test('a second tap while exiting is a no-op', () => {
    expect(nextApprovalExit('approving', 'deny')).toBe('approving');
    expect(nextApprovalExit('denying', 'approve')).toBe('denying');
    expect(nextApprovalExit('approving', 'approve')).toBe('approving');
  });

  test('reset returns idle from any state', () => {
    expect(nextApprovalExit('approving', 'reset')).toBe('idle');
    expect(nextApprovalExit('denying', 'reset')).toBe('idle');
    expect(nextApprovalExit('idle', 'reset')).toBe('idle');
  });
});

describe('approvalExitDuration', () => {
  test('matches the choreography table', () => {
    expect(approvalExitDuration('idle')).toBe(0);
    expect(approvalExitDuration('approving')).toBe(280);
    expect(approvalExitDuration('denying')).toBe(320);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/approval-exit-test.ts --coverage=false`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/motion/approval-exit.ts`:

```ts
export type ApprovalExit = 'idle' | 'approving' | 'denying';

export type ApprovalExitAction = 'approve' | 'deny' | 'reset';

export function nextApprovalExit(current: ApprovalExit, action: ApprovalExitAction): ApprovalExit {
  if (action === 'reset') return 'idle';
  if (current !== 'idle') return current;
  return action === 'approve' ? 'approving' : 'denying';
}

export function approvalExitDuration(kind: ApprovalExit): number {
  if (kind === 'approving') return 280;
  if (kind === 'denying') return 320;
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/approval-exit-test.ts --coverage=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/approval-exit-test.ts src/lib/motion/approval-exit.ts
git commit -m "feat: approval exit state and durations"
```

---

### Task 4: Session analytics in Chat overflow

**Files:**
- Create: `src/components/chat/session-analytics.tsx`
- Modify: `src/components/chat/chat-overflow-sheet.tsx`
- Modify: `src/components/chat/chat-screen.tsx` (the `ChatOverflowSheet` call only)

**Interfaces:**
- Consumes: `sessionUsage`, `weekBuckets`, `relativeMeter` from Task 2; `formatTokenCount` / `formatCost` from `@/lib/format`
- Produces: `SessionAnalytics` replacing the three `StatTile`s; `ChatOverflowSheet` gains `sessions?: SessionUsageInput[]`

This task has no new pure logic. Do not add a render test. The Jest suites from Task 2 stay the contract.

- [ ] **Step 1: Add `SessionAnalytics`**

Create `src/components/chat/session-analytics.tsx`:

```tsx
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { formatCost, formatTokenCount } from '@/lib/format';
import {
  relativeMeter,
  sessionUsage,
  weekBuckets,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';

const SPARK_W = 220;
const SPARK_H = 36;

export function SessionAnalytics({
  session,
  sessions,
  messageCount,
}: {
  session: SessionUsageInput;
  sessions: SessionUsageInput[];
  messageCount?: number;
}) {
  const tokens = useTokens();
  const usage = sessionUsage(session);
  const buckets = useMemo(() => weekBuckets(sessions, Date.now()), [sessions]);
  const weekTokenPeak = Math.max(...buckets.map((bucket) => bucket.tokens), 0);
  const weekCostPeak = Math.max(...buckets.map((bucket) => bucket.costUsd), 0);
  const tokenMeter = relativeMeter(usage.tokens, weekTokenPeak);
  const costMeter = relativeMeter(usage.costUsd ?? 0, weekCostPeak);
  const sparkPoints = sparklinePoints(
    buckets.map((bucket) => bucket.tokens),
    SPARK_W,
    SPARK_H,
  );

  return (
    <View style={styles.wrap}>
      <Meter
        label="Tokens"
        value={formatTokenCount(usage.tokens)}
        ratio={tokenMeter.ratio}
        track={tokens.backgroundInset}
        fill={tokens.accentWarm}
      />
      <Meter
        label="Cost"
        value={usage.costUsd != null ? formatCost(usage.costUsd) : '—'}
        ratio={usage.costUsd == null ? 0 : costMeter.ratio}
        track={tokens.backgroundInset}
        fill={tokens.accent}
      />
      <View style={styles.sparkBlock}>
        <Svg width={SPARK_W} height={SPARK_H} style={styles.spark}>
          {sparkPoints ? (
            <Polyline
              points={sparkPoints}
              fill="none"
              stroke={tokens.accentWarm}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : (
            <Polyline
              points={`0,${SPARK_H - 1} ${SPARK_W},${SPARK_H - 1}`}
              fill="none"
              stroke={tokens.border}
              strokeWidth={StyleSheet.hairlineWidth}
            />
          )}
        </Svg>
        <Text variant="micro" color="tertiary">
          Last 7 days · from recent sessions
        </Text>
      </View>
      {typeof messageCount === 'number' ? (
        <Text variant="caption" color="tertiary">
          {messageCount} messages
        </Text>
      ) : null}
    </View>
  );
}

function sparklinePoints(values: number[], width: number, height: number): string | null {
  const peak = Math.max(...values, 0);
  if (peak === 0) return null;
  const last = values.length - 1;
  return values
    .map((value, index) => {
      const x = last === 0 ? 0 : (index / last) * width;
      const y = height - (value / peak) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(' ');
}

function Meter({
  label,
  value,
  ratio,
  track,
  fill,
}: {
  label: string;
  value: string;
  ratio: number;
  track: string;
  fill: string;
}) {
  return (
    <View style={styles.meter}>
      <View style={styles.meterLabel}>
        <Text variant="micro" color="tertiary">
          {label}
        </Text>
        <Text variant="caption">{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: track }]}>
        <View style={[styles.fill, { width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`, backgroundColor: fill }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.two,
  },
  meter: {
    gap: Spacing.one,
  },
  meterLabel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  track: {
    height: 4,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    borderRadius: Radius.full,
  },
  sparkBlock: {
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  spark: {
    alignSelf: 'stretch',
  },
});
```

- [ ] **Step 2: Replace the StatTile row in the overflow sheet**

In `src/components/chat/chat-overflow-sheet.tsx`:

- Import `SessionAnalytics` and `SessionUsageInput`.
- Drop unused `StatTile`, `formatCost`, `formatTokenCount` imports if they become unused (`formatRelativeTime` stays).
- Extend props:

```ts
sessions?: SessionUsageInput[];
```

- Replace the `{session ? ( <View style={styles.stats}> StatTiles… ) : empty}` block with:

```tsx
{session ? (
  <SessionAnalytics
    session={{
      input_tokens: session.totalTokens,
      output_tokens: 0,
      actual_cost_usd: session.costUsd,
    }}
    sessions={sessions ?? []}
    messageCount={session.messageCount}
  />
) : (
  <Text variant="caption" color="tertiary" style={styles.noSession}>
    No session stats yet — open the session selector to load them.
  </Text>
)}
```

`session.totalTokens` is already `input + output` from `ChatScreen`. Passing it as `input_tokens` with `output_tokens: 0` keeps `sessionUsage` honest without double-counting.

Destructure `sessions = []` in the component signature.

- [ ] **Step 3: Pass `sessionList` from Chat**

In `src/components/chat/chat-screen.tsx`, on the existing `<ChatOverflowSheet>` call, add:

```tsx
sessions={sessionList}
```

`sessionList` is already in the `useGateway()` destructure. Do not touch the provider.

- [ ] **Step 4: Typecheck the slice**

Run: `npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/session-analytics.tsx src/components/chat/chat-overflow-sheet.tsx src/components/chat/chat-screen.tsx
git commit -m "feat: session meters and weekly sparkline in chat overflow"
```

---

### Task 5: Approval decision card + sheet haptic fix

**Files:**
- Create: `src/components/activity/approval-decision-card.tsx`
- Modify: `src/app/(tabs)/activity.tsx` (pending-approval block + unused `decide` + unused approval styles)
- Modify: `src/components/chat/approval-sheet.tsx`

**Interfaces:**
- Consumes: `nextApprovalExit`, `approvalExitDuration` from Task 3; `haptics` from `@/lib/haptics`
- Produces: `ApprovalDecisionCard` that calls `onResolve(approved)` only after the exit duration

- [ ] **Step 1: Extract the choreographed card**

Create `src/components/activity/approval-decision-card.tsx`:

```tsx
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Button, Card, Icon, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';
import { approvalExitDuration, nextApprovalExit, type ApprovalExit } from '@/lib/motion/approval-exit';

export function ApprovalDecisionCard({
  runId,
  prompt,
  onResolve,
}: {
  runId: string;
  prompt?: string;
  onResolve: (approved: boolean) => void;
}) {
  const tokens = useTokens();
  const [exit, setExit] = useState<ApprovalExit>('idle');
  const locked = useRef(false);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const borderProgress = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
    borderColor: borderProgress.value > 0.5 ? tokens.statusDisconnected : tokens.accentWarm,
  }));

  const decide = (approved: boolean) => {
    if (locked.current) return;
    const next = nextApprovalExit(exit, approved ? 'approve' : 'deny');
    if (next === exit) return;
    locked.current = true;
    setExit(next);
    if (approved) {
      void haptics.success();
      scale.value = withTiming(0.92, { duration: approvalExitDuration('approving') });
      opacity.value = withTiming(0, { duration: approvalExitDuration('approving') });
    } else {
      void haptics.warning();
      borderProgress.value = withTiming(1, { duration: approvalExitDuration('denying') });
    }
    const duration = approvalExitDuration(next);
    setTimeout(() => onResolve(approved), duration);
  };

  const busy = exit !== 'idle';

  return (
    <Animated.View style={animatedStyle}>
      <Card variant="hero" padding={Spacing.three} style={styles.card}>
        <View style={styles.header}>
          <Icon
            name={{ ios: 'hand.raised.fill', android: 'pan_tool', web: 'pan_tool' }}
            size={16}
            color="accentWarm"
          />
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Approval requested
          </Text>
        </View>
        <Text variant="body" numberOfLines={3}>
          {prompt}
        </Text>
        <Text variant="mono" color="tertiary" numberOfLines={1}>
          run {runId}
        </Text>
        <View style={styles.actions}>
          <Button label="Approve" onPress={() => decide(true)} disabled={busy} style={styles.button} />
          <Button
            label="Deny"
            variant="destructive"
            onPress={() => decide(false)}
            disabled={busy}
            style={styles.button}
          />
        </View>
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  button: {
    flex: 1,
  },
});
```

The duration used in `withTiming` and `setTimeout` **must** come from `approvalExitDuration('approving')` / `approvalExitDuration('denying')` / `approvalExitDuration(next)` — do not write `280` or `320` in this file.

- [ ] **Step 2: Wire Activity**

In `src/app/(tabs)/activity.tsx`:

- Import `ApprovalDecisionCard`.
- Delete `decide`.
- Replace the `{pendingRunApproval ? ( <Card>… </Card> ) : null}` block with:

```tsx
{pendingRunApproval ? (
  <ApprovalDecisionCard
    runId={pendingRunApproval.runId}
    prompt={pendingRunApproval.prompt}
    onResolve={(approved) => resolveRunApproval(approved)}
  />
) : null}
```

- Remove now-unused `approvalCard`, `approvalHeader`, `approvalEyebrow`, `approvalActions`, `approvalButton` styles if nothing else references them. Keep `approvalEyebrow` if the start-run card still uses `styles.approvalEyebrow` (it does — leave that one).

- [ ] **Step 3: Fix Chat sheet haptics**

In `src/components/chat/approval-sheet.tsx`:

- Replace `import * as Haptics from 'expo-haptics'` with `import { haptics } from '@/lib/haptics'`.
- Deny button `onPress`:

```tsx
onPress={async () => {
  await haptics.warning();
  onDeny(feedback.trim() || undefined);
}}
```

- Approve button `onPress`:

```tsx
onPress={async () => {
  await haptics.success();
  onApprove(feedback.trim() || undefined);
}}
```

Do not add delay, shrink, or red-edge on the sheet. Resolve immediately.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/activity/approval-decision-card.tsx src/app/(tabs)/activity.tsx src/components/chat/approval-sheet.tsx
git commit -m "feat: choreograph activity approval and fix sheet haptics"
```

---

### Task 6: Reanimated ambient fallback + Screen parallax plumbing

Do this **before** adding Skia so web and the native fallback keep working if the Skia install is delayed.

**Files:**
- Create: `src/components/layout/ambient-fallback.tsx`
- Create: `src/components/layout/AmbientCanvas.web.tsx`
- Modify: `src/components/layout/AmbientCanvas.tsx`
- Modify: `src/components/ui/types.ts`
- Modify: `src/components/ui/Screen.tsx`
- Modify: `src/app/(tabs)/index.tsx`
- Modify: `src/app/(tabs)/activity.tsx`
- Modify: `src/components/chat/chat-screen.tsx`
- Modify: `src/components/terminal/terminal-screen.tsx`

**Interfaces:**
- Consumes: `mapAmbientParallax` / `useAmbientParallaxScroll` from Task 1; `AmbientCanvasProps` `{ parallaxX?: number; parallaxY?: number }`
- Produces: fallback canvas that offsets plates/orbs by `parallaxY * 8` px; `Screen` forwards the props

- [ ] **Step 1: Move today’s canvas into the fallback and honor parallax**

Create `src/components/layout/ambient-fallback.tsx` by copying `AmbientCanvas.tsx` and:

1. Rename the export to `AmbientFallback`.
2. Accept `AmbientCanvasProps`:

```ts
export type AmbientCanvasProps = {
  parallaxX?: number;
  parallaxY?: number;
};
```

3. After computing tokens, derive:

```ts
const shiftY = (parallaxY ?? 0) * 8;
const shiftX = (parallaxX ?? 0) * 8;
```

4. Wrap the two plates, two gold rules, and both `GlowOrb`s in a `View` (or apply to each) with

```ts
style={{ transform: [{ translateX: shiftX }, { translateY: shiftY }] }}
```

Do **not** parallax the grain `Image` or the vignettes — grain stays locked to the screen so it reads as film, not a sliding sticker.

Keep the existing `GlowOrb` drift (52s / 68s) unchanged.

- [ ] **Step 2: Point the current and web entry files at the fallback**

`src/components/layout/AmbientCanvas.tsx` becomes:

```ts
export { AmbientFallback as AmbientCanvas } from './ambient-fallback';
export type { AmbientCanvasProps } from './ambient-fallback';
```

`src/components/layout/AmbientCanvas.web.tsx`:

```ts
export { AmbientFallback as AmbientCanvas } from './ambient-fallback';
```

Do not create `AmbientCanvas.native.tsx` yet — Metro will keep using `AmbientCanvas.tsx` on Android until Task 7.

- [ ] **Step 3: Forward parallax through `Screen`**

In `src/components/ui/types.ts`, extend `ScreenProps`:

```ts
export type ScreenProps = {
  children: ReactNode;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  style?: StyleProp<ViewStyle>;
  /** Layered ambient blooms; disable on dense inset panes (e.g. terminal). */
  ambient?: boolean;
  parallaxX?: number;
  parallaxY?: number;
};
```

In `src/components/ui/Screen.tsx`:

```tsx
export function Screen({
  children,
  edges = ['top', 'bottom'],
  style,
  ambient = true,
  parallaxX,
  parallaxY,
}: ScreenProps) {
  const tokens = useTokens();

  return (
    <View style={[styles.root, { backgroundColor: tokens.background }]}>
      {ambient ? <AmbientCanvas parallaxX={parallaxX} parallaxY={parallaxY} /> : null}
      <SafeAreaView style={[styles.safe, style]} edges={edges}>
        {children}
      </SafeAreaView>
    </View>
  );
}
```

- [ ] **Step 4: Drive parallax from the four scrolling surfaces**

**Home** (`src/app/(tabs)/index.tsx`):

```tsx
const { parallaxY, onScroll } = useAmbientParallaxScroll();
// <Screen edges={['bottom']} parallaxY={parallaxY}>
// <ScrollView onScroll={onScroll} scrollEventThrottle={16} ...>
```

**Activity** (`src/app/(tabs)/activity.tsx`): same pattern on its `Screen` + `ScrollView`.

**Chat** (`src/components/chat/chat-screen.tsx`):

```tsx
const { parallaxY, onScroll } = useAmbientParallaxScroll();
```

Change the existing `handleScroll` to call `onScroll(event)` first, then keep the pin/jump logic. Pass `parallaxY` to `<Screen edges={['bottom']} parallaxY={parallaxY}>`. Add `scrollEventThrottle={16}` on the `FlatList` (it already has `scrollEventThrottle={80}` — change that to `16`).

**Tools** (`src/components/terminal/terminal-screen.tsx`):

- `const { parallaxY, onScroll } = useAmbientParallaxScroll();`
- Pass `parallaxY` to both `Screen` returns that wrap the live tools UI (not the disconnected `ChatEmptyState`).
- On the shell `TerminalOutput` `FlatList` (`src/components/terminal/terminal-output.tsx`), add optional `onScroll` / `scrollEventThrottle={16}` props and forward them to the `FlatList`. `TerminalScreen` passes `onScroll`.
- For RPC/agent mode, wrap `styles.commandContent` in a `ScrollView` with `onScroll={onScroll}` and `scrollEventThrottle={16}`.

Onboarding is not touched.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/ambient-fallback.tsx src/components/layout/AmbientCanvas.tsx src/components/layout/AmbientCanvas.web.tsx src/components/ui/types.ts src/components/ui/Screen.tsx src/app/(tabs)/index.tsx src/app/(tabs)/activity.tsx src/components/chat/chat-screen.tsx src/components/terminal/terminal-screen.tsx src/components/terminal/terminal-output.tsx
git commit -m "feat: ambient parallax plumbing on scrolling screens"
```

---

### Task 7: Skia native ambient canvas

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npx expo install`)
- Create: `src/components/layout/AmbientCanvas.native.tsx`

**Interfaces:**
- Consumes: `AmbientCanvasProps` from `ambient-fallback.tsx`; `AmbientFallback` as the mount-failure fallback
- Produces: native-only Skia aurora + grain `ImageShader`; sightline Views stay RN

- [ ] **Step 1: Read the Expo 57 Skia page and install the pinned version**

Read: https://docs.expo.dev/versions/v57.0.0/sdk/skia/

Run (from `C:\Projects\Versutus`):

```bash
npx expo install @shopify/react-native-skia
```

Do not add a web CanvasKit plugin. Do not follow the Skia-on-web install.

- [ ] **Step 2: Confirm the package is not imported on web**

After Step 3, this must hold:

```bash
# AmbientCanvas.web.tsx and ambient-fallback.tsx must not mention the package
```

Search those two files for `@shopify/react-native-skia`. Expected: no matches.

- [ ] **Step 3: Native canvas**

Create `src/components/layout/AmbientCanvas.native.tsx`.

Requirements (implement exactly this structure):

```tsx
import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Fill, Group, ImageShader, RadialGradient, Rect, useImage, vec } from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTokens } from '@/hooks/use-tokens';

import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';

const GOLD = 'rgba(240, 214, 144, 0.12)';
const SAPPHIRE = 'rgba(59, 111, 217, 0.12)';
const DRIFT = Easing.inOut(Easing.sin);

class SkiaAmbientBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function AmbientCanvas({ parallaxX = 0, parallaxY = 0 }: AmbientCanvasProps) {
  const tokens = useTokens();
  const grain = useImage(require('../../../assets/images/grain.png'));
  const driftA = useSharedValue(0);
  const driftB = useSharedValue(0);

  useEffect(() => {
    driftA.value = withRepeat(withTiming(1, { duration: 52_000, easing: DRIFT }), -1, true);
    driftB.value = withRepeat(withTiming(1, { duration: 68_000, easing: DRIFT }), -1, true);
    return () => {
      cancelAnimation(driftA);
      cancelAnimation(driftB);
    };
  }, [driftA, driftB]);

  const goldTransform = useDerivedValue(() => [
    { translateX: -0.15 * 400 + driftA.value * 40 + parallaxX * 8 },
    { translateY: -0.22 * 400 + driftA.value * 60 + parallaxY * 8 },
  ]);
  const sapphireTransform = useDerivedValue(() => [
    { translateX: 0.58 * 400 + driftB.value * -48 + parallaxX * 8 },
    { translateY: 0.62 * 400 + driftB.value * -34 + parallaxY * 8 },
  ]);

  const fallback = <AmbientFallback parallaxX={parallaxX} parallaxY={parallaxY} />;

  return (
    <SkiaAmbientBoundary fallback={fallback}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Group transform={goldTransform}>
            <Rect x={0} y={0} width={420} height={420}>
              <RadialGradient c={vec(210, 210)} r={210} colors={[GOLD, 'transparent']} />
            </Rect>
          </Group>
          <Group transform={sapphireTransform}>
            <Rect x={0} y={0} width={300} height={300}>
              <RadialGradient c={vec(150, 150)} r={150} colors={[SAPPHIRE, 'transparent']} />
            </Rect>
          </Group>
          {grain ? (
            <Fill opacity={0.16}>
              <ImageShader image={grain} fit="repeat" rect={{ x: 0, y: 0, width: 256, height: 256 }} />
            </Fill>
          ) : null}
        </Canvas>
        {/* Sightlines — same Views as the fallback (plates, rules, vignette, center line). Copy those styles from ambient-fallback.tsx. Do not parallax them independently of the fallback (the fallback already shifts plates; keep native plates still so architecture stays locked and only the paint drifts). */}
      </View>
    </SkiaAmbientBoundary>
  );
}
```

Copy the sightline `View`s and their `StyleSheet` entries from `ambient-fallback.tsx` (plates, gold rules, vignettes, center line) into this file. They stay React Native, `pointerEvents="none"`, no parallax on the native sightlines — only the Skia paint + the fallback path take parallax.

If Skia’s `ImageShader` `rect` / `fit="repeat"` types disagree with the pinned version, adjust to the types in `node_modules/@shopify/react-native-skia` after install. Do not invent a second grain strategy. Do not use a Skia clock.

- [ ] **Step 4: Typecheck and prove web does not import Skia**

Run:

```bash
npx tsc --noEmit
```

Then search `src/components/layout/AmbientCanvas.web.tsx` and `src/components/layout/ambient-fallback.tsx` for `@shopify/react-native-skia`. Expected: no hits. The only Skia import in `src/` is `AmbientCanvas.native.tsx`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/components/layout/AmbientCanvas.native.tsx
git commit -m "feat: skia aurora and grain on native ambient canvas"
```

- [ ] **Step 6: Local Android rebuild (manual)**

EAS cloud builds are quota-blocked until 2026-09-01. Rebuild locally:

```bash
# JAVA_HOME and ANDROID_HOME as in docs/2026-08-11-session-handoff.md §4
npx expo prebuild --platform android
cd android && ./gradlew.bat assembleRelease --no-daemon
```

Uninstall the existing app before installing the new APK if the signing key differs from what is on the phone.

This step is recorded as done only when the APK is installed and the 2-minute walkthrough in Task 8 has been run on device.

---

### Task 8: Full verify

**Files:** none new

- [ ] **Step 1: Run the repo gate**

```bash
npm run verify
```

Expected: `tsc` clean, lint exit 0, all Jest suites pass (including the three new ones), 390 gate tests still pass.

- [ ] **Step 2: Confirm the web graph cannot load Skia**

Search `src/components/layout/AmbientCanvas.web.tsx` and `src/components/layout/ambient-fallback.tsx` for `@shopify/react-native-skia`. Expected: no matches.

Optional: `npx expo start --web --port 8083` and load `/`, `/chat`, `/activity`, `/terminal`. Expected: Metro bundles with no Skia/web error. SSR may only show the splash shell — that is not a failure.

- [ ] **Step 3: Device walkthrough (after Task 7 Step 6)**

On the Android install:

1. Home and Chat — scroll; aurora drifts and shifts a few px (parallax).
2. Chat overflow — token/cost meters + 7-point sparkline + `Last 7 days · from recent sessions`.
3. Activity — approve a run (card shrinks/fades, then resolves); deny a run (red edge, then resolves). Chat approval sheet still closes immediately.

- [ ] **Step 4: Commit only if Step 1 produced extra fixes**

If verify required code fixes, commit those fixes. If verify was clean, there is nothing to commit.

---

## Self-review

**Spec coverage**

| Spec item | Task |
|---|---|
| `mapAmbientParallax` clamp / NaN / parallaxX=0 | Task 1 |
| `sessionUsage` / `weekBuckets` / `relativeMeter` | Task 2 |
| `nextApprovalExit` / durations 0/280/320 | Task 3 |
| Overflow meters + SVG sparkline + honest caption | Task 4 |
| Activity card choreography, resolve after motion, double-tap lock | Task 5 |
| Chat sheet haptic pairing only | Task 5 |
| Fallback module + web re-export + Screen parallax + four surfaces | Task 6 |
| Skia native canvas, Reanimated drift, grain ImageShader, error fallback | Task 7 |
| No Skia on web; `npm run verify`; Android rebuild | Task 7–8 |
| Provider untouched | All tasks omit `gateway-provider.tsx` |

**Not in this plan (spec non-goals):** Skia-on-web, weekly API, Home sparkline, audio, Screen scroll context, onboarding parallax, light theme.

**Type names** used later match Tasks 1–3: `AmbientCanvasProps`, `SessionUsageInput`, `ApprovalExit`, `mapAmbientParallax`, `useAmbientParallaxScroll`, `approvalExitDuration`.
