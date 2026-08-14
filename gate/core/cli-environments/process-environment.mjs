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
  const issued = issueInvocationToken(request);
  child.VERSUTUS_CLI_INVOCATION_TOKEN = issued.token;
  child.VERSUTUS_GATE_CHAT = request.endpoints?.chat;
  return child;
}
