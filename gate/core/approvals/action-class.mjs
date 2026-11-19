import { redactSensitiveText } from '../credentials/redaction.mjs';

export const VOICE_APPROVAL_DEADLINE_MS = 30_000;

// Names are adapter protocol identifiers, never model-supplied descriptions.
// In particular, a command that claims to read is still an execution request.
const groups = new Map(Object.entries({
  read: ['read', 'glob', 'grep', 'read_file', 'search_files', 'session_search'],
  workspace_write: ['edit', 'write', 'multiedit', 'notebookedit', 'write_file', 'patch',
    'apply_patch', 'applypatchapproval', 'filechangerequestapproval', 'item/filechange/requestapproval'],
  shell_exec: ['bash', 'powershell', 'shell', 'terminal', 'execute_code', 'exec',
    'execcommandapproval', 'commandexecutionrequestapproval', 'item/commandexecution/requestapproval'],
  network_write: ['webfetch', 'websearch', 'web_search', 'web_extract', 'browser_exec', 'network_write'],
  connector: ['mcp', 'plugin', 'connector', 'app', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource'],
  credential_system: ['credential', 'system', 'install', 'update', 'destructive', 'bypass',
    'host_write', 'external_directory', 'permissionsrequestapproval', 'item/permissions/requestapproval'],
}).flatMap(([kind, names]) => names.map((name) => [name, kind])));

export function actionClass(tool, { external = false } = {}) {
  if (external || /^mcp__|^mcp:/i.test(String(tool))) return 'connector';
  return groups.get(String(tool).toLowerCase()) ?? 'unknown';
}

export function approvalIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.:/-]{0,95}$/i.test(value)) return null;
  return redactSensitiveText(value) === value ? value : null;
}

const summaryByClass = {
  read: 'Read information',
  workspace_write: 'Change workspace files',
  shell_exec: 'Run a shell command',
  network_write: 'Make a network request',
  connector: 'Call a connector or plug-in',
  credential_system: 'Access system permissions or credentials',
  unknown: 'Run an unrecognized action',
};

export function safeActionSummary(kind, tool) {
  const description = summaryByClass[kind] ?? summaryByClass.unknown;
  const name = approvalIdentifier(tool);
  return `${description}${name ? ` (${name})` : ''}?`;
}
