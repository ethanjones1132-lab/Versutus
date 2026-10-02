// ─── The banner says a turn died ────────────────────────────────────────────
// A Gate turn can fail while the call stays up: the Gate speaks its own failure
// line and reopens listening. Before, the fold recorded the failure and nothing
// drew it, so the operator watched "Sending" for a reply that was never coming
// and had no way to tell that from a slow turn. The line rides the elements the
// banner already has — no new design.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { HandsfreeCallBanner } from '@/components/voice/handsfree-call-banner';
import { useHandsfreeVoice } from '@/context/handsfree-voice-provider';
import { handsfreeTurnFailureCopy } from '@/lib/voice/handsfree-call-copy';

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));
jest.mock('@/context/handsfree-voice-provider', () => ({ useHandsfreeVoice: jest.fn() }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accentWarmMuted: '#fff', accent: '#fff', border: '#fff', statusDisconnected: '#fff' }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@/components/ui', () => ({
  GlassSurface: 'GlassSurface',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('@/components/voice/handsfree-call-indicator', () => ({
  HandsfreeCallIndicator: 'HandsfreeCallIndicator',
}));

function mockVoice(turnError: string | null, phase: 'sending' | 'listening' = 'sending') {
  jest.mocked(useHandsfreeVoice).mockReturnValue({
    active: true,
    phase,
    partial: '',
    label: 'Test Bot',
    level: { value: 0 } as never,
    engine: 'local',
    engineReason: undefined,
    muted: false,
    turnError,
    turnState: turnError ? 'failed' : null,
    mute: jest.fn(),
    unmute: jest.fn(),
    skipReply: jest.fn(),
    end: jest.fn(),
    startedAtMs: undefined,
    sendingSinceMs: null,
  } as never);
}

/** Every string the banner drew, flattened. */
function drawn(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const children = (node as { children?: unknown }).children;
      if (children) walk(children);
    }
  };
  walk(renderer.toJSON());
  return out;
}

async function render(turnError: string | null): Promise<ReactTestRenderer> {
  mockVoice(turnError);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(HandsfreeCallBanner));
  });
  return renderer;
}

describe('a failed Gate turn on the banner', () => {
  test('the failure line is drawn once, with the Gate’s own reason', async () => {
    const renderer = await render('the PC could not answer');
    const copy = handsfreeTurnFailureCopy('the PC could not answer');
    expect(copy).toBe('That turn could not be completed the PC could not answer');
    expect(drawn(renderer)).toContain(copy);
    // No new element type: it rides the banner's existing micro line.
    expect(JSON.stringify(renderer.toJSON())).toContain('micro');
    await act(async () => {
      renderer.unmount();
    });
  });

  test('no failure, no line — a slow turn still reads as a slow turn', async () => {
    const renderer = await render(null);
    expect(drawn(renderer)).not.toContain(handsfreeTurnFailureCopy('anything'));
    expect(drawn(renderer).join(' ')).not.toMatch(/could not be completed/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('the line folds away with the next turn', async () => {
    const renderer = await render('backend_error');
    expect(drawn(renderer).join(' ')).toMatch(/could not be completed/);
    await act(async () => {
      mockVoice(null, 'listening');
      renderer.update(createElement(HandsfreeCallBanner));
    });
    expect(drawn(renderer).join(' ')).not.toMatch(/could not be completed/);
    await act(async () => {
      renderer.unmount();
    });
  });
});