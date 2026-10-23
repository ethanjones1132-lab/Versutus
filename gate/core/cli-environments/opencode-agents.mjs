/**
 * OpenCode agents as Bots (ADR 0016).
 *
 * An OpenCode agent is a markdown file in the server's `<config>/agents/`
 * directory: YAML frontmatter (description, mode, model) and the system prompt
 * as the body. The Gate writes that file and asks the server to reload; the
 * server stays the source of truth for what exists (`GET /agent`).
 */

import { validateBotId } from './hermes-bot-create.mjs';

export { validateBotId };

/** The only agent modes a Bot can be: a conversation partner, not a subagent. */
const BOT_MODES = new Set(['primary', 'all']);

/** True when `agent` (an element of `GET /agent`) is a Bot rather than a built-in or subagent. */
export function isBotAgent(agent) {
  return Boolean(agent) && agent.native !== true && BOT_MODES.has(agent.mode ?? 'primary');
}

/**
 * A model is free when the server prices both directions at zero and the
 * catalog has not retired it. Cost is the server's own statement, so a paid key
 * added later never makes a paid model look free.
 */
export function isFreeModel(model) {
  const cost = model?.cost;
  if (!cost || typeof cost !== 'object') return false;
  if (model.status === 'deprecated') return false;
  return cost.input === 0 && cost.output === 0;
}

/** Flatten `GET /config/providers` into `{ providerId, modelId, free }` rows. */
export function flattenModels(config) {
  const rows = [];
  for (const provider of config?.providers ?? []) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      rows.push({ providerId: provider.id, modelId, free: isFreeModel(model) });
    }
  }
  return rows;
}

/**
 * Pick the pin for a Bot. An explicit choice must exist and, when the Gate is
 * free-only, be free; no choice falls back to the server's default if that is
 * free, else the first free model, so an unpinned Bot can never drift onto a
 * paid model when a key is added later.
 */
export function resolveModelPin({ providerId, modelId }, models, { freeOnly = true, defaults = {} } = {}) {
  const refuse = (message, code) => {
    const error = new Error(message);
    error.code = code;
    error.status = 400;
    return error;
  };
  const wanted = typeof modelId === 'string' ? modelId.trim() : '';
  if (wanted) {
    // Accept `provider/model` in modelId as well as a separate providerId.
    const slash = wanted.indexOf('/');
    const provider = (typeof providerId === 'string' && providerId.trim())
      || (slash > 0 ? wanted.slice(0, slash) : '');
    const model = slash > 0 && !providerId ? wanted.slice(slash + 1) : wanted;
    const match = models.find((row) => row.modelId === model && (!provider || row.providerId === provider));
    if (!match) throw refuse(`model "${wanted}" is not available on this OpenCode`, 'unknown_model');
    if (freeOnly && !match.free) throw refuse(`model "${wanted}" is not free; only free models are allowed here`, 'model_not_free');
    return { providerId: match.providerId, modelId: match.modelId };
  }
  const pool = freeOnly ? models.filter((row) => row.free) : models;
  const preferred = pool.find((row) => defaults[row.providerId] === row.modelId) ?? pool[0];
  if (!preferred) throw refuse('no free model is available on this OpenCode', 'no_free_model');
  return { providerId: preferred.providerId, modelId: preferred.modelId };
}

/** One-line YAML scalar. JSON strings are valid YAML, so quoting is exact. */
function yamlString(value) {
  return JSON.stringify(String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim());
}

/** The agent file: frontmatter the server reads, soul as the prompt body. */
export function renderAgentFile({ description, providerId, modelId, soul }) {
  const lines = ['---'];
  lines.push(`description: ${yamlString(description || '')}`);
  lines.push('mode: primary');
  lines.push(`model: ${yamlString(`${providerId}/${modelId}`)}`);
  lines.push('---');
  const body = String(soul ?? '').replace(/\r\n/g, '\n').trim();
  return `${lines.join('\n')}\n${body}${body ? '\n' : ''}`;
}

/** The roster row. Same shape as a Hermes Bot, plus the runtime it lives on. */
export function toPublicAgentBot(agent) {
  const model = agent.model?.modelID
    ? { default: agent.model.modelID, provider: agent.model.providerID ?? null }
    : null;
  return {
    id: agent.name,
    displayName: agent.name,
    routable: true,
    routingIssue: null,
    description: agent.description ? String(agent.description) : null,
    model,
    runtime: 'opencode',
  };
}
