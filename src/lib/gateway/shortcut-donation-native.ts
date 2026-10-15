import type { AppShortcut } from '@/lib/gateway/shortcuts';

export type ShortcutNativeModule = typeof import('../../../modules/versutus-shortcuts').default;

export async function loadShortcutModule(
  load: () => Promise<ShortcutNativeModule> = async () => (await import('../../../modules/versutus-shortcuts')).default,
): Promise<ShortcutNativeModule | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

export async function applyRecentBotShortcutsNative(
  shortcuts: AppShortcut[],
  load: () => Promise<ShortcutNativeModule> = async () => (await import('../../../modules/versutus-shortcuts')).default,
): Promise<boolean> {
  const module = await loadShortcutModule(load);
  if (!module) return false;
  try {
    return (await module.setShortcuts(shortcuts)) === true;
  } catch {
    return false;
  }
}
