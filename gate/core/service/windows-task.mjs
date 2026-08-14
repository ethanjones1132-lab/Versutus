export function buildTaskDefinition({ user, executable, gateHome } = {}) {
  if (!user || /^system$/i.test(user) || /\\system$/i.test(user)) {
    throw new Error('Scheduled Task must run as the logged-in user, not SYSTEM');
  }
  if (!executable) throw new Error('executable is required');
  return {
    name: 'VersutusGate',
    userId: user,
    logonType: 'InteractiveToken',
    runLevel: 'LeastPrivilege',
    trigger: 'AtLogon',
    command: `node "${executable}" start`,
    workingDirectory: gateHome,
    environment: {
      VERSUTUS_GATE_HOME: gateHome,
    },
  };
}

export async function installTask(definition, { exec } = {}) {
  const xml = serializeTask(definition);
  if (exec) return exec(xml);
  return definition;
}

export function serializeTask(definition) {
  return `<?xml version="1.0"?>
<Task>
  <Principals><Principal><UserId>${definition.userId}</UserId><LogonType>${definition.logonType}</LogonType><RunLevel>${definition.runLevel}</RunLevel></Principal></Principals>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Actions><Exec><Command>node</Command><Arguments>${definition.command.replace(/^node /, '')}</Arguments></Exec></Actions>
</Task>
`;
}
