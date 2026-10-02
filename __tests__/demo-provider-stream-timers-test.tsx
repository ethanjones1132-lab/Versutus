import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { DemoGatewayProvider } from '@/context/demo-gateway-provider';
import {
  useChatSurface,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import type { ChatMessage } from '@/lib/gateway/types';

// Round-4 scan (R4S-p3b), the showcase fleet: the ~650 ms think beat is a timer
// too, so it must serialize a second send (DEMO-2) and be cancellable by Stop
// (DEMO-1).

jest.mock('@/lib/bot-avatar', () => ({ registerCrestFleet: jest.fn() }));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/**
 * The newest committed transcript and the provider surface, captured through a
 * consumer that re-renders on every provider commit so the assertion reads
 * settled state, not the props closure of the render that scheduled the change.
 */
let latestMessages: ChatMessage[] = [];

function recordContexts(gateway: GatewayContextValue, chat: ReturnType<typeof useChatSurface>): null {
  latestMessages = chat.messages;
  captured.sendChatInput = gateway.sendChatInput;
  captured.stopStreaming = gateway.stopStreaming;
  return null;
}

function Capture(): null {
  return recordContexts(useGateway(), useChatSurface());
}

const captured: {
  sendChatInput?: GatewayContextValue['sendChatInput'];
  stopStreaming?: GatewayContextValue['stopStreaming'];
} = {};

function api() {
  if (!captured.sendChatInput || !captured.stopStreaming) {
    throw new Error('the demo provider has not mounted');
  }
  return captured as {
    sendChatInput: GatewayContextValue['sendChatInput'];
    stopStreaming: GatewayContextValue['stopStreaming'];
  };
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <DemoGatewayProvider>
        <Capture />
      </DemoGatewayProvider>,
    );
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  latestMessages = [];
  delete captured.sendChatInput;
  delete captured.stopStreaming;
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a second send during the think beat', () => {
  test('is refused, so one interval owns the reply', async () => {
    await mount();

    let first: string | undefined;
    await act(async () => {
      first = await api().sendChatInput('alpha');
    });
    expect(first).toBe('sent');

    let second: string | undefined;
    await act(async () => {
      second = await api().sendChatInput('beta');
    });
    // While the beat is pending there is no interval yet; without the beat in
    // the busy guard the second send started a rival reply (DEMO-2).
    expect(second).toBe('busy');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    expect(latestMessages.filter((message) => message.text === 'beta')).toEqual([]);
    expect(latestMessages.filter((message) => message.text === 'alpha')).toHaveLength(1);
  });
});

describe('Stop during the think beat', () => {
  test('cancels the pending reply instead of letting it stream after Stop', async () => {
    await mount();

    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = api().sendChatInput('hi');
    });
    const reply = latestMessages.find((message) => message.id.startsWith('showcase-reply-'));
    expect(reply).toBeDefined();

    await act(async () => {
      await api().stopStreaming();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await pending;
    });

    // The untouched timeout used to fire after Stop and grow the bubble even
    // though the operator had settled it (DEMO-1).
    const settled = latestMessages.find((message) => message.id === reply?.id);
    expect(settled?.text ?? '').toBe('');
    expect(settled?.streaming).toBe(false);
  });
});
