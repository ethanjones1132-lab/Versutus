// ─── OpenClaw → portal mapping (pure, node-testable) ──────────────
// Dialect translation between OpenClaw wire shapes and the portal's
// Hermes-shaped types. No react-native imports — unit-testable.

import { httpToWsBase } from '@/lib/gateway/url';
import type { HermesSession, ModelInfo, SessionMessage } from '@/lib/gateway/types';

/** Convert a saved HTTP base URL to the OpenClaw WS endpoint. */
export function toOpenClawWsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (/^wss?:\/\//i.test(trimmed)) return trimmed.endsWith('/openclaw') ? trimmed : `${trimmed}/openclaw`;
  return `${httpToWsBase(trimmed)}/openclaw`;
}

export function normalizeOpenClawModel(value: unknown): ModelInfo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.model === 'string' ? raw.model : undefined;
  if (!id) return null;
  return { id, object: 'model' };
}

export function normalizeOpenClawSession(value: unknown): HermesSession | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  if (!id) return null;
  const startedAt = num(raw.startedAt) ?? num(raw.createdAt) ?? num(raw.started_at) ?? 0;
  return {
    id,
    source: 'openclaw',
    user_id: null,
    model: typeof raw.model === 'string' ? raw.model : null,
    title: typeof raw.title === 'string' ? raw.title : typeof raw.name === 'string' ? raw.name : null,
    started_at: startedAt,
    ended_at: typeof raw.endedAt === 'number' ? raw.endedAt : null,
    end_reason: typeof raw.endReason === 'string' ? raw.endReason : null,
    message_count: num(raw.messageCount) ?? 0,
    tool_call_count: num(raw.toolCallCount) ?? 0,
    input_tokens: num(raw.inputTokens) ?? 0,
    output_tokens: num(raw.outputTokens) ?? 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: typeof raw.estimatedCostUsd === 'number' ? raw.estimatedCostUsd : null,
    actual_cost_usd: null,
    api_call_count: num(raw.apiCallCount) ?? 0,
    parent_session_id: typeof raw.parentSessionId === 'string' ? raw.parentSessionId : null,
    last_active: num(raw.lastActive) ?? startedAt,
    preview: typeof raw.preview === 'string' ? raw.preview : null,
    has_system_prompt: false,
    has_model_config: false,
  };
}

export function normalizeOpenClawMessage(value: unknown): SessionMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const role = typeof raw.role === 'string' ? raw.role : typeof raw.sender === 'string' ? raw.sender : '';
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
  const content = raw.content ?? raw.text ?? raw.message ?? '';
  return {
    role,
    content: content as SessionMessage['content'],
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
