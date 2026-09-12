import { scopeModelsToBackend } from '@/lib/gateway/model-selection';

// Backend-locked model selection: a Gate's /v1/models flattens every backend's
// models into one list tagged with backendId. The picker must scope that list to
// the backend currently routing chat, so a model tap can never silently move the
// operator onto another backend. These pins hold the pure scope rule and the
// chat-screen row shaping that applies it.

describe('scopeModelsToBackend', () => {
  test('returns the same reference when no backend is selected', () => {
    const models = [
      { id: 'a', backendId: 'hermes' },
      { id: 'b', backendId: 'opencode' },
    ];
    expect(scopeModelsToBackend(models, undefined)).toBe(models);
  });

  test('excludes rows tagged with another backend', () => {
    const models = [
      { id: 'a', backendId: 'hermes' },
      { id: 'b', backendId: 'opencode' },
    ];
    expect(scopeModelsToBackend(models, 'hermes').map((m) => m.id)).toEqual(['a']);
  });

  test('keeps rows with no backendId under every selection', () => {
    const models: { id: string; backendId?: string }[] = [{ id: 'plain' }];
    expect(scopeModelsToBackend(models, 'hermes')).toEqual(models);
    expect(scopeModelsToBackend(models, 'opencode')).toEqual(models);
  });

  test('keeps rows tagged with the selected backend', () => {
    const models = [
      { id: 'a', backendId: 'hermes' },
      { id: 'b', backendId: 'opencode' },
    ];
    expect(scopeModelsToBackend(models, 'opencode').map((m) => m.id)).toEqual(['b']);
  });
});

// Mirrors the `modelRows` memo in src/components/chat/chat-screen.tsx. If the
// mapping drifts, this test stops matching the rows the sheet actually receives.
function shapeModelRows(
  catalog: Record<string, unknown>[],
  selectedBackendId: string | undefined,
) {
  return scopeModelsToBackend(
    catalog.map((model: Record<string, unknown>) => ({
      id: String(model.id || model.model || model.name || ''),
      provider: model.provider as string | undefined,
      providerId: (model.providerId ?? model.provider) as string | undefined,
      modelId: (model.modelId as string | undefined) ?? undefined,
      catalogState: (model.catalogSource ?? model.catalogState) as string | undefined,
      available: model.available !== false,
      context: (model.context ?? model.contextLength) as number | undefined,
      price: (model.cost ?? model.price) as number | undefined,
      auth: (model.authStatus ?? model.auth) as string | undefined,
      usage: model.usage as string | undefined,
      backendId: model.backendId as string | undefined,
    })),
    selectedBackendId,
  );
}

describe('chat-screen modelRows shaping', () => {
  const catalog: Record<string, unknown>[] = [
    { id: 'hermes/gpt-x', providerId: 'hermes', provider: 'Hermes', backendId: 'hermes' },
    { id: 'opencode/claude', providerId: 'opencode', provider: 'OpenCode', backendId: 'opencode' },
    { id: 'plain/model', providerId: 'plain', provider: 'Plain' },
  ];

  test("drops another backend's model and keeps the selected and unattributed rows", () => {
    const rows = shapeModelRows(catalog, 'hermes');
    expect(rows.map((row) => row.id)).toEqual(['hermes/gpt-x', 'plain/model']);
  });

  test('every surviving row still carries id, providerId and available', () => {
    const rows = shapeModelRows(catalog, 'hermes');
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.providerId).toBeTruthy();
      expect(row.available).toBe(true);
    }
  });

  test('an unattributed catalog is untouched, so direct-Hermes pickers do not empty', () => {
    const rows = shapeModelRows(
      [{ id: 'plain/model', providerId: 'plain', provider: 'Plain' }],
      'hermes',
    );
    expect(rows.map((row) => row.id)).toEqual(['plain/model']);
  });
});
