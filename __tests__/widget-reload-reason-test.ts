// The connection-edge slice of FUTURE-ITEMS.md §4: a status flip the provider
// already knows about re-arms the widget's own cadence, so a connect that
// happened while the app process was backgrounded is re-armed the moment the
// operator returns. The pure flip table is exercised directly; the seam's
// reload half and the provider's wiring (not a component any test renders) are
// pinned as source, the way `widget-target-test.ts` pins theirs.
//
// The four cases live here rather than beside the seam's suite only for the
// flip table — the seam and the provider pins are ALSO held in
// `__tests__/widget-target-test.ts`, which the item names; this file is the
// pure module's own suite.

import { widgetReloadReason } from '@/lib/widget/reload-reason';

describe('widgetReloadReason', () => {
  test('a status flip is the snapshot edge, and everything else is none', () => {
    // Any flip between two known statuses IS a connection edge the app
    // already knows about — the snapshot write that rides the same effect
    // repaints the widget's content, and the reload re-arms its cadence.
    expect(widgetReloadReason('connected', 'disconnected')).toBe('snapshot');
    expect(widgetReloadReason('pairing', 'connected')).toBe('snapshot');
    expect(widgetReloadReason('disconnecting' as never, 'connected')).toBe('snapshot');
    expect(widgetReloadReason('connected', 'connected')).toBe('none');
    expect(widgetReloadReason('disconnected', 'disconnected')).toBe('none');
  });

  test('a status with no predecessor (first render) is not a flip', () => {
    // The provider's ref starts empty; a first run of the effect observed no
    // edge and must not reload on its own mount.
    expect(widgetReloadReason('connected', null)).toBe('none');
  });
});

describe('the reload seam and the provider edge, as source', () => {
  const SEP = process.cwd().includes('\\') ? '\\' : '/';
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  const readSource = (...parts: string[]): string =>
    nodeFs
      .readFileSync([process.cwd(), ...parts].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');

  test('the seam exports reloadWidgetSnapshot beside writeWidgetSnapshot with the same swallow', () => {
    const seam = readSource('src', 'lib', 'widget', 'widget-device.ts');
    expect(seam).toContain('export async function reloadWidgetSnapshot(');
    // The same load-injectable shape the write takes.
    expect(seam).toMatch(/reloadWidgetSnapshot\(\s*load: \(\) => Promise<WidgetTarget>/);
    // The swallow-mirror: the widget's refusal is not the app's failure.
    expect(seam).toMatch(/function reloadWidgetSnapshot[\s\S]*try \{[\s\S]*\} catch \{/);
  });

  test('the provider calls the seam only on a flip, and the write stays driven by its facts', () => {
    const provider = (): string => readSource('src', 'context', 'gateway-provider.tsx');
    expect(provider()).toContain(
      "import { reloadWidgetSnapshot, writeWidgetSnapshot } from '@/lib/widget/widget-device';",
    );
    expect(provider()).toContain("import { widgetReloadReason } from '@/lib/widget/reload-reason';");
    // Reload rides the same effect and the same facts — one dependency list,
    // still no poller of our own. The write itself is gated on the fold's own
    // signature: an equal snapshot (a poll-cycle patch to a run row that moved
    // no fact the widget renders) is skipped, and the equal-snapshot slice
    // (__tests__/widget-target-test.ts) pins that shape.
    expect(provider()).toMatch(
      /const snapshot = glanceableSnapshot\(\{ status, runs: activityRuns, routines: routineJobs \}\);\s*\n\s*const signature = snapshotSignature\(snapshot\);[\s\S]*?\n  \}, \[activityRuns, routineJobs, status\]\);/,
    );
    // The flip is what gates the reload, not the write: a result landing with
    // the status unchanged must not reload.
    expect(provider()).toContain(
      "widgetReloadReason(status, prevWidgetStatusRef.current) === 'snapshot'",
    );
    expect(provider()).toContain('prevWidgetStatusRef.current = status;');
  });
});
