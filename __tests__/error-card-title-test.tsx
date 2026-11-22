/**
 * VS-138 — a known-and-fixable failure is its own headline.
 *
 * An operator told only "Something went wrong" over a backend they are signed
 * out of reads it as a network fault: the one sentence that fixes it (sign in
 * on the PC) never reaches them. These render the real ErrorCard, fed the way
 * the call sites feed it, and pin the eyebrow: the humanizer's verdict for the
 * two fixable failures, and the generic eyebrow for everything else.
 */
import { createElement } from 'react';

// The kit primitives ErrorCard composes: host components that keep their props
// and children verbatim, so the rendered text is the card's own output.
jest.mock('@/components/ui/Button', () => ({ Button: 'Button' }));
jest.mock('@/components/ui/Card', () => ({ Card: 'Card' }));
jest.mock('@/components/ui/Icon', () => ({ Icon: 'Icon' }));
jest.mock('@/components/ui/Text', () => ({ Text: 'Text' }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    statusDisconnected: '#f44',
    textPrimary: '#fff',
    textSecondary: '#aaa',
    textTertiary: '#777',
  }),
}));
// tokens.ts imports reanimated's Easing; its native worklets cannot load here.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ErrorCard } from '@/components/ui/ErrorCard';
import { GatewayHttpError } from '@/lib/gateway/errors';
import { humanizeGatewayError } from '@/lib/gateway/error-humanizer';

let renderer: ReactTestRenderer;

/** The text of one rendered node, its children joined the way they read. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'children' in node) {
    return textOf((node as { children: unknown }).children);
  }
  return '';
}

/** Every string rendered under the (host) Text primitive, one per Text node. */
function shown(): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .map((text) => textOf((text.props as { children?: unknown }).children));
}

async function mount(props: Parameters<typeof ErrorCard>[0]): Promise<void> {
  if (renderer) {
    const previous = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      previous.unmount();
    });
  }
  await act(async () => {
    renderer = create(createElement(ErrorCard, props));
  });
}

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
});

/** A failure the operator can fix from the sentence alone, as the Gate words it. */
const SIGNED_OUT_MESSAGE =
  'Codex on your PC is signed out. Open a terminal on the PC, run `codex login`, and sign in.';
const QUOTA_MESSAGE =
  "Codex has used up its plan's limit. It resets at 14:00; until then pick another backend.";

describe('ErrorCard title', () => {
  test('renders a supplied title as the eyebrow', async () => {
    await mount({ title: 'Disk is full', cause: 'No space left on the device.' });
    expect(shown()).toContain('Disk is full');
    expect(shown()).not.toContain('Something went wrong');
  });

  test('keeps the generic eyebrow when no title is supplied', async () => {
    await mount({ cause: 'No space left on the device.' });
    expect(shown()).toContain('Something went wrong');
    // The structured rows are untouched: cause, and the detail when given.
    expect(shown()).toContain('Cause: No space left on the device.');
  });
});

describe('a fixable failure reaches the card as its own headline', () => {
  test('a signed-out backend says to sign in on your computer', async () => {
    // The dashboard spreads the humanizer's verdict; the chat banner receives
    // only the message. Both shapes must reach the same eyebrow.
    for (const error of [
      new Error(SIGNED_OUT_MESSAGE),
      new GatewayHttpError('the backend refused', 502, 'backend_signed_out'),
    ]) {
      const card = { ...humanizeGatewayError(error) };
      await mount(card);
      expect(shown()).toContain('Sign in on your computer');
      expect(shown()).not.toContain('Something went wrong');
    }
  });

  test('a spent backend plan says to switch backend or wait', async () => {
    for (const error of [
      new Error(QUOTA_MESSAGE),
      new GatewayHttpError('the backend refused', 429, 'backend_quota'),
    ]) {
      const card = { ...humanizeGatewayError(error) };
      await mount(card);
      expect(shown()).toContain('Switch backend or wait');
      expect(shown()).not.toContain('Something went wrong');
    }
  });

  test('a genuinely unknown failure keeps the generic card and its rows', async () => {
    await mount({ ...humanizeGatewayError(new Error('the sprocket sheared off')) });
    const text = shown();
    expect(text).toContain('Something went wrong');
    expect(text).toContain('Cause: the sprocket sheared off');
    expect(text).toContain('Affected: gateway connection');
    expect(text).toContain('Next: Check the details below and try again.');
  });
});
