// ─── A TLS gateway is not necessarily on Tailscale ───────────────────────────
// The saved-gateway row used to label every wss:// address "Tailscale/TLS",
// claiming a private network the gateway may not be on. The label now names
// the transport (TLS) and reserves Tailscale for a gateway discovered there.

// The design tokens import Easing from reanimated; the real module pulls in
// react-native-worklets, whose native unpackers do not exist under jest.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => {
  const React = require('react');
  const stub = (name: string) => {
    function Stub(props: Record<string, unknown>) {
      return React.createElement(name, props);
    }
    return Stub;
  };
  return {
    Button: stub('Button'),
    Card: stub('Card'),
    EmptyState: stub('EmptyState'),
    PressableScale: stub('PressableScale'),
    Text: stub('Text'),
  };
});

jest.mock('@/components/connection-badge', () => ({ ConnectionBadge: 'ConnectionBadge' }));

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => (key === 'then' ? undefined : '#000000'),
      },
    ),
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import type { GatewayProfile } from '@/lib/gateway/types';

function collectText(root: ReactTestRenderer['root']): string {
  return root
    .findAll(() => true)
    .flatMap((node) => {
      const children = node.props?.children;
      if (typeof children === 'string' || typeof children === 'number') return [String(children)];
      if (Array.isArray(children)) {
        return children
          .filter((child) => typeof child === 'string' || typeof child === 'number')
          .map(String);
      }
      return [];
    })
    .join('\n');
}

async function renderRow(gateway: GatewayProfile): Promise<string> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(CompactGatewayList, {
        gateways: [gateway],
        status: 'disconnected',
        reachability: {},
        onSelect: () => undefined,
        onDelete: () => undefined,
      }),
    );
  });
  const text = collectText(renderer.root);
  renderer.unmount();
  return text;
}

function gateway(patch: Partial<GatewayProfile>): GatewayProfile {
  return {
    id: 'gw',
    name: 'Gateway',
    url: 'ws://192.168.1.5:8642',
    createdAt: 1,
    ...patch,
  };
}

test('a wss:// gateway outside Tailscale is labelled TLS, not Tailscale', async () => {
  const text = await renderRow(
    gateway({ url: 'wss://gateway.example.com', discoverySource: 'wide-area' }),
  );
  expect(text).toContain('TLS');
  expect(text).not.toContain('Tailscale');
  expect(text).not.toContain('Private network');
});

test('only a gateway discovered on Tailscale is labelled Tailscale', async () => {
  const text = await renderRow(
    gateway({ url: 'wss://gateway.tailnet.ts.net', discoverySource: 'tailscale' }),
  );
  expect(text).toContain('Tailscale');
});

test('a plain local gateway keeps its discovery label', async () => {
  const text = await renderRow(gateway({ url: 'ws://192.168.1.5:8642', discoverySource: 'local' }));
  expect(text).toContain('local');
  expect(text).not.toContain('TLS');
});
