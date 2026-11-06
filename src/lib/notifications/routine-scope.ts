/**
 * The scope a routine list answers for. A gateway's job routes are scoped to
 * the Bot (or, with no Bot, the environment) the client named when it read, so
 * two reads of one gateway under different Bots list different jobs: keying
 * the remembered ids by gateway alone would read a Bot switch as every other
 * Bot's routines disappearing.
 */
export function routineReadScope(gatewayId: string, client: { botId?: string; backendId?: string }): string {
  if (client.botId) return `gateway:${gatewayId}:bot:${client.botId}`;
  return `gateway:${gatewayId}:env:${client.backendId ?? 'default'}`;
}
