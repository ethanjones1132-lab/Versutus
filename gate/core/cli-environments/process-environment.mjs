import { issueInvocationToken } from './invocation-tokens.mjs';

const ALLOWED = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

// On macOS and Linux a child also needs its user identity and scratch space:
// without HOME a CLI cannot find its own config (~/.config, ~/.hermes), and
// without TMPDIR macOS tools fall back to a shared /tmp. The Windows list above
// is untouched; these are added only off Windows.
const ALLOWED_POSIX = new Set(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'PATH']);

const BLOCKED = /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)$/i;

export function buildCliEnvironment(parentEnvironment = {}, request, { platform = process.platform } = {}) {
  const child = Object.create(null);
  const posix = platform !== 'win32';
  for (const [key, value] of Object.entries(parentEnvironment)) {
    const allowed = ALLOWED.has(key) || (posix && ALLOWED_POSIX.has(key));
    if (!allowed || BLOCKED.test(key)) continue;
    child[key] = value;
  }

  // Credentials reach a CLI only by deliberate binding, never by inheritance.
  // The strip above stays absolute for the parent environment; this adds back
  // exactly the keys an operator attached to this environment (from the vault),
  // so one provider's key can never be picked up by another platform.
  for (const [key, value] of Object.entries(request.credentials ?? {})) {
    if (typeof value !== 'string' || value.length === 0) continue;
    child[key] = value;
  }

  const issued = issueInvocationToken(request);
  child.VERSUTUS_CLI_INVOCATION_TOKEN = issued.token;
  // Omitted rather than set to nothing when no endpoint is known: a CLI that
  // finds no VERSUTUS_GATE_CHAT knows it has no route back to the Gate, while
  // an empty one reads as a URL that cannot work.
  if (request.endpoints?.chat) child.VERSUTUS_GATE_CHAT = request.endpoints.chat;
  return child;
}
