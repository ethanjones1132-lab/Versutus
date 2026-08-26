jest.mock('@/lib/gateway/device-auth-token', () => ({
  loadDeviceAuthToken: jest.fn(),
  saveDeviceAuthToken: jest.fn(() => Promise.resolve()),
  clearDeviceAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(() =>
    Promise.resolve({
      deviceId: 'device-1',
      publicKeyB64Url: 'public-key',
      privateKeyB64Url: 'private-key',
      createdAtMs: 0,
    }),
  ),
  signDevicePayload: jest.fn(() => Promise.resolve('signature')),
}));

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { OpenClawAdapterClient } from '@/lib/portal/openclaw-adapter';
import { openClawCreateSessionParams } from '@/lib/portal/openclaw-mapping';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'OpenClaw gateway',
  url: 'ws://gateway.test:18789/openclaw',
  kind: 'openclaw',
  token: 'k',
  createdAt: 0,
};

describe('openClawCreateSessionParams', () => {
  test('a picked model is a string on the wire, not a Gate-shaped object', () => {
    // OpenClaw sessions.create takes optional `model` as a string. The Gate
    // posts `{ model: { modelId } }`; sending that here is an unknown param.
    expect(openClawCreateSessionParams({
      title: 'scratch',
      model: 'anthropic/claude-sonnet-4-5',
    })).toEqual({
      title: 'scratch',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  test('a session opened without a model omits the field', () => {
    expect(openClawCreateSessionParams({ title: 'scratch' })).toEqual({ title: 'scratch' });
    expect(openClawCreateSessionParams({})).toEqual({});
    expect(openClawCreateSessionParams({ title: '', model: '' })).toEqual({});
  });
});

describe('OpenClawAdapterClient createSession', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a session opened with a model sends that model on sessions.create', async () => {
    const request = jest.spyOn(OpenClawGatewayClient.prototype, 'request').mockResolvedValue({
      id: 'oc_new',
      title: 'scratch',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const client = new OpenClawAdapterClient(PROFILE, {});
    const created = await client.createSession('scratch', 'anthropic/claude-sonnet-4-5');

    expect(request).toHaveBeenCalledWith('sessions.create', {
      title: 'scratch',
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(created.id).toBe('oc_new');
    expect(created.model).toBe('anthropic/claude-sonnet-4-5');
    client.disconnect();
  });

  test('a session opened without a model does not send one', async () => {
    const request = jest.spyOn(OpenClawGatewayClient.prototype, 'request').mockResolvedValue({
      id: 'oc_bare',
      title: 'scratch',
    });

    const client = new OpenClawAdapterClient(PROFILE, {});
    await client.createSession('scratch');

    expect(request).toHaveBeenCalledWith('sessions.create', { title: 'scratch' });
    const params = request.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('model');
    client.disconnect();
  });
});
