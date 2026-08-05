import { Platform } from 'react-native';

import { buildDeviceAuthPayloadV3 } from '@/lib/gateway/auth-payload';
import { clearDeviceAuthToken, loadDeviceAuthToken, saveDeviceAuthToken } from '@/lib/gateway/device-auth-token';
import { loadOrCreateDeviceIdentity, signDevicePayload } from '@/lib/gateway/device-identity';
import type { ChatEventPayload, GatewayFrame } from '@/lib/gateway/openclaw-types';
import type { ConnectionStatus, GatewayHelloOk, GatewayProfile, PairingDetails } from '@/lib/gateway/types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type GatewayClientCallbacks = {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onHello?: (hello: GatewayHelloOk) => void;
  onPairingRequired?: (details: PairingDetails) => void;
  onChatEvent?: (payload: ChatEventPayload) => void;
  onError?: (message: string) => void;
};

const CLIENT_ID = 'openclaw-android';
const CLIENT_MODE = 'ui';
const SCOPES = ['operator.read', 'operator.write'];
const MAX_RECONNECT_ATTEMPTS = 12;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function describeSocketFailure(url: string, code: number, reason: string): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  if (code === 1006) {
    return `Could not reach gateway at ${host}. It may still be starting — Versutus will retry automatically.`;
  }
  if (code === 1005) {
    return `Gateway at ${host} closed before handshake completed. Retry in a moment.`;
  }
  if (reason.trim()) {
    return `Gateway connection failed (${code}): ${reason}`;
  }
  return `Could not connect to gateway at ${host} (${code || 'error'}). Check that OpenClaw is running.`;
}

/**
 * OpenClaw Gateway Client (WebSocket wire protocol v4).
 *
 * Salvaged from git HEAD during the Hermes-HTTP migration and kept as the
 * OpenClaw adapter so the portal can connect to OpenClaw gateways.
 * Connects to the WS URL directly (e.g. ws://host:8642/openclaw), performs
 * the challenge/response handshake with the Ed25519 device identity, stores
 * device tokens, and speaks JSON-RPC frames.
 */
export class OpenClawGatewayClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private connectNonce = '';
  private connectSent = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectUsedStoredDeviceToken = false;
  private staleTokenRetryUsed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private identityPromise: ReturnType<typeof loadOrCreateDeviceIdentity> | null = null;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {}

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
  }

  connect() {
    this.closed = false;
    this.clearReconnectTimer();
    this.setStatus('connecting');
    this.openSocket();
  }

  disconnect() {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearChallengeTimer();
    this.flushPending(new Error('Disconnected'));
    this.socket?.close();
    this.socket = null;
    this.staleTokenRetryUsed = false;
    this.setStatus('disconnected');
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    await this.waitUntilConnected(timeoutMs);
    const id = randomId('req');
    const frame = { type: 'req', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket?.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async waitUntilConnected(timeoutMs: number) {
    const started = Date.now();
    while (this.status !== 'connected') {
      if (this.closed) throw new Error('Not connected');
      if (Date.now() - started > timeoutMs) throw new Error('Gateway not connected');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private openSocket() {
    this.clearChallengeTimer();
    this.connectNonce = '';
    this.connectSent = false;
    this.connectUsedStoredDeviceToken = false;

    try {
      const socket = new WebSocket(this.profile.url);
      this.socket = socket;

      socket.onopen = () => {
        this.challengeTimer = setTimeout(() => {
          if (!this.connectSent) {
            this.handleTerminalFailure('Gateway handshake timed out');
          }
        }, 12000);
      };

      socket.onmessage = (event) => {
        this.handleMessage(String(event.data));
      };

      socket.onclose = (event) => {
        if (this.socket === socket) this.socket = null;
        this.clearChallengeTimer();
        this.flushPending(new Error(`Gateway closed (${event.code})`));
        if (this.closed) {
          this.setStatus('disconnected');
          return;
        }
        const failureDetail = !this.connectSent
          ? describeSocketFailure(this.profile.url, event.code, event.reason)
          : event.reason || `Closed (${event.code})`;
        if (!this.connectSent) {
          this.callbacks.onError?.(failureDetail);
        }
        this.scheduleReconnect(failureDetail);
      };
    } catch (error) {
      this.handleTerminalFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private async sendConnect(nonce: string) {
    if (this.connectSent || !this.socket) return;
    this.connectNonce = nonce;
    this.connectSent = true;

    const identity = await this.getIdentity();
    const signedAtMs = Date.now();
    const role = 'operator';
    const storedAuth = await loadDeviceAuthToken(identity.deviceId, role);
    const deviceToken = storedAuth?.token;
    const setupToken = this.profile.token;
    const resolvedToken = deviceToken ?? setupToken;
    const bootstrapToken = resolvedToken ? undefined : this.profile.bootstrapToken;
    const signatureToken = resolvedToken ?? bootstrapToken;
    const usingStoredDeviceToken = !!deviceToken;
    const scopes = usingStoredDeviceToken && storedAuth.scopes.length > 0 ? storedAuth.scopes : SCOPES;
    this.connectUsedStoredDeviceToken = usingStoredDeviceToken;

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role,
      scopes,
      signedAtMs,
      token: signatureToken,
      nonce,
      platform: Platform.OS,
    });
    const signature = await signDevicePayload(identity, payload);

    const frame = {
      type: 'req',
      id: 'connect',
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: CLIENT_ID,
          version: '1.0.0',
          platform: Platform.OS,
          mode: CLIENT_MODE,
        },
        role,
        scopes,
        caps: [],
        auth: resolvedToken || bootstrapToken
          ? {
              token: usingStoredDeviceToken ? undefined : setupToken,
              bootstrapToken,
              deviceToken: usingStoredDeviceToken ? deviceToken : undefined,
            }
          : undefined,
        locale: 'en-US',
        userAgent: 'versutus/1.0.0',
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKeyB64Url,
          signature,
          signedAt: signedAtMs,
          nonce: this.connectNonce,
        },
      },
    };

    this.socket.send(JSON.stringify(frame));
  }

  private handleMessage(raw: string) {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        if (this.connectSent) return;
        const payload = frame.payload as { nonce?: string } | undefined;
        if (payload?.nonce) {
          void this.sendConnect(payload.nonce);
        }
        return;
      }
      if (frame.event === 'chat') {
        this.callbacks.onChatEvent?.((frame.payload ?? {}) as ChatEventPayload);
      }
      return;
    }

    if (frame.type !== 'res') return;

    if (frame.id === 'connect') {
      this.clearChallengeTimer();
      if (frame.ok) {
        this.reconnectAttempts = 0;
        this.staleTokenRetryUsed = false;
        this.setStatus('connected');
        const hello = frame.payload as GatewayHelloOk;
        void this.storeHelloDeviceToken(hello);
        this.callbacks.onHello?.(hello);
      } else {
        const code = frame.error?.details?.code ?? frame.error?.code ?? 'CONNECT_FAILED';
        const message = frame.error?.message ?? 'Connect failed';
        if (code === 'PAIRING_REQUIRED' || code === 'DEVICE_IDENTITY_REQUIRED') {
          const details = readPairingDetails(frame.error?.details);
          this.callbacks.onPairingRequired?.(details);
          void this.getIdentity().then((identity) => {
            this.setStatus('pairing', `Waiting for approval · ${identity.deviceId.slice(0, 12)}…`);
          });
        } else if (code === 'AUTH_DEVICE_TOKEN_MISMATCH' && this.connectUsedStoredDeviceToken && !this.staleTokenRetryUsed) {
          this.staleTokenRetryUsed = true;
          void this.getIdentity()
            .then((identity) => clearDeviceAuthToken(identity.deviceId, 'operator'))
            .finally(() => this.scheduleReconnect('Stored pairing token expired — retrying with fresh auth'));
        } else if (isGatewayAuthMissing(code)) {
          this.handleTerminalFailure('Gateway requires setup token or pairing approval');
        } else {
          this.handleTerminalFailure(message || 'Gateway connection failed. Check logs or retry.');
        }
      }
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.payload);
    else {
      pending.reject(new Error(frame.error?.message ?? 'Gateway request failed'));
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.closed) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('disconnected', reason);
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 15000);
    this.setStatus('reconnecting', `${reason} · retry in ${Math.round(delay / 1000)}s`);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private handleTerminalFailure(message: string) {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearChallengeTimer();
    this.flushPending(new Error(message));
    this.callbacks.onError?.(message);
    this.setStatus('disconnected', message);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private async getIdentity() {
    if (!this.identityPromise) this.identityPromise = loadOrCreateDeviceIdentity();
    return this.identityPromise;
  }

  private async storeHelloDeviceToken(hello: GatewayHelloOk) {
    const token = hello.auth?.deviceToken;
    if (!token) return;
    const identity = await this.getIdentity();
    await saveDeviceAuthToken({
      deviceId: identity.deviceId,
      role: hello.auth?.role ?? 'operator',
      token,
      scopes: hello.auth?.scopes ?? SCOPES,
    });
  }

  private flushPending(error: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearChallengeTimer() {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
  }

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isGatewayAuthMissing(code: unknown): boolean {
  return code === 'AUTH_TOKEN_MISSING' || code === 'AUTH_TOKEN_NOT_CONFIGURED';
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  return values.length > 0 ? values : undefined;
}

function readPairingDetails(details: unknown): PairingDetails {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const raw = details as Record<string, unknown>;
  return {
    reason: readString(raw.reason) as PairingDetails['reason'],
    requestId: readString(raw.requestId),
    remediationHint: readString(raw.remediationHint),
    requestedRole: readString(raw.requestedRole),
    requestedScopes: readStringList(raw.requestedScopes),
    approvedRoles: readStringList(raw.approvedRoles),
    approvedScopes: readStringList(raw.approvedScopes),
  };
}
