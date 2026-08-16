import {
  assertLoopbackRedirect,
  assertLoopbackUrl,
  MAX_REDIRECTS,
  readJsonLimited,
} from './ssrf-policy.mjs';

const REQUIRED_ENDPOINTS = ['health', 'models', 'chat'];

export class ManifestClient {
  constructor({ manifestUrl, fetchImpl = fetch } = {}) {
    this.manifestUrl = manifestUrl;
    this.fetchImpl = fetchImpl;
  }

  async discover() {
    const response = await this.fetchLimited(this.manifestUrl);
    if (!response.ok) {
      throw new Error(`manifest discovery failed: ${response.status}`);
    }
    const manifest = await readJsonLimited(response);
    if (manifest.spec !== 'versutus-provider/v1') {
      throw new Error(`incompatible spec version: ${manifest.spec}`);
    }
    if (!manifest.endpoints || typeof manifest.endpoints !== 'object') {
      throw new Error('manifest endpoints are missing');
    }
    for (const name of REQUIRED_ENDPOINTS) {
      if (!manifest.endpoints[name]) {
        throw new Error(`manifest is missing ${name} endpoint`);
      }
    }
    return manifest;
  }

  async fetchLimited(url, init = {}, redirects = 0) {
    assertLoopbackUrl(url);
    const response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error('too many redirects');
      }
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect missing location');
      const next = assertLoopbackRedirect(location, url);
      return this.fetchLimited(next, init, redirects + 1);
    }
    return response;
  }
}
