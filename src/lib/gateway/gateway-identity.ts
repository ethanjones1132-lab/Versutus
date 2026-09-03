import {
  manifestCapabilityList,
  manifestKindLabel,
  type GatewayManifest,
} from '@/lib/portal/manifest';

export type GatewayIdentityRow = {
  label: string;
  value: string;
};

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read-only identity rows from the already-held manifest. Only fields the
 * Gate actually reported become rows — an older Gate that omits a field
 * simply contributes no row, so the block can never print a blank value.
 * The kind row always renders: `manifestKindLabel` names every kind,
 * including custom ones.
 */
export function gatewayIdentityRows(
  manifest: GatewayManifest | null,
): GatewayIdentityRow[] {
  if (!manifest) return [];
  const rows: GatewayIdentityRow[] = [];
  const name = text(manifest.name);
  if (name) rows.push({ label: 'Name', value: name });
  rows.push({ label: 'Gateway', value: manifestKindLabel(manifest) });
  const version = text(manifest.version);
  if (version) rows.push({ label: 'Version', value: version });
  const vendor = text(manifest.vendor);
  if (vendor) rows.push({ label: 'Vendor', value: vendor });
  if (manifest.capabilities && typeof manifest.capabilities === 'object') {
    const enabled = manifestCapabilityList(manifest);
    rows.push({
      label: 'Capabilities',
      value: enabled.length > 0 ? enabled.join(', ') : 'none enabled',
    });
  }
  return rows;
}

/**
 * The honest unknown note for fields the Gate did not report. Null when the
 * manifest is complete — a missing note means nothing is missing, so the
 * block never has to claim "none" for something merely absent.
 */
export function gatewayIdentityUnknownNote(
  manifest: GatewayManifest | null,
): string | null {
  if (!manifest) return 'This Gate did not report its identity.';
  const missing: string[] = [];
  if (!text(manifest.name)) missing.push('name');
  if (!text(manifest.version)) missing.push('version');
  if (!text(manifest.vendor)) missing.push('vendor');
  if (!manifest.capabilities || typeof manifest.capabilities !== 'object') {
    missing.push('capability flags');
  }
  if (missing.length === 0) return null;
  return `Not reported by this Gate: ${missing.join(', ')}.`;
}
