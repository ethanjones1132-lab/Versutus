// ─── Which backend answers a spoken turn ────────────────────────────────
// A call carries the thread it was started from. A Bot names its environment;
// an explicit backendId pins one; an unscoped thread speaks to the chat path
// its typed turns use.

/**
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object> }} backendManager
 * @param {{ botId?: string, backendId?: string }} [thread]
 * @returns {Promise<object | null>}
 */
export async function resolveVoiceBackend(backendManager, thread = {}) {
  const { botId, backendId } = thread ?? {};
  if (botId && !backendId) {
    for (const entry of await backendManager.list()) {
      const candidate = await backendManager.get(entry.id).catch(() => null);
      if (candidate && typeof candidate.forBot === 'function') {
        try {
          return await candidate.forBot(botId);
        } catch {
          // try the next environment that can own the Bot
        }
      }
    }
  }
  if (!backendId && !botId) {
    // The backend that sends and streams a turn in one call (Hermes) is the
    // typed chat path. `list()[0]` is Claude Code on a typical Gate, so every
    // spoken turn on a Hermes thread went to Claude Code and failed
    // (2026-09-19).
    for (const entry of await backendManager.list()) {
      const candidate = await backendManager.get(entry.id).catch(() => null);
      if (candidate && typeof candidate.sendMessageStreaming === 'function') return candidate;
    }
  }
  const id = backendId ?? (await backendManager.list())[0]?.id;
  if (!id) return null;
  try {
    const backend = await backendManager.get(id);
    if (botId && typeof backend?.forBot === 'function') return await backend.forBot(botId);
    return backend;
  } catch {
    return null;
  }
}
