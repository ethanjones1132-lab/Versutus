import {
  assertLoopbackRedirect,
  assertLoopbackUrl,
  bindBodyDeadline,
  boundedSignal,
  MAX_REDIRECTS,
  readJsonLimited,
  releaseBodyDeadline,
} from './ssrf-policy.mjs';

const REQUIRED_ENDPOINTS = ['health', 'models', 'chat'];

export class ManifestClient {
  constructor({ manifestUrl, fetchImpl = fetch, timeoutMs } = {}) {
    this.manifestUrl = manifestUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async discover() {
    const response = await this.fetchLimited(this.manifestUrl);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      releaseBodyDeadline(response);
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

  async fetchLimited(url, init = {}, redirects = 0, ownedBounded = null) {
    assertLoopbackUrl(url);
    // Every caller but `chat` arrives with no signal of its own, and a loopback
    // server that accepts the connection and then says nothing left `discover`,
    // `health` and `listModels` unsettled for the life of the process — so
    // `service.check` parked that promise in `checkFlights` and every later
    // "Check" on that provider joined it. A caller that brought a signal (the
    // chat turn's own abort) keeps it: it is the only one that knows the client
    // is still there. The same clock has to cover the body: clearing it when
    // the Response object existed left a stall-after-headers hanging the same
    // way a silent accept did.
    const bounded = ownedBounded ?? (init.signal ? null : boundedSignal(this.timeoutMs));
    const signal = init.signal ?? bounded?.signal;
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          throw new Error('too many redirects');
        }
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect missing location');
        const next = assertLoopbackRedirect(location, url);
        await response.body?.cancel?.().catch(() => {});
        return await this.fetchLimited(next, init, redirects + 1, bounded);
      }
      bindBodyDeadline(response, bounded);
      return response;
    } catch (error) {
      bounded?.clear();
      // Reported as ETIMEDOUT so it classifies as a transient network fault
      // rather than as an unknown error, matching the remote profile path.
      if (bounded?.expired) {
        const timeout = new Error(`local provider did not answer within ${bounded.budgetMs}ms`);
        timeout.code = 'ETIMEDOUT';
        throw timeout;
      }
      throw error;
    }
  }
}
