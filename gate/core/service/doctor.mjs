export function doctor({
  user,
  gateHome,
  listen,
  pid,
  dpapi = true,
  serverProbe,
  environmentFindings,
} = {}) {
  const lines = [
    `user: ${user}`,
    `gateHome: ${gateHome}`,
    `listen: ${listen}`,
    `pid: ${pid}`,
    `dpapi: ${dpapi ? 'usable' : 'unavailable'}`,
  ];

  if (serverProbe) {
    lines.push(
      `server: ${serverProbe.reachable ? 'running' : 'NOT REACHABLE'} on ${listen} (${serverProbe.detail})`,
    );
  }

  if (environmentFindings) {
    lines.push('environment records:');
    for (const finding of environmentFindings) {
      const label = finding.environment ? `${finding.environment}: ` : '';
      const severity = finding.severity === 'ok' || finding.severity === 'info'
        ? finding.severity
        : finding.severity.toUpperCase();
      lines.push(`  ${label}${severity} — ${finding.message}`);
    }
  } else {
    lines.push('probes: health manifest providers models environments');
  }

  return lines.join('\n');
}
