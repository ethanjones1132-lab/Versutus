import {
  applyToolsetsRead,
  EMPTY_TOOLSETS,
  toolsetsListCopy,
  toolsetsListParams,
  toolsetsReadFromUnknown,
  toolsetsToggleLabel,
  toolsetsVisibleOn,
  type Toolset,
} from '@/lib/gateway/toolsets';

const FS: Toolset = { name: 'fs', description: 'read, write' };
const BROWSER: Toolset = { name: 'browser', description: 'Fetch a page' };

test('a Gate { toolsets } envelope becomes name plus description', () => {
  const read = toolsetsReadFromUnknown({
    toolsets: [{ id: 'fs', tools: ['read', 'write'] }],
  });
  expect(read).toEqual({ ok: true, toolsets: [FS] });
});

test('a { data } envelope unwraps the same way getToolsets already does', () => {
  const read = toolsetsReadFromUnknown({
    data: [{ name: 'browser', description: 'Fetch a page' }],
  });
  expect(read).toEqual({ ok: true, toolsets: [BROWSER] });
});

test('a raw array is empty-ok when the host really has none', () => {
  expect(toolsetsReadFromUnknown([])).toEqual({ ok: true, toolsets: [] });
  expect(toolsetsReadFromUnknown({ toolsets: [] })).toEqual({ ok: true, toolsets: [] });
  expect(toolsetsReadFromUnknown({ data: [] })).toEqual({ ok: true, toolsets: [] });
});

test('a toolset named only by id still parses', () => {
  const read = toolsetsReadFromUnknown({ toolsets: [{ id: 'fs' }] });
  expect(read).toEqual({ ok: true, toolsets: [{ name: 'fs', description: '' }] });
});

test('nameless and non-object items are dropped, not a failed read', () => {
  const read = toolsetsReadFromUnknown([
    null,
    42,
    { description: 'no name' },
    { name: '  ' },
    { name: 'browser', description: 'Fetch a page' },
  ]);
  expect(read).toEqual({ ok: true, toolsets: [BROWSER] });
});

test('an unparseable payload is a failed read, not "no tools"', () => {
  expect(toolsetsReadFromUnknown(null).ok).toBe(false);
  expect(toolsetsReadFromUnknown('nope').ok).toBe(false);
  expect(toolsetsReadFromUnknown({ error: 'boom' }).ok).toBe(false);
});

test('plugins.list is not a toolsets catalog — a { plugins } envelope fails', () => {
  expect(toolsetsReadFromUnknown({ plugins: [{ id: 'fs' }] }).ok).toBe(false);
});

test('a failed FIRST read claims zero knowledge — not an empty list', () => {
  const next = applyToolsetsRead(EMPTY_TOOLSETS, { ok: false });
  expect(next.toolsets).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(toolsetsToggleLabel(next, false)).toBe('Tools');
  expect(toolsetsToggleLabel(next, false)).not.toContain('0');
  expect(toolsetsListCopy(next)).toBe('Tools could not be read.');
});

test('a failed RE-read keeps the last good list and names the staleness', () => {
  const loaded = applyToolsetsRead(EMPTY_TOOLSETS, { ok: true, toolsets: [FS, BROWSER] });
  const stale = applyToolsetsRead(loaded, { ok: false });
  expect(stale.toolsets).toEqual([FS, BROWSER]);
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(toolsetsToggleLabel(stale, false)).toBe('Tools (2)');
  expect(toolsetsListCopy(stale)).toBe('Could not re-read tools — showing the last list.');
});

test('a successful EMPTY read is believed — the host really has none now', () => {
  const previous = applyToolsetsRead(EMPTY_TOOLSETS, { ok: true, toolsets: [FS] });
  const next = applyToolsetsRead(previous, { ok: true, toolsets: [] });
  expect(next).toEqual({ toolsets: [], loaded: true, failed: false });
  expect(toolsetsToggleLabel(next, false)).toBe('Tools (0)');
  expect(toolsetsListCopy(next)).toBe('No tools.');
});

test('a successful refresh replaces the list', () => {
  const previous = applyToolsetsRead(EMPTY_TOOLSETS, { ok: true, toolsets: [FS] });
  const next = applyToolsetsRead(previous, { ok: true, toolsets: [BROWSER] });
  expect(next.toolsets).toEqual([BROWSER]);
  expect(next.failed).toBe(false);
});

test('the open toggle hides the count the way Skills does', () => {
  const loaded = applyToolsetsRead(EMPTY_TOOLSETS, { ok: true, toolsets: [FS] });
  expect(toolsetsToggleLabel(loaded, true)).toBe('Hide tools');
  expect(toolsetsToggleLabel(EMPTY_TOOLSETS, false)).toBe('Tools');
  expect(toolsetsListCopy(EMPTY_TOOLSETS)).toBeUndefined();
});

test('the tools pane belongs on configurable chat, not only Bot Chat', () => {
  expect(toolsetsVisibleOn({ kind: 'configurable' })).toBe(true);
  expect(toolsetsVisibleOn({ kind: 'bot' })).toBe(true);
  expect(toolsetsVisibleOn({ kind: 'roster' })).toBe(false);
  expect(toolsetsVisibleOn({ kind: 'group' })).toBe(false);
});

test('configurable chat pins tools.list to this backend', () => {
  expect(toolsetsListParams({ surfaceKind: 'configurable', backendId: 'codex-local' })).toEqual({
    backendId: 'codex-local',
  });
});

test('a backend that cannot list toolsets is still a pin, so the throw is a failed read', () => {
  expect(toolsetsListParams({ surfaceKind: 'configurable', backendId: 'claude-local' })).toEqual({
    backendId: 'claude-local',
  });
});

test('Bot Chat does not pin tools.list — Bots live on Hermes, not the configurable-chat backend', () => {
  expect(toolsetsListParams({ surfaceKind: 'bot', backendId: 'codex-local' })).toEqual({});
});

test('configurable chat with no backend selected leaves the Gate to resolve', () => {
  expect(toolsetsListParams({ surfaceKind: 'configurable', backendId: undefined })).toEqual({});
});
