/**
 * Primary actions on the Home hero when a gateway profile is already saved.
 * Chat, Activity, and Tools live on the tab bar; Setup lives on the header gear.
 */

export type HomeHeroPrimaryAction = {
  id: 'setup';
  label: 'Setup';
  href: '/gateway/setup';
};

export function homeHeroPrimaryActions(): HomeHeroPrimaryAction[] {
  return [];
}

/**
 * The Home Gateways header's constellation affordance.
 *
 * The fleet map is a destination any saved roster can open — the hero's other
 * actions are capability-gated to a connected gateway, but the ring renders
 * two truth classes by design, so a saved-but-offline fleet is exactly what
 * the map exists to show.
 */

export type HomeHeroConstellationAction = {
  id: 'constellation';
  label: 'Fleet map';
  href: '/fleet';
};

export function homeConstellationVisible(gatewayCount: number): boolean {
  return gatewayCount > 0;
}
