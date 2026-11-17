export const ProviderErrorCodes = {
  missing_credentials: 'missing_credentials',
  invalid_credentials: 'invalid_credentials',
  entitlement_denied: 'entitlement_denied',
  rate_limited: 'rate_limited',
  overloaded: 'overloaded',
  transient_network: 'transient_network',
  catalog_timeout: 'catalog_timeout',
  disabled: 'disabled',
  // The file is there and the Gate cannot decrypt it: a DPAPI blob written by
  // another Windows account, or a write that was killed half way. It is not a
  // network fault, and calling it one left the card reading "Degraded/stale"
  // with `auth: ready` and nothing telling the operator to set the key again.
  credential_unreadable: 'credential_unreadable',
};

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyProviderError(error = {}) {
  if (error.code === ProviderErrorCodes.catalog_timeout || error.code === 'catalog_timeout') {
    return ProviderErrorCodes.catalog_timeout;
  }
  // Ahead of the status branches: this is a local decrypt failure, so a status
  // field on the same error describes nothing and must not reclassify it.
  if (error.code === ProviderErrorCodes.credential_unreadable) {
    return ProviderErrorCodes.credential_unreadable;
  }
  if (error.status === 401 || error.statusCode === 401) return ProviderErrorCodes.invalid_credentials;
  if (error.status === 403 || error.statusCode === 403) return ProviderErrorCodes.entitlement_denied;
  if (error.status === 429 || error.statusCode === 429) return ProviderErrorCodes.rate_limited;
  if (error.status === 529 || error.statusCode === 529 || (error.status >= 500 && error.status <= 599)) {
    return ProviderErrorCodes.overloaded;
  }
  if (NETWORK_CODES.has(error.code)) return ProviderErrorCodes.transient_network;
  if (error.code && ProviderErrorCodes[error.code]) return error.code;
  return ProviderErrorCodes.transient_network;
}

export function authStateForCode(code, current = 'ready') {
  if (code === ProviderErrorCodes.missing_credentials) return 'missing';
  // The remedy for a key this machine cannot read is to set it again, not to
  // sign in again — an api_key provider has no sign-in step at all.
  if (code === ProviderErrorCodes.credential_unreadable) return 'missing';
  if (code === ProviderErrorCodes.invalid_credentials) return 'needs_reauth';
  if (code === ProviderErrorCodes.entitlement_denied) return 'denied';
  return current;
}

/**
 * A refusal that is about the model the turn named rather than about the
 * provider's ability to serve a turn.
 *
 * 404 is the one status both halves answer with. Recording every 404 as a
 * readiness verdict pinned a vendor's own "model not found" to the provider
 * card until some later turn happened to clear it. Setting every 404 aside
 * hid the other half: a wrong base URL, a wrong chat path, or a proxy in front
 * of the vendor answers 404 too, and the card stayed "ready" while no turn
 * could ever succeed.
 *
 * The facts to tell them apart are already on the record -- no probe needed:
 * the models the provider lists, and the model the turn named. A 404 is about
 * the model only when it points at one of those models, either by the requested
 * model id or by the vendor's own error body naming it. A 404 that names no
 * listed model is the endpoint answering, so it is a provider fault and reaches
 * the card.
 *
 * `models` is a catalog's model list (ids or entries with an `id`); `modelId`
 * is the model the failed turn asked for. An error that carries the request's
 * model on it (`error.model`, set by `ProviderService.chat`) is read the same
 * way, so a reader holding only the error still gets the model half.
 */
export function isModelScopedError(error = {}, { models = [], modelId } = {}) {
  if ((error.status ?? error.statusCode) !== 404) return false;
  const listed = listedModelIds(models);
  // Nothing on the record says which models this provider carries, so nothing
  // says this 404 is about one of them. The endpoint answered; take it at its
  // word instead of assuming the missing model is the reason.
  if (listed.length === 0) return false;
  const requested = firstString(modelId, error.model, error.modelId, error.requestedModel);
  if (requested && listed.some((id) => id.toLowerCase() === requested.toLowerCase())) {
    return true;
  }
  const said = errorText(error).toLowerCase();
  if (!said) return false;
  return listed.some((id) => namesModel(said, id.toLowerCase()));
}

function listedModelIds(models) {
  const ids = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model === 'string' ? model : model?.id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return ids;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Everything the refusal said in words. A vendor's explanation usually reaches
 * the Gate as part of the message (`profiles/registry.mjs` appends it after the
 * status); a caller that kept the body separately gets that read too.
 */
function errorText(error) {
  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  for (const field of [error.body, error.detail, error.responseBody, error.response?.body]) {
    if (typeof field === 'string') parts.push(field);
    else if (field && typeof field === 'object') {
      try {
        parts.push(JSON.stringify(field));
      } catch {
        // A body that cannot be serialised names no model; the message still can.
      }
    }
  }
  return parts.join('\n');
}

// What a model id may be made of, so `gpt-4` does not read as named by `gpt-4o`
// and `llama-3` does not read as named by `llama-3.1`.
const MODEL_ID_CHAR = /[A-Za-z0-9._:-]/;

/**
 * Does `text` name `id` as a whole model id? Substring matching alone is what
 * turns a listed `gpt-4` into a "match" inside a vendor's `gpt-4o-not-found`.
 * A separator around the id is fine -- `meta/llama-3` is named inside
 * `models/meta/llama-3` -- but a character that could extend the id is not.
 */
function namesModel(text, id) {
  if (!id) return false;
  let from = 0;
  while (from <= text.length - id.length) {
    const at = text.indexOf(id, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + id.length] ?? '';
    if (!MODEL_ID_CHAR.test(before) && !MODEL_ID_CHAR.test(after)) return true;
    from = at + 1;
  }
  return false;
}
