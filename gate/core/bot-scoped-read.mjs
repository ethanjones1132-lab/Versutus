import { withActivityTimeout } from './activity.mjs';

/** The supported list envelopes, with malformed responses kept distinct from empty lists. */
function rowsOf(value) {
  if (Array.isArray(value)) return value;
  const rows = value?.data ?? value?.sessions ?? value?.jobs ?? value?.crons ?? value?.items;
  if (!Array.isArray(rows)) throw new Error('Backend returned no list');
  return rows;
}

/**
 * Hermes stores each named Bot's conversations and schedules in its own home.
 * The root listing covers only the default home. Other adapters already list
 * their shared store and must not be enumerated this way: a Claude agent file,
 * for example, is not a second session store.
 *
 * Keep display ownership distinct from the home actually read. A legacy root
 * job named [bot:scout] still lives at the root address, not /p/scout.
 */
export async function readBotScopedRows({ backend, method, limit = 500, timeoutMs = 7_500 }) {
  // One deadline for the whole roster, not one fresh eight-second wait per
  // batch. Leave headroom inside the feed collector's eight-second ceiling.
  const deadline = Date.now() + timeoutMs;
  const bounded = (work) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Bot read deadline exceeded'));
    return withActivityTimeout(Promise.resolve().then(work), remaining);
  };
  const read = async (target, botId = null) => {
    if (typeof target?.[method] !== 'function') throw new Error('Listing is unavailable');
    const rows = rowsOf(await bounded(() => target[method](limit)));
    return rows.map((row) => {
      if (method === 'listJobs') return { ...row, scopeBotId: botId, ...(botId ? { botId } : {}) };
      return { ...row, ...(botId ? { bot: botId } : {}) };
    });
  };

  const canScope = typeof backend.listBots === 'function' && typeof backend.forBot === 'function';
  // Start the default home independently. A stalled default listener must
  // not prevent healthy named homes being read inside the same deadline.
  const rootRead = read(backend).then(
    (value) => ({ status: 'fulfilled', value }),
    () => ({ status: 'rejected' }),
  );
  const [roster] = await Promise.allSettled([canScope
    ? bounded(() => backend.listBots()).then(rowsOf)
    : Promise.resolve([])]);
  const errors = [];
  const rows = [];
  let successes = 0;
  if (roster.status === 'rejected') errors.push('Bot roster could not be read');
  const bots = roster.status === 'fulfilled'
    ? [...new Map(roster.value.filter((bot) => typeof bot?.id === 'string' && bot.id && bot.id !== 'default')
      .map((bot) => [bot.id, bot])).values()]
    : [];

  // Bound fan-out so a large roster never opens dozens of simultaneous reads.
  for (let offset = 0; offset < bots.length; offset += 4) {
    const batch = await Promise.allSettled(bots.slice(offset, offset + 4).map(async (bot) => {
      if (bot.routable === false) throw new Error('Bot is not set up');
      const scoped = await bounded(() => backend.forBot(bot.id));
      return read(scoped, bot.id);
    }));
    for (let i = 0; i < batch.length; i += 1) {
      if (batch[i].status === 'fulfilled') {
        successes += 1;
        rows.push(...batch[i].value);
      } else {
        // Do not expose credential-bearing upstream error bodies in coverage.
        errors.push(`Bot ${bots[offset + i].id} could not be read`);
      }
    }
  }
  const root = await rootRead;
  if (root.status === 'fulfilled') {
    successes += 1;
    rows.unshift(...root.value);
  } else errors.unshift('Default Bot could not be read');
  if (successes === 0) throw new Error(errors.join('; '));
  const seen = new Set();
  return {
    rows: rows.filter((row) => {
      if (row?.id == null) return true; // the collector diagnoses malformed rows
      const key = JSON.stringify([method === 'listJobs' ? row.scopeBotId : (row.bot ?? null), String(row.id)]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    errors,
  };
}
