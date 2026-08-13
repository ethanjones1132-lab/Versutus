import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * Origin that serves the well-known manifest and root-only routes
 * (capabilitiesRpc, sessions, runs). A provider child URL is parent + /p/{id}.
 */
export function gatewayRootUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/p\/[^/]+\/?$/, '') || '/';
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return url.replace(/\/p\/[^/]+\/?$/, '').replace(/\/+$/, '');
  }
}

export function manifestUrlForGateway(
  gateway: Pick<GatewayProfile, 'url' | 'parentId'>,
  parentUrl?: string | null,
): string {
  if (gateway.parentId) {
    return parentUrl && parentUrl.length > 0 ? parentUrl.replace(/\/+$/, '') : gatewayRootUrl(gateway.url);
  }
  return gateway.url.replace(/\/+$/, '');
}
