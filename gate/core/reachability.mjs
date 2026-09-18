// ─── Addresses the Gate can advertise so a phone survives a DNS blip ─────
// Tailscale MagicDNS is the usual hostname. When the phone cannot resolve it,
// the tailnet IPv4 (CGNAT 100.64/10) still works. LAN addresses stay off the
// manifest — they are not what a phone on cellular can use.

import { networkInterfaces } from 'node:os';

export function isTailnetIpv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value ?? ''));
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n, i) => n > 255 || String(n) !== match[i + 1])) return false;
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function isIpv4Family(family) {
  return family === 'IPv4' || family === 4;
}

/** Unique tailnet IPv4s from a `os.networkInterfaces()`-shaped map. */
export function tailnetIpv4FromInterfaces(interfaces = networkInterfaces()) {
  const found = [];
  const seen = new Set();
  for (const addrs of Object.values(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (!addr || addr.internal || !isIpv4Family(addr.family)) continue;
      if (!isTailnetIpv4(addr.address) || seen.has(addr.address)) continue;
      seen.add(addr.address);
      found.push(addr.address);
    }
  }
  return found;
}
