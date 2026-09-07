import { createProviderClient } from '@/lib/gateway/provider-client';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('provider rename', () => {
  test('the action sheet exposes a Rename entry that opens a rename sheet', () => {
    // Every active provider on a Gate could be renamed only by editing its
    // stored registration. The action sheet now carries a Rename entry that
    // opens an inline sheet pre-filled with the current label, so the
    // operator can change it without leaving the Providers section.
    const src = readSource('src', 'components', 'gateway', 'provider-actions-sheet.tsx');
    // Rename sits at the top of the action list, above Set key -- the rest
    // of the order stays exactly as the prior iteration shipped it.
    expect(src).toMatch(/title="Rename"/);
    // The Rename row opens the inline rename sheet (not the destructive
    // confirm path that the existing entries share).
    expect(src).toMatch(/onPress=\{openRename\}/);
    // The action sheet hosts an inline ProviderRenameSheet so the operator
    // never loses the row context while typing.
    expect(src).toMatch(/<ProviderRenameSheet\b/);
  });

  test('the rename sheet sends providers.update with a trimmed label and never an empty one', async () => {
    // The Gate's schema enforces a non-empty label (gate/core/providers/schema.mjs:110),
    // so the client must trim, refuse empty, and send only { label } -- never the id.
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = createProviderClient(
      async <T,>(method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        return { ok: true } as T;
      },
    );
    await client.update('openai-main', { label: '  OpenAI Primary  ' });
    // The only field is label (id stays out of the patch), and the trim is
    // the caller's responsibility -- this pin guards against a regression
    // that sends `id` (which would orphan the credential) or whitespace.
    expect(calls).toEqual([
      { method: 'providers.update', params: { id: 'openai-main', label: '  OpenAI Primary  ' } },
    ]);
  });

  test('the rename sheet gates Save on a non-empty trimmed label', () => {
    // An empty or whitespace-only label would round-trip to the Gate and
    // come back as a validation error ("label: must be a non-empty string").
    // The Save button is disabled until the trimmed value is non-empty so
    // the operator never sees that error.
    const src = readSource('src', 'components', 'gateway', 'provider-rename-sheet.tsx');
    expect(src).toMatch(/const trimmed = value\.trim\(\)/);
    expect(src).toMatch(/trimmed\.length > 0/);
    // Save label flips between "Saving…" while busy and "Save" otherwise.
    expect(src).toMatch(/label=\{busy \? ['"]Saving…['"] : ['"]Save['"]\}/);
    // The Save button is disabled when canSave is false (busy or empty).
    expect(src).toMatch(/disabled=\{!canSave\}/);
  });

  test('the rename sheet submits the trimmed label and reloads on success', () => {
    // The sheet mirrors the ProviderKeySheet shape: a TextField, a Save
    // button gated on the trimmed value, and a Cancel affordance on the
    // header. On Save it calls client.update(id, { label: trimmed }) and
    // re-runs the providers list so the new label renders without a
    // manual pull-to-refresh.
    const src = readSource('src', 'components', 'gateway', 'provider-rename-sheet.tsx');
    expect(src).toMatch(/onPress=\{\(\)\s*=>\s*void saveRename\(\)\}/);
    // The saveRename helper trims and awaits the parent's onSubmit, then
    // closes on success so the action sheet's row stays the same context.
    expect(src).toMatch(/await onSubmit\(trimmed\)/);
    expect(src).toMatch(/onClose\(\)/);
  });

  test('the rename sheet shows the failed-validation error from the Gate', () => {
    // providers.update surfaces a join of field-level errors from
    // validateProviderRegistration. The sheet must show them so the
    // operator can correct the value, not a white-screen "save failed".
    const src = readSource('src', 'components', 'gateway', 'provider-rename-sheet.tsx');
    expect(src).toMatch(/catch\s*\([^)]*\)\s*\{/);
    expect(src).toMatch(/setError\(caught instanceof Error \? caught\.message : String\(caught\)\)/);
  });

  test('a failed rename keeps the sheet open and surfaces the honest error', () => {
    // The Gate rejects an empty or duplicated label with a validation
    // error. The sheet must not close on a failure -- otherwise the
    // operator loses the value they typed and has to start over.
    const src = readSource('src', 'components', 'gateway', 'provider-rename-sheet.tsx');
    expect(src).not.toMatch(/catch[\s\S]*?onClose\(\)/);
    // The Save button is re-enabled after a failure so a corrected value
    // can be submitted again without dismissing the sheet.
    expect(src).toMatch(/finally\s*\{[\s\S]*?setBusy\(false\)/);
  });

  test('the Providers section wires the rename callback into the action sheet', () => {
    // The action sheet's onRename is wired to client.update(id, { label })
    // followed by load() -- mirroring onEnable / onDisable. The existing
    // enable/disable/re-check/reload flow stays byte-identical. A defensive
    // trim in the section guards the patch against whitespace the sheet
    // might forward if its own gating is ever bypassed.
    const section = readSource('src', 'components', 'gateway', 'providers-section.tsx');
    expect(section).toMatch(/handleRename\b/);
    expect(section).toMatch(/const trimmed = nextLabel\.trim\(\)/);
    expect(section).toMatch(/client\.update\(snapshotId,\s*\{\s*label:\s*trimmed\s*\}\)/);
    // handleRename runs load() in its finally block; the card wires
    // onRename through handleRename(snapshot.id, nextLabel) -- the rename
    // always triggers a reload, whether the rename succeeded or failed.
    expect(section).toMatch(/onRename=\{\(nextLabel\)\s*=>\s*handleRename\(snapshot\.id,\s*nextLabel\)\}/);
    expect(section).toMatch(/await load\(\)/);
  });

  test('the existing action sheet entries stay byte-identical', () => {
    // The seven pre-existing rows (Set key, Authorize, Check readiness,
    // Refresh catalog, Disconnect, Disable, Remove provider) and the
    // destructive ConfirmSheet must not move. Adding Rename was the only
    // change.
    const src = readSource('src', 'components', 'gateway', 'provider-actions-sheet.tsx');
    expect(src).toMatch(/title="Set key"/);
    expect(src).toMatch(/title="Authorize"/);
    expect(src).toMatch(/title="Check readiness"/);
    expect(src).toMatch(/title="Refresh catalog"/);
    expect(src).toMatch(/title="Disconnect"/);
    expect(src).toMatch(/title="Disable"/);
    expect(src).toMatch(/title="Remove provider"/);
    // The destructive confirm pattern (Remove provider -> ConfirmSheet)
    // is unchanged.
    expect(src).toMatch(/confirmDelete\(\)/);
    expect(src).toMatch(/confirmLabel="Remove"/);
    expect(src).toMatch(/\bdanger\b/);
  });

  test('the Gate-side validateProviderRegistration enforces a non-empty label', () => {
    // The schema is the authority on what providers.update accepts --
    // an empty label must be rejected server-side even if the client
    // shipped a regression that allowed it. The phone trims and gates,
    // the Gate validates; either alone would still leave a hole.
    const gateSchema = readSource('gate', 'core', 'providers', 'schema.mjs');
    expect(gateSchema).toMatch(/requireString\(value\.label,\s*['"]label['"]/);
    expect(gateSchema).toMatch(/'must be a non-empty string'/);
  });

  test('the Gate-side service.update shallow-merges the patch and keeps the id intact', () => {
    // providers.update merges the patch into the existing record and
    // re-validates with id unchanged (service.mjs:58-68). The phone
    // never sends id in the patch -- sending it would orphan the stored
    // credential under provider/${id}/api-key.
    const service = readSource('gate', 'core', 'providers', 'service.mjs');
    expect(service).toMatch(/const next = \{ \.\.\.existing\.config, \.\.\.input, id, schemaVersion: 2, kind: 'provider' \}/);
    expect(service).toMatch(/validateProviderRegistration\(next\)/);
    expect(service).toMatch(/this\.store\.put\(next/);
  });
});