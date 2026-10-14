import type { AppShortcut } from '@/lib/gateway/shortcuts';
import { recentBotShortcuts } from '@/lib/gateway/shortcuts';

export const RECENT_BOT_SHORTCUTS_KEY = 'versutus:recent-bot-shortcuts';

export type RecentBotShortcutStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type BotShortcutNativeUpdate = (shortcuts: AppShortcut[]) => Promise<unknown>;

export type CreateBotShortcutRecorderOptions = {
  storage: RecentBotShortcutStorage;
  updateShortcuts: BotShortcutNativeUpdate;
  limit?: number;
};

export function createBotShortcutRecorder(options: CreateBotShortcutRecorderOptions): (botId: string) => Promise<string[]> {
  const limit = options.limit ?? 3;
  let chain: Promise<void> = Promise.resolve();
  const remember = (botId: string): Promise<string[]> => {
    const result = chain.then(async () => {
      const id = botId.trim();
      let current: unknown[] = [];
      try {
        const raw = await options.storage.getItem(RECENT_BOT_SHORTCUTS_KEY);
        if (typeof raw === 'string' && raw.length > 0) {
          const parsed: unknown = JSON.parse(raw);
          current = Array.isArray(parsed) ? parsed : [];
        }
      } catch {
        current = [];
      }
      const normalized: string[] = [];
      for (const entry of current) {
        const value = (typeof entry === 'string' ? entry : String(entry)).trim();
        if (value && !normalized.includes(value)) normalized.push(value);
      }
      const next = [id, ...normalized.filter((entry) => entry !== id)].slice(0, limit > 0 ? limit : 0);
      try {
        await options.storage.setItem(RECENT_BOT_SHORTCUTS_KEY, JSON.stringify(next));
      } catch {
        // Chat send must never fail because shortcut storage failed.
      }
      try {
        await options.updateShortcuts(recentBotShortcuts(next));
      } catch {
        // Native donation failures are swallowed for the same reason.
      }
      return next;
    });
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<string[]>;
  };
  return remember;
}
