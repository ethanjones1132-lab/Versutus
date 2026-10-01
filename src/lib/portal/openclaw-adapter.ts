// ─── OpenClaw adapter (Hermes-shaped surface over WS v4) ──────────
// Wraps the salvaged OpenClawGatewayClient so the provider can treat
// OpenClaw gateways like Hermes ones. Chat flows through the OpenClaw
// push event dialect (chat.send → chat events with delta/final/error).

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import type { ChatEventPayload } from '@/lib/gateway/openclaw-types';
import { APP_SESSION_SOURCE, extractMessageText } from '@/lib/gateway/messages';
import {
  normalizeOpenClawMessage,
  normalizeOpenClawModel,
  normalizeOpenClawSession,
  openClawCreateSessionParams,
  readOpenClawCollection,
  toOpenClawWsUrl,
} from '@/lib/portal/openclaw-mapping';
import type {
  ConnectionStatus,
  GatewayCapabilities,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  SessionMessage,
} from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import { keyValueStorage } from '@/lib/storage/key-value';

/**
 * Answer budget for `chat.send`. The wire is asked for the same 120s in the
 * params below; the client used to bound the RPC at its own 30s default, so a
 * gateway slower than that lost a run it was still working.
 */
export const CHAT_SEND_ACK_MS = 120_000;

/**
 * How long a pending chat may hear NOTHING — no delta, no final, no error —
 * before it is failed. The wire budget is 120s, so this is that plus grace: past
 * it the turn is not coming, and without a timer on the pending chat the
 * composer stayed locked until the operator pressed Stop.
 */
export const CHAT_STALL_MS = 150_000;

/** Run ids kept after a turn ends, so their stragglers cannot reach the next. */
const RETIRED_RUN_LIMIT = 8;

/** Session ids this app opened or adopted, remembered across a client rebuild. */
const OWNED_SESSION_LIMIT = 8;

/**
 * Where the owned ids live between adapter instances. The in-memory set dies
 * with the adapter, and the provider builds a fresh one on every re-attach and
 * hands it a COPY of the profile (`createClientForKind` → `profileWithAlternateIpv4`),
 * so a pin written on the profile object is never read back — the pin is inert
 * in production and only survives in a test that shares one mutable object.
 * Storage is the only thing that crosses the rebuild.
 */
export const OWNED_SESSIONS_KEY_PREFIX = 'versutus:openclaw-owned-sessions:';

/**
 * The provider's `streamChat` option surface, taken from the interface rather
 * than restated. The adapter used to declare `{model?, sessionId?, signal?}`,
 * which a bivariant method parameter accepted without a word: the provider
 * passes six more callbacks on every send and every one of them was dropped —
 * most visibly `onSession`, which is the only way this dialect can hand the
 * thread an id.
 */
type StreamChatOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;

type PendingChat = {
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  fullText: string;
  sessionId?: string;
  runId?: string;
  /** Set before the turn is handed to the wire; the exactly-once latch. */
  settled: boolean;
  detach?: () => void;
};

/** What a settled turn produced. */
type ChatOutcome = { text: string } | { error: Error };

/** Adapter knobs. Production takes every default; tests shorten the stall. */
export type OpenClawAdapterOptions = {
  chatStallMs?: number;
};

export class OpenClawAdapterClient implements PortalClient {
  private readonly inner: OpenClawGatewayClient;
  private profile: GatewayProfile;
  private readonly sessionKey?: string;
  private readonly agentId?: string;
  private pendingChat: PendingChat | null = null;
  private helloVersion?: string;
  private currentSessionId?: string;
  /** Session ids this app owns, so the gateway's own sessions stay foreign. */
  private readonly ownedSessionIds = new Set<string>();
  /** Whether the durable copy of `ownedSessionIds` has been read in yet. */
  private ownedSessionsLoaded = false;
  private ownedSessionsLoad: Promise<void> | null = null;
  /** Runs whose turn is over. `pendingChat` is one slot, so a straggler lands on it. */
  private readonly retiredRuns = new Set<string>();
  private readonly chatStallMs: number;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    profile: GatewayProfile,
    callbacks: PortalClientCallbacks = {},
    options: OpenClawAdapterOptions = {},
  ) {
    this.profile = profile;
    this.sessionKey = profile.sessionKey;
    this.agentId = profile.agentId;
    this.chatStallMs = options.chatStallMs ?? CHAT_STALL_MS;
    this.currentSessionId = profile.sessionId;
    this.rememberOwnedSession(profile.sessionId);
    this.inner = new OpenClawGatewayClient(
      { ...profile, url: toOpenClawWsUrl(profile.url) },
      {
        ...callbacks,
        // The caller's callback is still forwarded with all three arguments; the
        // wrapper is here because a turn in flight has to learn the path went
        // away. The `chat.send` RPC's own rejection cannot tell it: its pending
        // entry was resolved by the acknowledgement, so a drop between the ack
        // and the final left the promise pending for the life of the process.
        onStatus: (status, detail, info) => {
          callbacks.onStatus?.(status, detail, info);
          this.failChatOnStatusChange(status);
        },
        onHello: (hello) => {
          this.helloVersion = hello.server?.version;
          callbacks.onHello?.(hello);
          // The Hermes client publishes capabilities from connect(); this
          // transport has no such step, so fetch once the handshake lands.
          void this.getCapabilities()
            .then((capabilities) => callbacks.onCapabilities?.(capabilities))
            .catch(() => undefined);
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

  /**
   * Delegated: the provider reads this to tell "the gateway refused our
   * credential" (stop retrying, name the cause) from "the gateway is down".
   */
  get authRejected(): boolean {
    return this.inner.authRejected;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  setSessionId(id: string | undefined) {
    this.currentSessionId = id;
    this.rememberOwnedSession(id);
  }

  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
    this.inner.updateProfile({ ...profile, url: toOpenClawWsUrl(profile.url) });
  }

  connect(): void {
    this.inner.connect();
  }

  disconnect() {
    // Deliberately no profile pin here, though Hermes writes one (client.ts,
    // ManifestClient alike): the provider hands this adapter a COPY of the
    // profile (`createClientForKind` → `profileWithAlternateIpv4`) and never
    // calls `updateProfile`, so a pin on that object is read by nobody. The
    // owned ids live in storage instead, which is what actually survives the
    // rebuild — see `loadOwnedSessions`.
    this.inner.disconnect();
  }

  suspendReconnect() {
    this.inner.suspendReconnect();
  }

  resumeReconnect() {
    this.inner.resumeReconnect();
  }

  nudge(reason: string) {
    this.inner.nudge(reason);
  }

  forceReconnect() {
    this.inner.forceReconnect();
  }

  /**
   * A real probe, not the local status flag. Returning `{status:'ok'}` from a
   * flag the client itself sets made the provider's foreground heal treat a
   * half-open socket as verified — every request then failed on its own 30s
   * timer while nothing declared the gateway unreachable.
   */
  async healthCheck(timeoutMs?: number): Promise<HealthResponse | null> {
    if (this.inner.connectionStatus !== 'connected') return null;
    const alive = await this.inner.probeLiveness(timeoutMs);
    return alive
      ? { status: 'ok', platform: 'openclaw', version: this.helloVersion ?? 'unknown' }
      : null;
  }

  async rpcRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.inner.request<T>(method, params);
  }

  /** Same shape as the session reads: a failed catalogue throws, never `[]`. */
  async getModels(): Promise<ModelInfo[]> {
    const result = (await this.inner.request<unknown>('models.list')) as
      | unknown[]
      | { data?: unknown[] }
      | null;
    const list = readOpenClawCollection(result, ['models', 'items', 'data']);
    return list
      .map((item) => normalizeOpenClawModel(item))
      .filter((model): model is ModelInfo => model !== null);
  }

  /**
   * A failed read throws rather than answering `[]`. `resolveResumeSession`
   * declines to create a session only when the list THROWS — that is the
   * invariant its own comment states — so a swallowed timeout used to arrive as
   * "the gateway hosts no sessions" and every failure opened a fresh thread.
   */
  async getSessions(limit = 20): Promise<HermesSession[]> {
    // Before the list, so the tagging below knows which rows this app owns even
    // when this adapter instance is minutes old.
    await this.loadOwnedSessions();
    const result = await this.inner.request<unknown>('sessions.list', { limit });
    const list = readOpenClawCollection(result, ['sessions', 'items', 'data']);
    return list
      .map((item) => {
        const session = normalizeOpenClawSession(item);
        // `pickAppSession` only recognises APP_SESSION_SOURCE, and this dialect
        // stamped every row 'openclaw' — so no session this app owned could
        // ever match and every connect opened another. Only ids this app opened
        // or adopted are tagged; the gateway's own surfaces (TUI, cron, Discord)
        // stay foreign and are never adopted into the thread.
        return session && this.ownsSession(session.id) ? { ...session, source: APP_SESSION_SOURCE } : session;
      })
      .filter((session): session is HermesSession => session !== null);
  }

  async getCapabilities(): Promise<GatewayCapabilities> {
    const result = (await this.inner.request<unknown>('capabilities')) as
      | GatewayCapabilities
      | null
      | undefined;
    if (result) return result;
    throw new Error('Gateway did not return capabilities');
  }

  async createSession(title?: string, model?: string): Promise<HermesSession> {
    await this.loadOwnedSessions();
    const result = await this.inner.request<unknown>(
      'sessions.create',
      openClawCreateSessionParams({ title, model }),
    );
    const session = normalizeOpenClawSession(result);
    if (!session) throw new Error('Gateway did not return the created session');
    // A session this app opened is the thread from here on: adopting it here is
    // what lets the next list read recognise it and the next connect resume it.
    this.currentSessionId = session.id;
    this.rememberOwnedSession(session.id);
    return session;
  }

  /**
   * A failed history read throws for the same reason (`readHistory` produces
   * `{ok:false}` only when the read throws): returning `[]` folded a timeout
   * into a successfully empty transcript.
   */
  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    const result = await this.inner.request<unknown>('session.messages', { sessionId, limit });
    const list = readOpenClawCollection(result, ['messages', 'items', 'data']);
    return list
      .map((entry) => normalizeOpenClawMessage(entry))
      .filter((entry): entry is SessionMessage => entry !== null);
  }

  /**
   * `onToolCall`, `onReasoning`, `onTelemetryWarning`, `onModelReport` and
   * `onTurnId` are part of the surface this dialect has no frame for, so they
   * are accepted and never called — `onTurnId` in particular, because the
   * provider uses it to POST a cancel to the Gate, and this dialect's Stop goes
   * through `session.abort` instead. The options type is the interface's own, so
   * a new callback the provider starts passing cannot be dropped here in silence
   * again.
   */
  async streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: StreamChatOptions,
  ): Promise<string> {
    await this.loadOwnedSessions();
    const sessionId = options?.sessionId ?? this.currentSessionId;
    this.currentSessionId = sessionId;
    this.rememberOwnedSession(sessionId);

    const userMessage = [...messages].reverse().find((message) => message.role === 'user');
    const text = userMessage ? extractMessageText(userMessage.content).trim() : '';
    if (!text) return '';

    if (options?.signal?.aborted) {
      void this.abortChat(sessionId);
      throw new Error('Chat aborted');
    }

    return new Promise<string>((resolve, reject) => {
      // A second turn while one is pending would orphan the first promise
      // forever: the slot, and its stall timer, both belong to the newest.
      this.pendingChat &&
        this.settleChat(this.pendingChat, { error: new Error('Superseded by a newer turn') });

      const pending: PendingChat = { onDelta, resolve, reject, fullText: '', sessionId, settled: false };
      this.pendingChat = pending;

      const onAbort = () => {
        // The turn's own id, or one the gateway adopted mid-turn: aborting the
        // session the turn started on would leave the adopted run still running.
        void this.abortChat(pending.sessionId);
        this.settleChat(pending, { error: new Error('Chat aborted') });
      };
      const detach = () => options?.signal?.removeEventListener('abort', onAbort);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      pending.detach = detach;

      this.armStallTimer(pending);

      void this.inner
        .request(
          'chat.send',
          {
            sessionKey: this.sessionKey,
            agentId: this.agentId,
            sessionId,
            message: text,
            idempotencyKey: `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            timeoutMs: 120000,
          },
          CHAT_SEND_ACK_MS,
        )
        .then((ack: unknown) => {
          if (pending.settled) return;
          const acked = readChatAck(ack);
          if (acked.runId) {
            pending.runId = acked.runId;
            // A gateway that reuses one run id across a session's turns retires
            // that id at the end of every turn, so without this the NEXT turn's
            // acknowledgement would leave it retired and every frame of that
            // turn — deltas included — dropped as a straggler.
            this.retiredRuns.delete(acked.runId);
          }
          // A session the gateway adopted for this turn is reported nowhere else
          // on this dialect, and without it the thread stays sessionless: the
          // next turn opens another and this one is reachable only by history.
          if (acked.sessionId && acked.sessionId !== sessionId) {
            this.currentSessionId = acked.sessionId;
            pending.sessionId = acked.sessionId;
            this.rememberOwnedSession(acked.sessionId);
            options?.onSession?.(acked.sessionId);
          }
        })
        .catch((error: unknown) => {
          this.settleChat(pending, { error: error instanceof Error ? error : new Error(String(error)) });
        });
    });
  }

  async stopRun(_runId: string): Promise<void> {
    // OpenClaw aborts the current session's run rather than a run id.
    await this.abortChat(this.currentSessionId);
  }

  /**
   * The one door out of a pending turn, and the only place the slot is emptied.
   *
   * Exactly once: a frame that arrives after a reject (or a request failure
   * after a final) is a no-op rather than a second settle on a cleared slot.
   */
  private settleChat(pending: PendingChat, outcome: ChatOutcome) {
    if (pending.settled) return;
    pending.settled = true;
    this.clearStallTimer();
    pending.detach?.();
    if (this.pendingChat === pending) this.pendingChat = null;
    this.retireRun(pending.runId);
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.text);
  }

  /**
   * A turn dies with the path under it. Nothing else settles this: the
   * `chat.send` RPC's pending entry was already resolved by its acknowledgement,
   * so a drop between the ack and the final left the composer locked with no
   * error and the gateway's finished answer stranded on the other end. The
   * provider reconciles the bubble from gateway history on the next healthy
   * reconnect, which is why this rejects rather than hanging.
   */
  private failChatOnStatusChange(status: ConnectionStatus) {
    if (status !== 'reconnecting' && status !== 'disconnected' && status !== 'connecting') return;
    const pending = this.pendingChat;
    if (!pending) return;
    this.settleChat(pending, { error: new Error('Connection to the gateway was lost during the turn') });
  }

  /** (Re)arm the silence budget for a pending chat; any frame resets it. */
  private armStallTimer(pending: PendingChat) {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      // Best-effort: a gateway that stopped answering may still be running the
      // turn, so ask it to stop rather than leaving tokens burning.
      void this.abortChat(pending.sessionId);
      this.inner.nudge('chat stalled');
      // Reads as a connection failure to `isConnectionError`, so the provider
      // keeps the bubble and reconciles it from gateway history on the next
      // healthy reconnect instead of failing it.
      this.settleChat(pending, {
        error: new Error('The gateway connection stopped responding mid-turn'),
      });
    }, this.chatStallMs);
  }

  private clearStallTimer() {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /**
   * Remember a finished run so its late frames cannot reach the next turn.
   * Bounded: only a run still plausibly in flight can send stragglers.
   */
  private retireRun(runId?: string) {
    if (!runId) return;
    this.touch(this.retiredRuns, runId, RETIRED_RUN_LIMIT);
  }

  /**
   * Session ids this app owns. Seeded from the profile's pin, then every id the
   * app opened, adopted or pinned — the only evidence available here, since the
   * wire marks ownership for no other surface.
   */
  private rememberOwnedSession(id?: string) {
    const sessionId = id?.trim();
    if (!sessionId) return;
    this.touch(this.ownedSessionIds, sessionId, OWNED_SESSION_LIMIT);
    // Only once the durable copy is in: writing before the read would replace the
    // stored list with whatever this instance happens to know.
    if (this.ownedSessionsLoaded) this.persistOwnedSessions();
  }

  /**
   * Read the durable list, once per adapter. Best effort and never throws: a
   * missing or corrupt record only costs the rows in it, and the run continues
   * with the profile's pin and whatever it has handled since.
   */
  private loadOwnedSessions(): Promise<void> {
    this.ownedSessionsLoad ??= (async () => {
      try {
        const raw = await keyValueStorage.getItem(this.ownedSessionsKey());
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const id of parsed) {
              if (typeof id === 'string') this.rememberOwnedSession(id);
            }
          }
        }
      } catch {
        // best-effort: unknown ownership is not proof that a session is foreign
      }
      this.ownedSessionsLoaded = true;
      this.persistOwnedSessions();
    })();
    return this.ownedSessionsLoad;
  }

  private persistOwnedSessions() {
    const value = JSON.stringify([...this.ownedSessionIds]);
    void keyValueStorage
      .setItem(this.ownedSessionsKey(), value)
      .catch(() => {
        // best-effort: an unwritable store only narrows continuity next launch.
      });
  }

  private ownedSessionsKey(): string {
    return `${OWNED_SESSIONS_KEY_PREFIX}${this.profile.id}`;
  }

  private ownsSession(id: string): boolean {
    return this.ownedSessionIds.has(id);
  }

  /**
   * Mark `id` as the newest entry of a bounded set, dropping the oldest.
   *
   * The trim runs BEFORE the add, so the entry just touched can never be the one
   * evicted: a set already at the limit sheds its oldest, then the touched id
   * lands on the end as the newest.
   */
  private touch(set: Set<string>, id: string, limit: number) {
    set.delete(id);
    while (set.size >= limit) {
      const oldest = set.values().next().value;
      if (oldest === undefined || oldest === id) break;
      set.delete(oldest);
    }
    set.add(id);
  }

  private handleChatEvent(payload: ChatEventPayload) {
    const pending = this.pendingChat;
    if (!pending) return;
    // OpenClaw correlates events by runId, and `pendingChat` is a single slot:
    // without this a stopped run's late deltas were appended to the NEXT turn's
    // bubble and its late error rejected that turn. A frame carrying the pending
    // turn's OWN run id is unambiguously this turn's, so that is checked first —
    // the retired set is only consulted for a frame that does not match. A frame
    // with no runId, or a pending run whose id the acknowledgement never named,
    // behaves as before.
    if (payload.runId && pending.runId && payload.runId !== pending.runId) return;
    if (payload.runId && this.retiredRuns.has(payload.runId)) return;
    // Any frame at all is evidence the gateway is still answering this turn.
    this.armStallTimer(pending);

    const chunk = payload.deltaText ?? extractMessageText(payload.message?.content);
    if (payload.state === 'delta' && chunk) {
      pending.fullText += chunk;
      pending.onDelta(chunk);
      return;
    }
    if (payload.state === 'final') {
      this.settleChat(pending, { text: pending.fullText || chunk || '' });
      return;
    }
    if (payload.state === 'error') {
      this.settleChat(pending, {
        error: new Error(payload.errorMessage ?? payload.error ?? 'Chat failed on gateway'),
      });
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

/**
 * What the `chat.send` acknowledgement may carry. Both fields are read only if
 * the gateway sent them: nothing here is guessed, so a gateway that answers
 * with neither keeps behaving exactly as it did before.
 */
function readChatAck(ack: unknown): { runId?: string; sessionId?: string } {
  if (!ack || typeof ack !== 'object') return {};
  const raw = ack as Record<string, unknown>;
  return {
    runId: typeof raw.runId === 'string' && raw.runId ? raw.runId : undefined,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined,
  };
}
