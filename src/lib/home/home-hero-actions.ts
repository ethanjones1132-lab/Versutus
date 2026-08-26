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
