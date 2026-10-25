import { keyValueStorage } from '@/lib/storage/key-value';
import { applyRecentBotShortcutsNative } from '@/lib/gateway/shortcut-donation-native';
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

/**
 * The one recorder a chat send, a gateway switch and a gateway retirement share.
 *
 * Recents are partitioned by gateway because a Bot is a profile of one Gate:
 * publishing another gateway's Bots would donate a link that opens the wrong
 * Bot (or no Bot at all) on the gateway the operator is actually connected to.
 * `register` records a used Bot on its gateway, `refresh` republishes the
 * gateway the operator is on, and `clear` forgets a gateway that is leaving.
 */
export type BotShortcutRecorder = {
  register(gatewayId: string, botId: string): Promise<string[]>;
  refresh(gatewayId?: string | null): Promise<AppShortcut[]>;
  clear(gatewayId: string): Promise<void>;
};

type RecentBotShortcutsLedger = {
  gateways: Record<string, string[]>;
  /** The gateway whose partition was last published to the launcher. */
  publishedGatewayId: string | null;
};

/**
 * Every recorder instance shares one queue. The provider's recorder registers a
 * send while the module-level one clears a retired profile, and a retirement
 * must not land halfway through a register that is rewriting the same blob.
 */
let shortcutQueue: Promise<void> = Promise.resolve();

function serializeShortcutWork<T>(work: () => Promise<T>): Promise<T> {
  const result = shortcutQueue.then(work, work);
  shortcutQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function trimmedIds(value: unknown, limit: number): string[] {
  if (limit <= 0 || !Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function readLedger(raw: string | null, limit: number): RecentBotShortcutsLedger {
  const empty: RecentBotShortcutsLedger = { gateways: {}, publishedGatewayId: null };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const record = parsed as Record<string, unknown>;
  // `gateways` is the current shape. A bare `{ gatewayId: [botId] }` object is
  // the legacy first version of this key, and still reads as recents rather
  // than throwing them away on upgrade.
  const source =
    record.gateways && typeof record.gateways === 'object' && !Array.isArray(record.gateways)
      ? (record.gateways as Record<string, unknown>)
      : record;
  const gateways: Record<string, string[]> = {};
  for (const [rawId, value] of Object.entries(source)) {
    if (rawId === 'publishedGatewayId') continue;
    const gatewayId = rawId.trim();
    if (!gatewayId) continue;
    const ids = trimmedIds(value, limit);
    if (ids.length > 0) gateways[gatewayId] = ids;
  }
  const published =
    typeof record.publishedGatewayId === 'string' ? record.publishedGatewayId.trim() : '';
  return { gateways, publishedGatewayId: published || null };
}

function serializeLedger(ledger: RecentBotShortcutsLedger): string {
  return JSON.stringify({
    gateways: ledger.gateways,
    publishedGatewayId: ledger.publishedGatewayId,
  });
}

function isEmptyLedger(ledger: RecentBotShortcutsLedger): boolean {
  return Object.keys(ledger.gateways).length === 0 && ledger.publishedGatewayId === null;
}

export function createBotShortcutRecorder(
  options: CreateBotShortcutRecorderOptions,
): BotShortcutRecorder {
  const limit = Math.max(0, options.limit ?? 3);

  const load = async (): Promise<{ ledger: RecentBotShortcutsLedger; raw: string | null }> => {
    try {
      const raw = await options.storage.getItem(RECENT_BOT_SHORTCUTS_KEY);
      return { ledger: readLedger(raw, limit), raw };
    } catch {
      // Chat send and gateway teardown must never fail because shortcut storage
      // was unavailable, so a refused read starts from the empty ledger.
      return { ledger: readLedger(null, limit), raw: null };
    }
  };

  const persist = async (ledger: RecentBotShortcutsLedger, raw: string | null): Promise<void> => {
    const next = serializeLedger(ledger);
    // Registration is idempotent: writing the same ledger again is not a change.
    if (next === raw) return;
    // A fresh install has nothing to record, and publishing the empty set must
    // not create the blob just to say so.
    if (raw === null && isEmptyLedger(ledger)) return;
    try {
      await options.storage.setItem(RECENT_BOT_SHORTCUTS_KEY, next);
    } catch {
      // The native publication below still carries this call's answer.
    }
  };

  const publish = async (
    ledger: RecentBotShortcutsLedger,
    gatewayId: string | null,
  ): Promise<AppShortcut[]> => {
    const ids = gatewayId ? (ledger.gateways[gatewayId] ?? []) : [];
    const shortcuts = recentBotShortcuts(ids, limit);
    try {
      // An empty array is still published: Android's setDynamicShortcuts([])
      // is what removes shortcuts that no longer name a live Bot or gateway.
      await options.updateShortcuts(shortcuts);
    } catch {
      // Native donation failures are swallowed; they must not fail a chat.
    }
    return shortcuts;
  };

  const register = (gatewayId: string, botId: string): Promise<string[]> =>
    serializeShortcutWork(async () => {
      const gateway = gatewayId.trim();
      const bot = botId.trim();
      // A missing gateway or Bot is not a shortcut: never publish a placeholder
      // link that names nobody, the way the static resource carries no Bot.
      if (!gateway || !bot) return [];
      const { ledger, raw } = await load();
      const current = ledger.gateways[gateway] ?? [];
      const next = [bot, ...current.filter((entry) => entry !== bot)].slice(0, limit);
      ledger.gateways[gateway] = next;
      ledger.publishedGatewayId = gateway;
      await persist(ledger, raw);
      await publish(ledger, gateway);
      return next;
    });

  const refresh = (gatewayId?: string | null): Promise<AppShortcut[]> =>
    serializeShortcutWork(async () => {
      const { ledger, raw } = await load();
      // No argument republishes whatever is published now; an explicit null
      // (no gateway connected) publishes the empty set and clears the launcher.
      const target =
        gatewayId === undefined ? ledger.publishedGatewayId : (gatewayId ?? '').trim() || null;
      ledger.publishedGatewayId = target;
      await persist(ledger, raw);
      return publish(ledger, target);
    });

  const clear = (gatewayId: string): Promise<void> =>
    serializeShortcutWork(async () => {
      const gateway = gatewayId.trim();
      if (!gateway) return;
      const { ledger, raw } = await load();
      const wasPublished = ledger.publishedGatewayId === gateway;
      delete ledger.gateways[gateway];
      if (wasPublished) ledger.publishedGatewayId = null;
      await persist(ledger, raw);
      // Republish whatever is left: the cleared gateway's Bots are gone, and a
      // gateway still published keeps the launcher entry that belongs to it.
      // With nothing left this is the empty set Android needs to remove them.
      await publish(ledger, wasPublished ? null : ledger.publishedGatewayId);
    });

  return { register, refresh, clear };
}

let defaultRecorder: BotShortcutRecorder | null = null;

function activeRecorder(): BotShortcutRecorder {
  defaultRecorder ??= createBotShortcutRecorder({
    storage: keyValueStorage,
    updateShortcuts: applyRecentBotShortcutsNative,
  });
  return defaultRecorder;
}

/** Forget one gateway's recents, including its launcher publication. */
export function clearRecentBotShortcutsForGateway(gatewayId: string): Promise<void> {
  return activeRecorder().clear(gatewayId);
}
