import { discoverIssuer } from './discovery.mjs';
import { AttemptStore } from './attempt-store.mjs';
import { createPkceAttempt } from './pkce-callback.mjs';
import { revokeToken } from './revocation.mjs';

export class OAuthManager {
  constructor({ vault, profiles = new Map(), fetchImpl = fetch } = {}) {
    this.vault = vault;
    this.profiles = profiles;
    this.fetchImpl = fetchImpl;
    this.attempts = new AttemptStore();
    this.inflight = new Map();
  }

  async begin(providerId) {
    return createPkceAttempt(this.attempts, { providerId });
  }

  getAttempt(attemptId) {
    return this.attempts.get(attemptId);
  }

  cancel(attemptId) {
    this.attempts.delete(attemptId);
    return { cancelled: true };
  }

  async getAccess(providerId) {
    const existing = this.inflight.get(providerId);
    if (existing) return existing;
    const pending = this.refreshIfNeeded(providerId).finally(() => this.inflight.delete(providerId));
    this.inflight.set(providerId, pending);
    return pending;
  }

  async disconnect(providerId) {
    const profile = this.profiles.get(providerId);
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

  async refreshIfNeeded(providerId) {
    const stored = await this.readTokens(providerId);
    if (!stored) {
      const error = new Error('needs_reauth');
      error.code = 'needs_reauth';
      throw error;
    }
    if (stored.expiresAt && Date.parse(stored.expiresAt) > Date.now() + 30_000) {
      return stored;
    }

    const profile = this.profiles.get(providerId);
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
    const payload = await response.json();
    if (!response.ok) {
      if (payload.error === 'invalid_grant') {
        await this.vault.delete(`oauth/${providerId}`);
      }
      const error = new Error(payload.error || 'refresh failed');
      error.code = payload.error === 'invalid_grant' ? 'needs_reauth' : payload.error;
      throw error;
    }

    const next = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || stored.refreshToken,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
      tokenType: payload.token_type,
    };
    await this.vault.set(`oauth/${providerId}`, JSON.stringify(next));
    return next;
  }

  async readTokens(providerId) {
    const raw = await this.vault.get(`oauth/${providerId}`);
    return raw ? JSON.parse(raw) : undefined;
  }
}
