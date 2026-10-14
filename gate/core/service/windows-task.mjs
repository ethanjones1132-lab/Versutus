import { writeFileSync } from 'node:fs';

export const TASK_NAME = 'VersutusGate';

/**
 * Build the durable Gate task: a hidden supervisor (`service run`) started
 * at the user's logon plus a headless 5-minute time trigger that revives a
 * dead supervisor. No visible console — a window that can be closed by hand
 * is how the Hermes and OpenClaw tasks died (0xC000013A).
 *
 * Two Task Scheduler defaults are deliberately overridden: the 72 h
 * ExecutionTimeLimit (the Hermes task still has it) and the below-normal
 * priority 7.
 *
 * The definition also carries the listen `host`/`port` the installer resolved
 * (a flag or VERSUTUS_GATE_HOST/PORT): the task launches the supervisor with
 * no console and no environment block, so the supervisor's own arguments are
 * the only way the operator's bind address reaches it. Read them back with
 * `taskRunArgs()`.
 */
export function buildTaskDefinition({
  user,
  codeRoot = 'C:\\Projects\\Versutus',
  nodeExe = 'C:\\Program Files\\nodejs\\node.exe',
  gateHome,
  host,
  port,
} = {}) {
  if (!user || /^system$/i.test(user) || /\\system$/i.test(user)) {
    throw new Error('Scheduled Task must run as the logged-in user, not SYSTEM');
  }
  if (!codeRoot) throw new Error('codeRoot is required');
  const cli = `${codeRoot}\\gate\\cli.mjs`;
  return {
    name: TASK_NAME,
    userId: user,
    logonType: 'InteractiveToken',
    runLevel: 'LeastPrivilege',
    codeRoot,
    xml: taskXml({ user, nodeExe, codeRoot, cli, host, port }),
  };
}

/** Write the XML UTF-16LE with a BOM, the encoding schtasks expects. */
export function writeTaskFile(xml, dest) {
  writeFileSync(dest, Buffer.from(`\ufeff${xml}`, 'utf16le'));
}

/**
 * The `--host`/`--port` a task definition hands its `service run` supervisor,
 * read back from the XML `service install` wrote. `service stop` and
 * `service status` run in a fresh shell with no arguments of their own, so the
 * installed task file — not their command line — is how they learn the address
 * to probe. A flag the installer never resolved means the Gate's own default.
 */
export function taskRunArgs(xml) {
  const match = /<Arguments>([^<]*)<\/Arguments>/.exec(String(xml ?? ''));
  if (!match) return {};
  const args = match[1].split(' ');
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const host = valueOf('--host');
  const port = Number(valueOf('--port'));
  return {
    ...(host ? { host } : {}),
    ...(Number.isInteger(port) ? { port } : {}),
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function taskXml({ user, nodeExe, codeRoot, cli, host, port }) {
  const command = 'C:\\Windows\\System32\\conhost.exe';
  const supervisor = ['service', 'run'];
  if (host) supervisor.push('--host', host);
  if (port !== undefined && port !== null) supervisor.push('--port', String(port));
  const args = `--headless "${nodeExe}" "${cli}" ${supervisor.join(' ')}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Versutus Gate: supervised local gateway. Revives itself at logon and every 5 minutes.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>2025-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT5M</Interval>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(codeRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}
