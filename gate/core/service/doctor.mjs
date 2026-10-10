export function doctor({
  user,
  gateHome,
  listen,
  // The result of checkCredentialBackend(): { backend, ok, detail }. This
  // line used to be a hard-coded `dpapi: usable`, true on no platform but
  // the one it was written on; it now reports what a real check found.
  vaultCheck,
  serverProbe,
  environmentFindings,
} = {}) {
  // No `pid` line on purpose: this command used to print its own ephemeral
  // process id, which every reader took for the running Gate's pid (observed
  // 2026-08-25 — doctor printed 90428 while the listener was 28160). The
  // wire-true liveness fact is the server probe below; process identity lives
  // in netstat/Task Manager, not here.
  const lines = [
    `user: ${user}`,
    `gateHome: ${gateHome}`,
    `listen: ${listen}`,
  ];
  lines.push(vaultCheck
    ? `credentials: ${vaultCheck.backend} ${vaultCheck.ok ? 'usable' : 'UNAVAILABLE'}${vaultCheck.detail ? ` (${vaultCheck.detail})` : ''}`
    : 'credentials: not checked');

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
