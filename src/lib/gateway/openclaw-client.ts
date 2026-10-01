import { Platform } from 'react-native';

import { buildDeviceAuthPayloadV3 } from '@/lib/gateway/auth-payload';
import { clearDeviceAuthToken, loadDeviceAuthToken, saveDeviceAuthToken } from '@/lib/gateway/device-auth-token';
import { loadOrCreateDeviceIdentity, signDevicePayload } from '@/lib/gateway/device-identity';
import { DEVICE_IDENTITY_FAILURE, isDeviceIdentityError } from '@/lib/gateway/errors';
import { isIpv4 } from '@/lib/gateway/host-lookup';
import {
  ConnectionMonitor,
  hasRecentContact,
} from '@/lib/gateway/connection-monitor';
import type { ChatEventPayload, GatewayFrame } from '@/lib/gateway/openclaw-types';
import type {
  ConnectionStatus,
  GatewayHelloOk,
  GatewayProfile,
  HealthResponse,
  PairingDetails,
} from '@/lib/gateway/types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * A liveness probe settles on ANY answer, so a gateway that refuses the
   * method (`ok:false`, "unknown method") still counts as proof the socket is
   * alive. Ordinary requests keep rejecting on `ok:false`.
   */
  settleOnAnyResponse?: boolean;
};

export type GatewayClientCallbacks = {
  onStatus?: (status: ConnectionStatus, detail?: string, info?: { authRejected?: boolean }) => void;
  onHello?: (hello: GatewayHelloOk) => void;
  onPairingRequired?: (details: PairingDetails) => void;
  onChatEvent?: (payload: ChatEventPayload) => void;
  onError?: (message: string) => void;
  onHealthCheck?: (healthy: boolean, info?: HealthResponse) => void;
};

/**
 * Liveness budget for one probe. The wire has no health endpoint: the probe is
 * a `capabilities` round trip on the socket already in hand, so it only has to
 * outlast a tailnet RTT — and stay well under the 30s monitor interval so a
 * lost path is declared in seconds rather than half a minute.
 */
export const OPENCLAW_PROBE_TIMEOUT_MS = 5000;

/** The method the adapter already calls on connect — no new endpoint assumed. */
const PROBE_METHOD = 'capabilities';

const CLIENT_ID = 'openclaw-android';
const CLIENT_MODE = 'ui';
const SCOPES = ['operator.read', 'operator.write'];

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
  private connectInFlight = false;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectUsedStoredDeviceToken = false;
  private staleTokenRetryUsed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private identityPromise: ReturnType<typeof loadOrCreateDeviceIdentity> | null = null;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private authRejectedState = false;
  /** When the gateway last answered anything on this socket. Drives liveness. */
  private lastResponseAt = 0;
  /** The URL a socket last completed its handshake on; tried first next time. */
  private lastConnectedUrl: string | null = null;
  /** The URL the live socket was dialled on, remembered for handshake bookkeeping. */
  private activeSocketUrl = '';
  /** How many dials have gone by without one opening; rotates the dial address. */
  private dialCursor = 0;
  private readonly monitor: ConnectionMonitor;

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {
    // Reconnect policy is the shared monitor's (jittered backoff, escalation
    // to the provider's auto-retry after sustained failure), not a private
    // copy — roadmap 1.5. The wire has no /health, so the probe is a
    // `capabilities` round trip over the socket already open: any answer, even
    // a refusal, proves the path works. Without it a half-open socket (Wi-Fi
    // drop, silent tailnet path change) reads as 'connected' forever.
    this.monitor = new ConnectionMonitor({
      probe: () => this.probeLiveness(),
      recentlyServedUs: () => hasRecentContact(this.lastResponseAt, Date.now()),
      onStatus: (status, detail) => this.setStatus(status, detail),
      onDeclaredDown: () => this.callbacks.onHealthCheck?.(false),
      reconnect: async () => {
        if (!this.closed) this.openSocket();
      },
    });
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  /**
   * True while the last disconnect was the gateway refusing our credentials.
   * The provider sees that status before connect()'s rejection reaches it, so
   * without this signal a refused token is retried forever and its message is
   * erased by the next attempt.
   */
  get authRejected(): boolean {
    return this.authRejectedState;
  }

  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
  }

  connect() {
    this.closed = false;
    // A fresh attempt is the operator (or the provider's auto-retry) saying
    // "try again", so the previous refusal no longer speaks for this one.
    this.authRejectedState = false;
    this.monitor.stop(); // an explicit attempt starts a fresh retry ladder
    this.setStatus('connecting');
    this.openSocket();
  }

  disconnect() {
    this.closed = true;
    this.monitor.stop();
    this.monitor.resume(); // an explicit close clears any background suspension
    this.clearChallengeTimer();
    this.flushPending(new Error('Disconnected'));
    this.socket?.close();
    this.socket = null;
    this.staleTokenRetryUsed = false;
    this.setStatus('disconnected');
  }

  /**
   * Pause automatic reconnect (e.g. app backgrounded). The connection itself
   * is left alone; recovery happens on resumeReconnect()/foreground.
   */
  suspendReconnect() {
    this.monitor.suspend();
    this.clearChallengeTimer();
  }

  /**
   * Resume automatic reconnect and, if not connected, attempt immediately.
   */
  resumeReconnect() {
    this.monitor.resume();
    if (!this.closed && this.status !== 'connected') {
      this.connect();
    }
  }

  /**
   * Ask the monitor for a liveness verdict now, on the caller's own evidence
   * of trouble (a request that went unanswered, a stalled stream). Two quick
   * probes reach `reconnecting` in seconds instead of waiting out the 30s
   * interval — the WS twin of HttpTransport's onNetworkTrouble hook.
   */
  nudge(reason: string) {
    this.monitor.nudge(reason);
  }

  /**
   * Re-verify in place. For a caller that doubts a client which still claims
   * 'connected': rebuilding the client throws away a live connection to
   * re-earn the answer, and this re-runs the handshake on the existing one.
   */
  forceReconnect() {
    this.setStatus('reconnecting', 'Checking the connection');
    this.closed = false;
    this.openSocket();
  }

  /**
   * One liveness probe: `capabilities` on the socket already open, bounded by
   * OPENCLAW_PROBE_TIMEOUT_MS. ANY response frame settles it true — including
   * an `ok:false` refusal, which is a gateway talking, not a dead path. A
   * timeout, or no socket at all, settles it false.
   */
  async probeLiveness(timeoutMs = OPENCLAW_PROBE_TIMEOUT_MS): Promise<boolean> {
    if (!this.socket) return false;
    const id = randomId('probe');
    const frame = { type: 'req', id, method: PROBE_METHOD, params: {} };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: () => resolve(true),
        reject: () => resolve(false),
        timer,
        settleOnAnyResponse: true,
      });
      try {
        this.socket?.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(false);
      }
    });
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    await this.waitUntilConnected(timeoutMs);
    const id = randomId('req');
    const frame = { type: 'req', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A request unanswered for its whole budget is evidence of a dead path
        // the 30s interval cannot act on for another half-minute.
        this.nudge(`Request timed out: ${method}`);
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
    this.connectInFlight = false;
    this.connectUsedStoredDeviceToken = false;
    this.retireSocket();

    const url = this.nextDialUrl();
    let opened = false;
    this.activeSocketUrl = url;
    try {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        opened = true;
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
        // A dial that died before it ever opened is the shape a name that does
        // not resolve takes: the next rung tries the advertised tailnet IPv4.
        if (!opened && event.code === 1006) this.noteDialFailure();
        const failureDetail = !this.connectSent
          ? describeSocketFailure(url, event.code, event.reason)
          : event.reason || `Closed (${event.code})`;
        if (!this.connectSent) {
          this.callbacks.onError?.(failureDetail);
        }
        this.scheduleReconnect(failureDetail);
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteDialFailure();
      if (this.hasAlternateAddress()) {
        // The URL could not even be dialled, and there is a tailnet address
        // left to try: this attempt is a rung, not the end of the ladder.
        this.callbacks.onError?.(message);
        this.scheduleReconnect(message);
        return;
      }
      this.handleTerminalFailure(message);
    }
  }

  private hasAlternateAddress(): boolean {
    return ipv4SocketUrls(this.profile.url, this.profile.alternateIpv4 ?? []).length > 0;
  }

  /**
   * Every address this profile may be dialled on: the saved URL first, then its
   * advertised tailnet IPv4 rewrites (same port, path and scheme).
   */
  private dialUrls(): string[] {
    const urls = [this.profile.url, ...ipv4SocketUrls(this.profile.url, this.profile.alternateIpv4 ?? [])];
    // The address that last completed a handshake leads: a tailnet IPv4 that
    // proved itself over a MagicDNS name that was then failing must not be
    // re-proved by name on every reconnect.
    const remembered = this.lastConnectedUrl ? urls.indexOf(this.lastConnectedUrl) : -1;
    if (remembered <= 0) return urls;
    return [urls[remembered], ...urls.slice(0, remembered), ...urls.slice(remembered + 1)];
  }

  private nextDialUrl(): string {
    const urls = this.dialUrls();
    return urls[this.dialCursor % urls.length];
  }

  /**
   * Remember that a dial never opened, so the next attempt rotates onto the
   * next advertised address instead of repeating one that just missed.
   */
  private noteDialFailure() {
    this.dialCursor += 1;
  }

  private noteHandshakeComplete() {
    this.dialCursor = 0;
  }

  /**
   * Close out a lingering socket before its replacement opens.
   *
   * A second connect() (double-tap, resumeReconnect while still connecting)
   * used to overwrite `this.socket` and orphan the previous WebSocket — still
   * open, still delivering frames into shared handlers, still holding native
   * resources, and visible to the gateway as a phantom operator session.
   * Retirement detaches its handlers FIRST: its late close report must neither
   * flush the replacement's pending work nor schedule a ghost reconnect behind
   * the new attempt's back — the survivor owns recovery from here on.
   */
  private retireSocket() {
    const prior = this.socket;
    if (!prior) return;
    this.socket = null;
    prior.onopen = null;
    prior.onmessage = null;
    prior.onclose = null;
    prior.onerror = null;
    this.flushPending(new Error('Connection replaced by a newer attempt'));
    try {
      prior.close();
    } catch {
      // Already dead — there is nothing left to release.
    }
  }

  /**
   * Answer a connect.challenge with the signed connect frame.
   *
   * `connectSent` means "the connect frame is on the wire" and is claimed
   * only after every identity/token read and the signature succeeded, on a
   * socket that is still the live one. It used to be set before those
   * awaits, so a single rejected read left the client claiming a connect it
   * never sent: every later challenge was dropped (handleMessage) and the
   * handshake timeout disarmed itself against the same lying flag — the
   * session sat in "connecting" until the app restarted.
   */
  private async sendConnect(nonce: string) {
    if (this.connectSent || this.connectInFlight || !this.socket) return;
    const socket = this.socket;
    this.connectNonce = nonce;
    this.connectInFlight = true;

    try {
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

      if (this.socket !== socket || this.closed) {
        // The wire moved on mid-handshake; its close handler owns recovery.
        return;
      }
      this.connectSent = true;
      socket.send(JSON.stringify(frame));
    } catch (error) {
      // Nothing went out, so release the claim — the next challenge must be
      // able to retry instead of being dropped forever.
      this.connectSent = false;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(`Gateway handshake failed: ${message}`);
      if (this.socket === socket && !this.closed) {
        // A dead socket's close handler already scheduled the retry.
        this.scheduleReconnect(`Handshake failed: ${message}`);
      }
    } finally {
      this.connectInFlight = false;
    }
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
        this.monitor.noteConnected();
        this.staleTokenRetryUsed = false;
        this.lastConnectedUrl = this.activeSocketUrl || null;
        this.noteHandshakeComplete();
        this.setStatus('connected');
        const hello = frame.payload as GatewayHelloOk;
        // A failed write loses the pairing silently: the next connect presents
        // no device token and the operator has to approve pairing again. Say
        // so instead — without any storage or key text.
        void this.storeHelloDeviceToken(hello).catch(() => {
          this.callbacks.onError?.(
            'Could not save the gateway pairing token. Versutus will have to pair again.',
          );
        });
        this.callbacks.onHello?.(hello);
        // The provider's only reconnect-time trigger for re-reading the thread
        // and settling an interrupted turn. Fired here at the same point the
        // Hermes dialects fire it — after the handshake, before the probe
        // interval starts — so both dialects feed the same machinery.
        this.callbacks.onHealthCheck?.(true, this.healthReport(hello.server?.version));
        this.monitor.start();
      } else {
        const code = frame.error?.details?.code ?? frame.error?.code ?? 'CONNECT_FAILED';
        const message = frame.error?.message ?? 'Connect failed';
        if (code === 'PAIRING_REQUIRED' || code === 'DEVICE_IDENTITY_REQUIRED') {
          const details = readPairingDetails(frame.error?.details);
          this.callbacks.onPairingRequired?.(details);
          void this.getIdentity()
            .then((identity) => {
              this.setStatus('pairing', `Waiting for approval · ${identity.deviceId.slice(0, 12)}…`);
            })
            .catch((error) => {
              // The pairing callback already carries the request details; a
              // failed identity read must not leave 'connecting' forever — and
              // never leaks raw storage or key text into the status.
              const message = isDeviceIdentityError(error) ? error.message : DEVICE_IDENTITY_FAILURE;
              this.setStatus('pairing', message);
              this.callbacks.onError?.(message);
            });
        } else if (code === 'AUTH_DEVICE_TOKEN_MISMATCH' && this.connectUsedStoredDeviceToken && !this.staleTokenRetryUsed) {
          this.staleTokenRetryUsed = true;
          void this.getIdentity()
            .then((identity) => clearDeviceAuthToken(identity.deviceId, 'operator'))
            .catch(() => {
              // A failed clear is worth saying out loud, but the retry matters
              // more: a stale token the store could not drop still fails the
              // next connect, and that attempt has to happen.
              this.callbacks.onError?.(
                'Could not clear the stored pairing token. Versutus will retry the connection.',
              );
            })
            .finally(() => this.scheduleReconnect('Stored pairing token expired — retrying with fresh auth'));
        } else if (isGatewayAuthMissing(code)) {
          this.handleTerminalFailure('Gateway requires setup token or pairing approval', true);
        } else if (code === 'AUTH_DEVICE_TOKEN_MISMATCH') {
          // The single stale-token retry was already spent and the gateway
          // refused again: the credential is wrong, not stale, and no retry of
          // ours can fix it.
          this.handleTerminalFailure('Gateway rejected the pairing token. Pair the gateway again.', true);
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
    // Any answer is reachability evidence: an `ok:false` refusal still means
    // the frame reached a live gateway and one came back.
    this.lastResponseAt = Date.now();
    if (frame.ok) pending.resolve(frame.payload);
    else if (pending.settleOnAnyResponse) pending.resolve(frame.payload ?? null);
    else {
      pending.reject(new Error(frame.error?.message ?? 'Gateway request failed'));
    }
  }

  /**
   * Retry scheduling rides the shared ConnectionMonitor (roadmap 1.5): the
   * same jittered backoff and escalation-to-auto-retry policy as the Hermes
   * dialect, instead of a private fixed-ladder copy. Suspension is the
   * monitor's concern; closure is ours.
   */
  private scheduleReconnect(reason: string) {
    if (this.closed) return;
    this.monitor.scheduleReconnect(reason);
  }

  private handleTerminalFailure(message: string, authRejected = false) {
    this.closed = true;
    this.monitor.stop();
    this.clearChallengeTimer();
    this.flushPending(new Error(message));
    this.callbacks.onError?.(message);
    if (authRejected) this.authRejectedState = true;
    this.setStatus('disconnected', message, authRejected ? { authRejected: true } : undefined);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /**
   * The device identity, read once per client.
   *
   * A REJECTED read is not remembered: the memo held the same dead promise for
   * the life of the client, so every later handshake rung re-awaited one storage
   * fault and the app could not pair again until the provider happened to build
   * a fresh client. Clearing it on rejection lets the next rung retry the read.
   */
  private async getIdentity() {
    if (!this.identityPromise) {
      const attempt = loadOrCreateDeviceIdentity();
      this.identityPromise = attempt;
      void attempt.catch(() => {
        if (this.identityPromise === attempt) this.identityPromise = null;
      });
    }
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

  private clearChallengeTimer() {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
  }

  /** The health sample this dialect reports, shaped like the HTTP dialects'. */
  private healthReport(version?: string): HealthResponse {
    return { status: 'ok', platform: 'openclaw', version: version ?? 'unknown' };
  }

  private setStatus(status: ConnectionStatus, detail = '', info?: { authRejected?: boolean }) {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail, info);
  }
}

/**
 * The saved ws URL rewritten onto each advertised tailnet IPv4, keeping the
 * port, path and scheme.
 *
 * MagicDNS can miss for a moment on a phone while the tunnel address still
 * works, and a WebSocket dial has no retry seam of its own: without these the
 * only address ever tried is the name. ws:// is plain here — the TLS hostname
 * check does not apply to the tailnet wire this URL already used.
 */
function ipv4SocketUrls(url: string, alternateIpv4: string[]): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'ws:') return [];
  const port = parsed.port;
  const path = `${parsed.pathname}${parsed.search}`;
  const urls: string[] = [];
  for (const ip of alternateIpv4) {
    if (!isIpv4(ip) || ip === parsed.hostname) continue;
    urls.push(`ws://${ip}${port ? `:${port}` : ''}${path}`);
  }
  return urls;
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
