import type { GatewayBackend } from '@/lib/portal/manifest';

/** One catalogue row a Bot's model pin can be set from. */
export type BotRuntimeModel = {
  id: string;
  provider?: string;
  providerId?: string;
  modelId?: string;
  available?: boolean;
};

/**
 * A place a Bot can live (ADR 0016): a Gate environment that serves Bots. The
 * New Agent sheet offers one of these per row, and a create is aimed at its
 * `id` as `backendId`.
 */
export type BotRuntimeOption = {
  id: string;
  label: string;
  /** The Gate only lets this runtime pin free models, so the sheet offers no others. */
  freeOnly: boolean;
  /**
   * The pin choices this runtime offers. Absent means "the chat screen's own
   * catalogue", which is what Hermes Bots have always used.
   */
  models?: BotRuntimeModel[];
};

type CatalogRow = Record<string, unknown>;

function isOpenCode(backend: GatewayBackend): boolean {
  return (backend.adapterId ?? backend.id).toLowerCase().startsWith('opencode');
}

function runtimeLabel(backend: GatewayBackend): string {
  if (isOpenCode(backend)) return 'OpenCode';
  const adapter = (backend.adapterId ?? '').toLowerCase();
  if (adapter.startsWith('hermes')) return 'Hermes';
  return backend.label || backend.id;
}

/**
 * The runtimes that can host a Bot, Hermes first (it is what a Bot has always
 * been). Fewer than two means there is nothing to choose between and the sheet
 * keeps its single-runtime form.
 *
 * The free-only rule is the Gate's to enforce; this only keeps the picker
 * honest by listing the rows the Gate flagged `free`, so nobody pins a model the
 * Gate is going to refuse.
 */
export function botRuntimes(
  backends: GatewayBackend[] | undefined,
  catalog: CatalogRow[] | undefined,
): BotRuntimeOption[] {
  const capable = (backends ?? []).filter((backend) => (backend.capabilities ?? []).includes('bots'));
  const ordered = [...capable].sort((a, b) => Number(isOpenCode(a)) - Number(isOpenCode(b)));
  return ordered.map((backend) => {
    if (!isOpenCode(backend)) {
      return { id: backend.id, label: runtimeLabel(backend), freeOnly: false };
    }
    const models: BotRuntimeModel[] = [];
    for (const row of catalog ?? []) {
      if (row.backendId !== backend.id || row.free !== true) continue;
      const modelId = typeof row.modelId === 'string' ? row.modelId : undefined;
      models.push({
        id: String(row.id ?? modelId ?? ''),
        provider: row.provider as string | undefined,
        providerId: (row.providerId ?? row.provider) as string | undefined,
        modelId,
        available: row.available !== false,
      });
    }
    return { id: backend.id, label: runtimeLabel(backend), freeOnly: true, models };
  });
}

/** Only the runtime a Bot already lives on, for editing it (the runtime cannot change). */
export function runtimeForBot(
  runtimes: BotRuntimeOption[],
  bot: { backendId?: string | null },
): BotRuntimeOption[] {
  const owner = runtimes.find((runtime) => runtime.id === bot.backendId);
  return owner ? [owner] : [];
}
