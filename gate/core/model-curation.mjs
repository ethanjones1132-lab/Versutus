// ─── Which catalogue rows are worth offering ───
//
// The operator asked for a clean catalogue: "show only providers with working
// credentials, hide broken, merge duplicates". Hermes answers with everything
// it knows about — 55 providers, 759 rows, including 42 providers the host is
// not signed into, two configured providers that shadow built-ins the Gate now
// prefers, and image/audio models that cannot hold a conversation.
//
// Pure: rows in, the same rows out in the same order with the same fields,
// plus `hidden`/`hiddenReason` where a rule applies. Nothing is deleted — the
// phone repairs a stale pin BY finding its row with `available: false`, so a
// hidden row has to arrive flagged rather than absent. Health is read through
// the injected table so this module never learns where verdicts are kept.

// Image, audio, embedding, rerank and moderation models cannot answer a chat
// turn. Matched on a whole token so a real model is never caught by a
// substring: `deepseek-v4-flash-vision-exp` (chat, with vision), `gpt-5.6-sol`,
// `kilo-auto/free`, `claude-*` and `grok-*` all stay.
const NON_CHAT_MODEL =
  /(^|[\/._-])(image|images|audio|tts|whisper|transcribe|embed|embedding|embeddings|rerank|moderation|dall-e)([._:-]|$)/i;

/** Reason a row the host cannot sign into carries. */
export const NOT_SIGNED_IN = 'Not signed in on the host';

/** Reason a row that is not a chat model carries. */
export const NOT_A_CHAT_MODEL = 'Not a chat model';

/**
 * Why a model is hidden, or null when it is fine.
 *
 * In order of what tells the operator most: a configured provider that
 * replaced this one (the rows will never come back, and the way out is the
 * provider above them), then the host's own sign-in, then a verdict earned by
 * real turns, then what the model actually is.
 */
export function hiddenReasonFor(row, { shadowedBy, verdict, now }) {
  const replacedBy = shadowedBy.get(providerScopeKey(row));
  if (replacedBy) return `Replaced by your ${replacedBy} provider`;
  if (row?.available === false) return NOT_SIGNED_IN;
  if (verdict?.failing) {
    const until = new Date(verdict.until ?? now()).toISOString().replace('T', ' ').slice(0, 16);
    // The bar is two, not a count of everything since: a model on its fifth
    // refusal still failed its LAST two turns, which is what the operator has
    // to act on.
    return `Failed its last 2 turns (${verdict.reason || 'the turn did not complete'}) - hidden until ${until} UTC`;
  }
  if (NON_CHAT_MODEL.test(modelTokenOf(row))) return NOT_A_CHAT_MODEL;
  return null;
}

/** Whether a row is hidden for not being runnable, and so must be locked. */
function hiddenForUnrunnable(row, { shadowedBy, verdict }) {
  return shadowedBy.has(providerScopeKey(row))
    || row?.available === false
    || verdict?.failing === true;
}

/**
 * The catalogue, curated.
 *
 * `health` is anything with `verdict(key)` — the Gate's model-health table, or
 * null in a test. The four rules:
 *
 *   a. the host is not signed into the row's provider (`available: false`);
 *   b. a `user-config` provider names this provider as an alias, or is named
 *      after it (`opencode-go-session` after `opencode-go`), so every row of
 *      the built-in it replaces is hidden. A `user-config` provider is never
 *      hidden this way — that is the one the operator added on purpose — and
 *      the comparison only ever runs among one environment's providers;
 *   c. the model is not a chat model;
 *   d. it failed its last two real turns inside the last six hours.
 *
 * Rules a and b are inert for the Gate's own provider rows, which carry no
 * `available` and no `backendId`: rule c applies to them, and rule d applies
 * ONLY if a verdict exists for their key. Nothing on the provider path records
 * one — `dispatchChat` -> `chatViaProviderService` / `proxyChat` writes nothing
 * to the health table — so today a Gate provider row is hidden by rule c and by
 * nothing else. It is still read through the verdict lookup rather than skipped
 * so the rule holds the moment that path starts recording. Rule b is also
 * scoped per environment, so a Gate provider whose id happens to equal a Hermes
 * built-in's is not hidden by the configured provider that replaces the Hermes
 * one.
 *
 * A scoped catalogue (one environment, or one Bot of it) passes `scopeId`:
 * every row is then judged under that scope - the same one the chat route files
 * a turn's outcome under (`healthScopeId`) - and rule b compares that
 * catalogue's providers among themselves even though a Bot's rows carry no
 * `backendId`.
 *
 * @param rows catalogue rows, in the order the caller will answer them.
 * @param options.health model-health verdicts; `options.now` the clock;
 *   `options.scopeId` the scope of a single-environment or single-Bot list.
 * @returns the same rows, same order, hidden ones flagged.
 */
export function curateModels(rows, { health, now = Date.now, scopeId } = {}) {
  const list = rows ?? [];
  // Judged under the scope, answered as they came: the scope is a key, never
  // a field the caller did not put on the row.
  const judged = scopeId ? list.map((row) => ({ ...row, backendId: scopeId })) : list;
  const shadowedBy = shadowedProviders(judged);
  return list.map((row, index) => {
    const subject = judged[index];
    const verdict = health?.verdict?.(healthKeyOf(subject)) ?? null;
    const reason = hiddenReasonFor(subject, { shadowedBy, verdict, now });
    if (!reason) return row;
    return {
      ...row,
      hidden: true,
      hiddenReason: reason,
      ...(hiddenForUnrunnable(subject, { shadowedBy, verdict }) ? { available: false } : {}),
    };
  });
}

/**
 * Built-in providers a configured provider has replaced: provider scope key to
 * the configured provider's display name.
 *
 * Hermes files both twins in one list, so the Gate has to say which one the
 * operator meant. The two ways a configuration names the twin it replaces are
 * an alias (`kilo` aliases `kilocode`) and a derived slug
 * (`opencode-go-session` after `opencode-go`) — and the second is the one that
 * matters most, because OpenCode Go now refuses a turn without the session
 * header only the configured provider sends.
 *
 * Scoped per environment (`providerScopeKey`), because a provider id is only
 * unique inside one environment's list: the aggregate catalogue carries a Gate
 * provider `opencode-go` beside Hermes's built-in one, and Hermes's configured
 * `opencode-go-session` says nothing about the Gate's provider of that name.
 */
export function shadowedProviders(rows) {
  const providers = providerIndex(rows);
  const shadowed = new Map();
  for (const [scopeKey, provider] of providers) {
    if (provider.source !== 'user-config') continue;
    for (const [otherScopeKey, other] of providers) {
      if (otherScopeKey === scopeKey || other.source === 'user-config') continue;
      if (!namesProvider(provider, provider.key, other.key)) continue;
      // First configuration to claim a twin wins; two of them claiming one
      // provider is an operator question this table has no opinion about.
      if (!shadowed.has(otherScopeKey)) shadowed.set(otherScopeKey, provider.name);
    }
  }
  return shadowed;
}

/** Every provider the rows mention, keyed by environment and normalised id. */
function providerIndex(rows) {
  const providers = new Map();
  for (const row of rows ?? []) {
    const key = providerScopeKey(row);
    if (!key || providers.has(key)) continue;
    providers.set(key, {
      key: providerKeyOf(row),
      name: typeof row.provider === 'string' && row.provider.trim() ? row.provider.trim() : providerKeyOf(row),
      source: row.providerSource,
      userDefined: row.providerUserDefined,
      aliases: Array.isArray(row.providerAliases) ? row.providerAliases.map(aliasKey).filter(Boolean) : [],
    });
  }
  return providers;
}

/** Whether `provider` (a user-config record) claims to replace `otherKey`. */
function namesProvider(provider, providerKey, otherKey) {
  if (provider.aliases.includes(otherKey)) return true;
  // A configured provider is named after the twin it replaces
  // (`opencode-go-session`, `kilo-labs`), which is how the operator spelled it.
  return providerKey.startsWith(`${otherKey}-`);
}

/** A provider id as the rules compare it: lower case, no `custom:` prefix. */
function aliasKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^custom:/, '');
}

/** The row's provider id, normalised; empty when the row names no provider. */
function providerKeyOf(row) {
  return aliasKey(row?.providerId ?? row?.id?.split('/')[0]);
}

/**
 * A provider id bound to the environment that filed it.
 *
 * Empty for a row of the Gate's own provider path, which carries no
 * environment: the provider path is never merged against an environment's
 * provider list, so nothing can shadow it there.
 */
function providerScopeKey(row) {
  const provider = providerKeyOf(row);
  if (!provider || !row?.backendId) return '';
  return `${row.backendId}|${provider}`;
}

/** The model token a non-chat pattern is matched against. */
function modelTokenOf(row) {
  if (typeof row?.modelId === 'string' && row.modelId.trim()) return row.modelId;
  if (typeof row?.id !== 'string') return '';
  // Strip a leading `provider/` so a provider named after a capability
  // (`image-lab`) cannot condemn every one of its chat models.
  return row.id.includes('/') ? row.id.slice(row.id.indexOf('/') + 1) : row.id;
}

/** The health key for a row, matching what the chat route wrote it under. */
export function healthKeyOf(row) {
  return `${row?.backendId ?? 'gate'}|${row?.id ?? ''}`;
}