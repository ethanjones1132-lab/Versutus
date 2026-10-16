import assert from 'node:assert/strict';
import test from 'node:test';

import { isTailnetIpv4, tailnetIpv4FromInterfaces } from '../core/reachability.mjs';

test('Tailscale CGNAT addresses are recognized and loopback is not', () => {
  assert.equal(isTailnetIpv4('100.101.102.103'), true);
  assert.equal(isTailnetIpv4('100.64.0.1'), true);
  assert.equal(isTailnetIpv4('100.127.255.255'), true);
  assert.equal(isTailnetIpv4('100.63.255.255'), false);
  assert.equal(isTailnetIpv4('127.0.0.1'), false);
  assert.equal(isTailnetIpv4('192.168.1.30'), false);
  assert.equal(isTailnetIpv4('ethanspc.example.ts.net'), false);
});

test('tailnetIpv4FromInterfaces only returns CGNAT IPv4s', () => {
  const found = tailnetIpv4FromInterfaces({
    Ethernet: [
      { address: '192.168.1.30', family: 'IPv4', internal: false },
      { address: '100.101.102.103', family: 'IPv4', internal: false },
      { address: '127.0.0.1', family: 'IPv4', internal: true },
    ],
    'Tailscale Tunnel': [{ address: '100.101.102.103', family: 4, internal: false }],
  });
  assert.deepEqual(found, ['100.101.102.103']);
});
