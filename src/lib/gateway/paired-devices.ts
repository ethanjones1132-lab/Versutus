/** One device that holds a token on this Gate. The token itself is never here. */
export type PairedDevice = {
  deviceId: string;
  role: string;
  scopes: string[];
  issuedAtMs: number;
  revoked: boolean;
};

/** What one device.list read produced. */
export type PairedDevicesRead = { ok: true; devices: PairedDevice[] } | { ok: false };

/**
 * Visible paired-device list after folding a read. Two failures are not the
 * same fact:
 *   - A failed FIRST read claims zero knowledge — not "no paired devices".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type PairedDevicesState = {
  devices: PairedDevice[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_PAIRED_DEVICES: PairedDevicesState = {
  devices: [],
  loaded: false,
  failed: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function parsePairedDevice(raw: unknown): PairedDevice | null {
  if (!isRecord(raw)) return null;
  const deviceId = (stringField(raw, 'deviceId') ?? stringField(raw, 'id') ?? '').trim();
  if (!deviceId) return null;
  const issuedAtMs = raw.issuedAtMs;
  return {
    deviceId,
    role: (stringField(raw, 'role') ?? '').trim(),
    scopes: parseScopes(raw.scopes),
    issuedAtMs: typeof issuedAtMs === 'number' && Number.isFinite(issuedAtMs) ? issuedAtMs : 0,
    revoked: raw.revoked === true,
  };
}

function deviceItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.devices)) return raw.devices;
  if (Array.isArray(raw.data)) return raw.data;
  return null;
}

/**
 * Parse a device.list payload. The Gate returns `{ devices }` with public
 * fields only. Anything else is a failed read — never an empty-ok list —
 * so a junk envelope cannot render as "no paired devices". A `token` field
 * on an item is dropped; it is not a public field.
 */
export function pairedDevicesReadFromUnknown(raw: unknown): PairedDevicesRead {
  const items = deviceItems(raw);
  if (!items) return { ok: false };
  const devices: PairedDevice[] = [];
  for (const item of items) {
    const device = parsePairedDevice(item);
    if (device) devices.push(device);
  }
  return { ok: true, devices };
}

export function applyPairedDevicesRead(
  previous: PairedDevicesState,
  read: PairedDevicesRead,
): PairedDevicesState {
  if (read.ok) return { devices: read.devices, loaded: true, failed: false };
  if (previous.loaded) return { devices: previous.devices, loaded: true, failed: true };
  return { devices: [], loaded: false, failed: true };
}

export function pairedDevicesToggleLabel(state: PairedDevicesState, open: boolean): string {
  if (open) return 'Hide paired devices';
  if (!state.loaded) return 'Paired devices';
  return `Paired devices (${state.devices.length})`;
}

export function pairedDevicesListCopy(state: PairedDevicesState): string | undefined {
  if (!state.loaded && state.failed) return 'Paired devices could not be read.';
  if (state.failed) return 'Could not re-read paired devices — showing the last list.';
  if (state.loaded && state.devices.length === 0) return 'No paired devices.';
  return undefined;
}

/**
 * The Gate is identified as kind `custom` (`versutus-gate` is not hermes
 * or openclaw). Hermes and OpenClaw have no device registry — showing
 * "could not be read" on those Home screens would be a lie about a
 * surface they never had.
 */
export function pairedDevicesVisibleOn(input: { kind?: string }): boolean {
  return input.kind === 'custom';
}

/** Title and subtitle for one row. Never includes a token. */
export function pairedDeviceRowCopy(device: PairedDevice): {
  title: string;
  subtitle: string;
  revoked: boolean;
} {
  const parts = [device.role, device.scopes.join(', ')].filter(Boolean);
  return {
    title: device.deviceId,
    subtitle: parts.join(' · '),
    revoked: device.revoked,
  };
}
