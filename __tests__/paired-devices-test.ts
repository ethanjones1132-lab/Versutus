import {
  applyPairedDevicesRead,
  EMPTY_PAIRED_DEVICES,
  pairedDeviceRowCopy,
  pairedDevicesListCopy,
  pairedDevicesReadFromUnknown,
  pairedDevicesToggleLabel,
  pairedDevicesVisibleOn,
  type PairedDevice,
} from '@/lib/gateway/paired-devices';

const PHONE: PairedDevice = {
  deviceId: 'abc123',
  role: 'operator',
  scopes: ['operator.read', 'chat:send'],
  issuedAtMs: 1_700_000_000_000,
  revoked: false,
};

const TABLET: PairedDevice = {
  deviceId: 'def456',
  role: 'operator',
  scopes: ['operator.read'],
  issuedAtMs: 1_700_000_100_000,
  revoked: true,
};

test('a Gate { devices } envelope becomes the public fields, never a token', () => {
  const read = pairedDevicesReadFromUnknown({
    devices: [
      {
        deviceId: 'abc123',
        token: 'must-not-survive',
        role: 'operator',
        scopes: ['operator.read', 'chat:send'],
        issuedAtMs: 1_700_000_000_000,
        revoked: false,
      },
    ],
  });
  expect(read).toEqual({ ok: true, devices: [PHONE] });
  if (read.ok) {
    expect(Object.keys(read.devices[0]).sort()).toEqual(
      ['deviceId', 'issuedAtMs', 'revoked', 'role', 'scopes'].sort(),
    );
  }
});

test('a { data } envelope unwraps the same way other list reads do', () => {
  const read = pairedDevicesReadFromUnknown({
    data: [
      {
        deviceId: 'def456',
        role: 'operator',
        scopes: ['operator.read'],
        issuedAtMs: 1_700_000_100_000,
        revoked: true,
      },
    ],
  });
  expect(read).toEqual({ ok: true, devices: [TABLET] });
});

test('a raw array is empty-ok when this Gate really has none', () => {
  expect(pairedDevicesReadFromUnknown([])).toEqual({ ok: true, devices: [] });
  expect(pairedDevicesReadFromUnknown({ devices: [] })).toEqual({ ok: true, devices: [] });
  expect(pairedDevicesReadFromUnknown({ data: [] })).toEqual({ ok: true, devices: [] });
});

test('a device named only by id still parses', () => {
  const read = pairedDevicesReadFromUnknown({ devices: [{ deviceId: 'abc123' }] });
  expect(read).toEqual({
    ok: true,
    devices: [{ deviceId: 'abc123', role: '', scopes: [], issuedAtMs: 0, revoked: false }],
  });
});

test('id is accepted as deviceId, matching the store\'s sibling fields', () => {
  const read = pairedDevicesReadFromUnknown({ devices: [{ id: 'abc123', role: 'operator' }] });
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.devices[0].deviceId).toBe('abc123');
});

test('nameless and non-object items are dropped, not a failed read', () => {
  const read = pairedDevicesReadFromUnknown([
    null,
    42,
    { role: 'operator' },
    { deviceId: '  ' },
    {
      deviceId: 'abc123',
      role: 'operator',
      scopes: ['operator.read', 'chat:send'],
      issuedAtMs: 1_700_000_000_000,
      revoked: false,
    },
  ]);
  expect(read).toEqual({ ok: true, devices: [PHONE] });
});

test('non-string scopes and a non-number issuedAtMs do not poison the row', () => {
  const read = pairedDevicesReadFromUnknown({
    devices: [
      {
        deviceId: 'abc123',
        role: 'operator',
        scopes: ['operator.read', 12, null, 'chat:send'],
        issuedAtMs: 'yesterday',
        revoked: 'nope',
      },
    ],
  });
  expect(read).toEqual({
    ok: true,
    devices: [
      {
        deviceId: 'abc123',
        role: 'operator',
        scopes: ['operator.read', 'chat:send'],
        issuedAtMs: 0,
        revoked: false,
      },
    ],
  });
});

test('an unparseable payload is a failed read, not "no paired devices"', () => {
  expect(pairedDevicesReadFromUnknown(null).ok).toBe(false);
  expect(pairedDevicesReadFromUnknown('nope').ok).toBe(false);
  expect(pairedDevicesReadFromUnknown({ error: 'boom' }).ok).toBe(false);
});

test('a token-only envelope is a failed read — that is not a device list', () => {
  expect(pairedDevicesReadFromUnknown({ token: 'leak' }).ok).toBe(false);
});

test('a failed FIRST read claims zero knowledge — not an empty list', () => {
  const next = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, { ok: false });
  expect(next.devices).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(pairedDevicesToggleLabel(next, false)).toBe('Paired devices');
  expect(pairedDevicesToggleLabel(next, false)).not.toContain('0');
  expect(pairedDevicesListCopy(next)).toBe('Paired devices could not be read.');
});

test('a failed RE-read keeps the last good list and names the staleness', () => {
  const loaded = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, { ok: true, devices: [PHONE, TABLET] });
  const stale = applyPairedDevicesRead(loaded, { ok: false });
  expect(stale.devices).toEqual([PHONE, TABLET]);
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(pairedDevicesToggleLabel(stale, false)).toBe('Paired devices (2)');
  expect(pairedDevicesListCopy(stale)).toBe('Could not re-read paired devices — showing the last list.');
});

test('a successful EMPTY read is believed — this Gate really has none now', () => {
  const previous = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, { ok: true, devices: [PHONE] });
  const next = applyPairedDevicesRead(previous, { ok: true, devices: [] });
  expect(next).toEqual({ devices: [], loaded: true, failed: false });
  expect(pairedDevicesToggleLabel(next, false)).toBe('Paired devices (0)');
  expect(pairedDevicesListCopy(next)).toBe('No paired devices.');
});

test('a successful refresh replaces the list', () => {
  const previous = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, { ok: true, devices: [PHONE] });
  const next = applyPairedDevicesRead(previous, { ok: true, devices: [TABLET] });
  expect(next.devices).toEqual([TABLET]);
  expect(next.failed).toBe(false);
});

test('the open toggle hides the count the way Skills does', () => {
  const loaded = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, { ok: true, devices: [PHONE] });
  expect(pairedDevicesToggleLabel(loaded, true)).toBe('Hide paired devices');
  expect(pairedDevicesToggleLabel(EMPTY_PAIRED_DEVICES, false)).toBe('Paired devices');
  expect(pairedDevicesListCopy(EMPTY_PAIRED_DEVICES)).toBeUndefined();
});

test('the pane belongs on a Gate, not a Hermes or OpenClaw host', () => {
  expect(pairedDevicesVisibleOn({ kind: 'custom' })).toBe(true);
  expect(pairedDevicesVisibleOn({ kind: 'hermes' })).toBe(false);
  expect(pairedDevicesVisibleOn({ kind: 'openclaw' })).toBe(false);
  expect(pairedDevicesVisibleOn({ kind: 'unknown' })).toBe(false);
  expect(pairedDevicesVisibleOn({})).toBe(false);
});

test('a row never copies the token, even when the payload still had one', () => {
  const copy = pairedDeviceRowCopy(PHONE);
  expect(copy.title).toBe('abc123');
  expect(copy.subtitle).toContain('operator');
  expect(copy.subtitle).toContain('operator.read');
  expect(copy.subtitle.toLowerCase()).not.toContain('token');
  expect(copy.revoked).toBe(false);
  expect(pairedDeviceRowCopy(TABLET).revoked).toBe(true);
});
