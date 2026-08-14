export function doctor({ user, gateHome, listen, pid, dpapi = true } = {}) {
  return [
    `user: ${user}`,
    `gateHome: ${gateHome}`,
    `listen: ${listen}`,
    `pid: ${pid}`,
    `dpapi: ${dpapi ? 'usable' : 'unavailable'}`,
    'probes: health manifest providers models environments',
  ].join('\n');
}
