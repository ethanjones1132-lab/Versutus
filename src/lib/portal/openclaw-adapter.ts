// ─── OpenClaw adapter (Hermes-shaped surface over WS v4) ──────────
// Wraps the salvaged OpenClawGatewayClient so the provider can treat
// OpenClaw gateways like Hermes ones. Chat flows through the OpenClaw
// push event dialect (chat.send → chat events with delta/final/error).

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { extractMessageText } from '@/lib/gateway/messages';
import {
  normalizeOpenClawMessage,
  normalizeOpenClawModel,
  normalizeOpenClawSession,
  toOpenClawWsUrl,
} from '@/lib/portal/openclaw-mapping';
import type {
  ConnectionStatus,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  SessionMessage,
} from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';

type PendingChat = {
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  fullText: string;
  sessionId?: string;
};

export class OpenClawAdapterClient implements PortalClient {
  private readonly inner: OpenClawGatewayClient;
  private readonly sessionKey?: string;
  private pendingChat: PendingChat | null = null;
  private helloVersion?: string;
  private currentSessionId?: string;

  constructor(profile: GatewayProfile, callbacks: PortalClientCallbacks = {}) {
    this.sessionKey = profile.sessionKey;
    this.currentSessionId = profile.sessionId;
    this.inner = new OpenClawGatewayClient(
      { ...profile, url: toOpenClawWsUrl(profile.url) },
      {
        ...callbacks,
        onHello: (hello) => {
          this.helloVersion = hello.server?.version;
          callbacks.onHello?.(hello);
        },
        onChatEvent: (payload) => this.handleChatEvent(payload),
      },
    );
  }

  get connectionStatus(): ConnectionStatus {
    return this.inner.connectionStatus;
  }

  get statusDetail(): string {
    return this.inner.statusDetail;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  setSessionId(id: string | undefined) {
    this.currentSessionId = id;
  }

  updateProfile(profile: GatewayProfile) {
    this.inner.updateProfile({ ...profile, url: toOpenClawWsUrl(profile.url) });
  }

  connect(): void {
    this.inner.connect();
  }

  disconnect() {
    this.inner.disconnect();
  }

  async healthCheck(): Promise<HealthResponse | null> {
    if (this.inner.connectionStatus !== 'connected') return null;
    return { status: 'ok', platform: 'openclaw', version: this.helloVersion ?? 'unknown' };
  }

  async rpcRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.inner.request<T>(method, params);
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const result = (await this.inner.request<unknown>('models.list')) as
        | unknown[]
        | { data?: unknown[] }
        | null;
      const list = Array.isArray(result) ? result : (result?.data ?? []);
      return list
        .map((item) => normalizeOpenClawModel(item))
        .filter((model): model is ModelInfo => model !== null);
    } catch {
      return [];
    }
  }

  async getSessions(limit = 20): Promise<HermesSession[]> {
    try {
      const result = (await this.inner.request<unknown>('sessions.list', { limit })) as unknown[];
      const list = Array.isArray(result) ? result : [];
      return list
        .map((item) => normalizeOpenClawSession(item))
        .filter((session): session is HermesSession => session !== null);
    } catch {
      return [];
    }
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    try {
      const result = (await this.inner.request<unknown>('session.messages', { sessionId, limit })) as unknown[];
      const list = Array.isArray(result) ? result : [];
      return list
        .map((entry) => normalizeOpenClawMessage(entry))
        .filter((entry): entry is SessionMessage => entry !== null);
    } catch {
      return [];
    }
  }

  async streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: { model?: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<string> {
    const sessionId = options?.sessionId ?? this.currentSessionId;
    this.currentSessionId = sessionId;

    const userMessage = [...messages].reverse().find((message) => message.role === 'user');
    const text = userMessage ? extractMessageText(userMessage.content).trim() : '';
    if (!text) return '';

    if (options?.signal?.aborted) {
      void this.abortChat(sessionId);
      throw new Error('Chat aborted');
    }

    return new Promise<string>((resolve, reject) => {
      const pending: PendingChat = { onDelta, resolve, reject, fullText: '', sessionId };
      this.pendingChat = pending;

      const onAbort = () => {
        if (this.pendingChat === pending) this.pendingChat = null;
        void this.abortChat(sessionId);
        reject(new Error('Chat aborted'));
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      void this.inner
        .request('chat.send', {
          sessionKey: this.sessionKey,
          sessionId,
          message: text,
          idempotencyKey: `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          timeoutMs: 120000,
        })
        .catch((error: unknown) => {
          if (this.pendingChat === pending) this.pendingChat = null;
          options?.signal?.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async stopRun(_runId: string): Promise<void> {
    // OpenClaw aborts the current session's run rather than a run id.
    await this.abortChat(this.currentSessionId);
  }

  private handleChatEvent(payload: { deltaText?: string; text?: string; state?: string; error?: string }) {
    const pending = this.pendingChat;
    if (!pending) return;

    if (payload.state === 'delta' && payload.deltaText) {
      pending.fullText += payload.deltaText;
      pending.onDelta(payload.deltaText);
      return;
    }
    if (payload.state === 'final' || (payload.text && payload.state === undefined)) {
      this.pendingChat = null;
      const full = pending.fullText || payload.text || '';
      pending.resolve(full);
      return;
    }
    if (payload.state === 'error') {
      this.pendingChat = null;
      pending.reject(new Error(payload.error ?? 'Chat failed on gateway'));
    }
  }

  private async abortChat(sessionId?: string) {
    try {
      await this.inner.request('session.abort', { sessionId });
    } catch {
      // best-effort stop
    }
  }
}
