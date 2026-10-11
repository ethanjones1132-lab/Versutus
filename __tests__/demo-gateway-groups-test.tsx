import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { DemoGatewayProvider } from '@/context/demo-gateway-provider';
import { useGateway, type GatewayContextValue } from '@/context/gateway-provider';

// Round-5 scan, the showcase fleet's group rooms: each group mutator must answer
// with the room it was called on. The shipped fleet has one room, so the
// first-room fallback hides the bug; this file adds a second room to show it.

jest.mock('@/lib/bot-avatar', () => ({ registerCrestFleet: jest.fn() }));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/lib/demo/showcase-fleet', () => {
  const actual = jest.requireActual<typeof import('@/lib/demo/showcase-fleet')>('@/lib/demo/showcase-fleet');
  return {
    ...actual,
    SHOWCASE_GROUPS: [
      ...actual.SHOWCASE_GROUPS,
      { id: 'ship-crew', name: 'Ship Crew', memberIds: ['forge', 'ledger'] },
    ],
  };
});

const captured: { botGroups?: GatewayContextValue['botGroups'] } = {};

function recordContexts(gateway: GatewayContextValue): null {
  captured.botGroups = gateway.botGroups;
  return null;
}

function Capture(): null {
  return recordContexts(useGateway());
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

async function mount(): Promise<GatewayContextValue['botGroups']> {
  await act(async () => {
    renderer = TestRenderer.create(
      <DemoGatewayProvider>
        <Capture />
      </DemoGatewayProvider>,
    );
  });
  if (!captured.botGroups) throw new Error('the demo provider has not mounted');
  return captured.botGroups;
}

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  delete captured.botGroups;
});

describe('a group mutator answers for the room it was called on', () => {
  test('rename returns the second room with its own roster and the new name', async () => {
    const groups = await mount();
    await expect(groups.rename('ship-crew', 'Ship Crew 2')).resolves.toEqual({
      id: 'ship-crew',
      name: 'Ship Crew 2',
      memberIds: ['forge', 'ledger'],
    });
  });

  test('addMembers appends to the second room and skips a member already in it', async () => {
    const groups = await mount();
    await expect(groups.addMembers('ship-crew', ['aria', 'forge'])).resolves.toEqual({
      id: 'ship-crew',
      name: 'Ship Crew',
      memberIds: ['forge', 'ledger', 'aria'],
    });
  });

  test('leave removes the named member from the second room only', async () => {
    const groups = await mount();
    await expect(groups.leave('ship-crew', 'forge')).resolves.toEqual({
      id: 'ship-crew',
      name: 'Ship Crew',
      memberIds: ['ledger'],
    });
  });

  test('the first room still answers with its own roster', async () => {
    const groups = await mount();
    await expect(groups.leave('launch-council', 'aria')).resolves.toEqual({
      id: 'launch-council',
      name: 'Launch Council',
      memberIds: ['forge', 'ledger'],
    });
  });
});
