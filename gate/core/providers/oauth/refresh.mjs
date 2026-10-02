import { discoverIssuer } from './discovery.mjs';
import { AttemptStore } from './attempt-store.mjs';
import { consumePkceAttempt, createPkceAttempt } from './pkce-callback.mjs';
import { revokeToken } from './revocation.mjs';

export class OAuthManager {
  constructor({ vault, profiles = new Map(), fetchImpl = fetch } = {}) {
    this.vault = vault;
    this.profiles = profiles;
    this.fetchImpl = fetchImpl;
    this.attempts = new AttemptStore();
    this.inflight = new Map();
  }

  async begin(providerId, { oauthProfileId } = {}) {
    const profileId = oauthProfileId || providerId;
    const profile = this.profiles.get(profileId);
    // Refused here rather than answered with an attempt that has nowhere to go:
    // every caller of `begin` reads `authorizationUrl`, and an attempt without
    // one left the phone holding a URL-less sheet until the attempt's own TTL
    // ended it. The profile map is keyed by `oauthProfileId`; the instance id
    // is only the vault key for the stored grant.
    if (!profile) {
      throw new Error(`this Gate ships no OAuth profile for provider "${profileId}"`);
    }
    const metadata = await discoverIssuer(profile.issuer, { fetchImpl: this.fetchImpl });
    const attempt = await createPkceAttempt(this.attempts, {
      providerId,
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: profile.clientId,
    });
    // The browser answers on the attempt's own loopback listener, so the code
    // arrives as `attempt.callback` -- and nothing was listening for it. The
    // attempt could only die on its TTL, `consumePkceAttempt` had no caller in
    // the Gate at all, and `providers.auth.attempt.get` never stopped saying the
    // authorization was still pending. Exchanging the code here is what puts a
    // token in the vault, and consuming the attempt is the signal the phone's
    // poll watches for ("Authorization finished").
    void this.exchangeCallback(attempt, { profile, metadata }).catch((error) => {
      console.error(`gate: the OAuth authorization for "${providerId}" did not complete (${error.message})`);
    });
    return attempt;
  }

  async exchangeCallback(attempt, { profile, metadata }) {
    try {
      const received = await attempt.callback;
      if (received.error) throw new Error(received.error);
      // The one-use, state-bound and expiry checks live here, and they need the
      // attempt to still be in the store -- which is why its own teardown leaves
      // a delivered one alone.
      const consumed = consumePkceAttempt(this.attempts, attempt.id, received.state);
      const response = await this.fetchImpl(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: received.code,
          redirect_uri: consumed.redirectUri,
          code_verifier: consumed.codeVerifier,
          client_id: profile.clientId,
        }),
      });
      // Status first, as everywhere else in this module: a token endpoint that
      // answers with an HTML error page must not become a SyntaxError.
      if (!response.ok) {
        throw new Error(`token exchange failed: ${response.status}`);
      }
      const payload = await response.json();
      await this.storeTokens(attempt.providerId, this.tokenRecord(payload));
      return payload;
    } finally {
      // Consumed, refused or expired, the attempt is over -- and "over" is what
      // the phone's poll is watching for.
      this.attempts.delete(attempt.id);
    }
  }

  getAttempt(attemptId) {
    return this.attempts.get(attemptId);
  }

  async cancel(attemptId) {
    const attempt = this.attempts.get(attemptId);
    if (attempt?.close) await attempt.close();
    this.attempts.delete(attemptId);
    return { cancelled: true };
  }

  async getAccess(providerId, { oauthProfileId } = {}) {
    const existing = this.inflight.get(providerId);
    if (existing) return existing;
    const pending = this.refreshIfNeeded(providerId, { oauthProfileId }).finally(() => this.inflight.delete(providerId));
    this.inflight.set(providerId, pending);
    return pending;
  }

  async disconnect(providerId, { oauthProfileId } = {}) {
    const profile = this.profiles.get(oauthProfileId || providerId);
    const stored = await this.readTokens(providerId);
    let remote = false;
    if (profile && stored?.refreshToken) {
      const metadata = await discoverIssuer(profile.issuer, { fetchImpl: this.fetchImpl }).catch(() => null);
      const result = await revokeToken({
        revocationEndpoint: metadata?.revocation_endpoint,
        token: stored.refreshToken,
        fetchImpl: this.fetchImpl,
      });
      remote = result.remote;
    }
    await this.vault.delete(`oauth/${providerId}`);
    return { disconnected: true, remote };
  }

  async refreshIfNeeded(providerId, { oauthProfileId } = {}) {
    const stored = await this.readTokens(providerId);
    if (!stored) {
      const error = new Error('needs_reauth');
      error.code = 'needs_reauth';
      throw error;
    }
    if (stored.expiresAt && Date.parse(stored.expiresAt) > Date.now() + 30_000) {
      return stored;
    }

    const profileId = oauthProfileId || providerId;
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`this Gate ships no OAuth profile for provider "${profileId}"`);
    }
    const metadata = await discoverIssuer(profile.issuer, { fetchImpl: this.fetchImpl });
    const response = await this.fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: profile.clientId,
      }),
    });
    // The status first, the way `discovery.mjs` reads it. A vendor, a proxy or a
    // captive portal answers a refusal with an HTML error page, an empty body or
    // plain text, and `response.json()` on those rejects with `SyntaxError:
    // Unexpected token '<'` before the branch below ever ran -- so an
    // `invalid_grant` did not delete the refresh token it had just invalidated.
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (payload.error === 'invalid_grant') {
        await this.vault.delete(`oauth/${providerId}`);
      }
      const error = new Error(payload.error || `refresh failed: ${response.status}`);
      error.code = payload.error === 'invalid_grant' ? 'needs_reauth' : payload.error;
      throw error;
    }
    const payload = await response.json();
    const next = this.tokenRecord(payload, stored);
    await this.storeTokens(providerId, next);
    return next;
  }

  /**
   * A token endpoint answer in the shape the rest of the Gate reads. `previous`
   * is the grant being exchanged, so a rotation that returns no new refresh
   * token keeps the one it already has.
   */
  tokenRecord(payload, previous) {
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || previous?.refreshToken,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
      tokenType: payload.token_type,
    };
  }

  // `oauth/<providerId>` is the one key both halves must agree on: this is what
  // a sign-in writes and what `disconnect` revokes, and it is what
  // `ProviderService.credentialPresent` has to ask about or a stored token is
  // invisible to the card that has to offer "Authorize".
  async storeTokens(providerId, tokens) {
    await this.vault.set(`oauth/${providerId}`, JSON.stringify(tokens));
    return tokens;
  }

  async readTokens(providerId) {
    const raw = await this.vault.get(`oauth/${providerId}`);
    return raw ? JSON.parse(raw) : undefined;
  }
}
