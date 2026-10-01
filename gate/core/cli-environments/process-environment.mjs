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

const BLOCKED = /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)$/i;

export function buildCliEnvironment(parentEnvironment = {}, request) {
  const child = Object.create(null);
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (!ALLOWED.has(key) || BLOCKED.test(key)) continue;
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
