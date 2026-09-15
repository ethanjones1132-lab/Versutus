/**
 * The routine arc's own copy — a pure fold beside the model, one file.
 *
 * The drawer's arc renderer answered `{arc.botId ? health.label : health.label}`
 * — the two branches were the SAME expression, so an attributed arc and a
 * gateway-owned arc rendered identically and no arc ever named the Bot it
 * hangs beneath. `routineArcLabel` answers the Bot's own name concatenated
 * with the health label for an attributed arc, and the health label alone for
 * a gateway-owned one; for a warn/error arc without a boundary a second micro
 * line carries `verdict.detail` — never invented, dropped when the verdict
 * carries none.
 */

import {
  routineArcLabel,
  routineArcDetail,
} from '@/lib/fleet/routine-arc-copy';

describe('routine arc copy', () => {
  it('an attributed arc answers the Bot name joined to the health label', () => {
    const label = routineArcLabel({
      botName: 'Scout',
      verdict: { tone: 'ok', label: 'ok' },
    });
    expect(label).toBe('Scout · ok');
  });

  it('a gateway-owned arc answers the health label alone', () => {
    const label = routineArcLabel({
      botName: undefined,
      verdict: { tone: 'ok', label: 'ok' },
    });
    expect(label).toBe('ok');
  });

  it('a verdict without a Bot it can name reads as the label alone', () => {
    // An attributed arc with no roster name in hand cannot invent one —
    // the honest answer is the gateway-owned line.
    expect(
      routineArcLabel({
        botName: '',
        verdict: { tone: 'warn', label: 'Cooling down' },
      }),
    ).toBe('Cooling down');
  });

  it('the detail line answers the verdict detail only when warn or error carries one', () => {
    // A warn with a detail says it; ok/off/unknown never do.
    expect(
      routineArcDetail({
        verdict: { tone: 'warn', label: 'Cooling down', detail: 'rate limited' },
      }),
    ).toBe('rate limited');
    expect(
      routineArcDetail({
        verdict: { tone: 'error', label: 'Last run failed', detail: 'timeout' },
      }),
    ).toBe('timeout');
    expect(
      routineArcDetail({ verdict: { tone: 'ok', label: 'ok', detail: 'noise' } }),
    ).toBeUndefined();
    expect(
      routineArcDetail({ verdict: { tone: 'error', label: 'Last run failed' } }),
    ).toBeUndefined();
  });
});
