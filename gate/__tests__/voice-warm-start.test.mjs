// The Gate must not make the first call pay for the voice worker's model load.
// These tests inject a pool whose `warm` never settles: if `listen()` or
// `createGate` awaited it, nothing here would ever return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { voicePaths } from '../core/voice/runtime.mjs';

const REQUIRED_MODELS = ['kokoro-v1.0.onnx', 'voices-v1.0.bin', 'smart-turn-v3.2-cpu.onnx'];

function fakePool() {
  return {
    warms: 0,
    shutdowns: 0,
    warm() {
      this.warms += 1;
      return new Promise(() => {});
    },
    shutdown() {
      this.shutdowns += 1;
      return Promise.resolve();
    },
  };
}

/** A Gate whose voice runtime is installed, so `local` really is ready. */
async function installedGate(config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-voice-warm-'));
  const home = join(root, 'gate-home');
  process.env.VERSUTUS_GATE_HOME = home;
  const paths = voicePaths({ VERSUTUS_GATE_HOME: home }, process.platform);
  await mkdir(dirname(paths.python), { recursive: true });
  await mkdir(paths.models, { recursive: true });
  await writeFile(paths.python, '#!/bin/sh');
  for (const name of REQUIRED_MODELS) await writeFile(join(paths.models, name), 'model');
  const gate = await createGate({ root, port: 0, ...config });
  return { root, gate };
}

async function capabilities(gate, deviceToken) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ method: 'voice.capabilities', params: {} }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

const settle = () => new Promise((done) => setImmediate(done));

test('the Gate starts warming its voice worker without waiting for it', async () => {
  const pool = fakePool();
  const { gate } = await installedGate({ voicePool: pool });
  try {
    // Reaching this line at all is half the assertion: `warm` never settles.
    assert.ok(gate.port > 0, 'the Gate is listening while the worker loads');
    await settle();
    assert.equal(pool.warms, 1, 'one worker is warmed for the Gate, before any call');
  } finally {
    await gate.close();
  }
  assert.equal(pool.shutdowns, 1, 'the worker does not outlive the Gate');
});

test('voice.capabilities warms the worker the call sheet is about to need', async () => {
  const pool = fakePool();
  const { gate, root } = await installedGate({ voicePool: pool });
  try {
    await settle();
    const before = pool.warms;
    const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
    const deviceToken = await store.issue('phone-1', { role: 'operator', scopes: [] });

    const state = await capabilities(gate, deviceToken);

    assert.equal(state.engines.local.state, 'ready');
    assert.equal(pool.warms, before + 1, 'opening the call sheet prepares the worker');
  } finally {
    await gate.close();
  }
});

test('voiceWarmStart off leaves the worker cold, and a cold Gate still shuts it down', async () => {
  const pool = fakePool();
  const { gate, root } = await installedGate({ voicePool: pool, voiceWarmStart: false });
  try {
    await settle();
    const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
    const deviceToken = await store.issue('phone-1', { role: 'operator', scopes: [] });
    await capabilities(gate, deviceToken);

    assert.equal(pool.warms, 0, 'nothing is warmed, and capabilities says nothing about it');
  } finally {
    await gate.close();
  }
  assert.equal(pool.shutdowns, 1, 'a cold Gate still shuts the pool down');
});
