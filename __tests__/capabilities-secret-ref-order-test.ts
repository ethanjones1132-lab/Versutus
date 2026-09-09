declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'gateway', 'capabilities-section.tsx']);
}

// saveDraft used to send registry.instances.create/update first and only then
// run the looksLikeCredential guard, so a key pasted into the secret-ref field
// created an orphan instance the open draft could not retry (a second Save
// re-sent create with the same id). The guard now runs before create/update,
// so a refused save sends nothing; the named-field copy and the successful
// save's secrets.set + refreshCapabilities + load + draft-clear are unchanged.
describe('capabilities section secret-ref guard order', () => {
  test('the looksLikeCredential guard runs before registry.instances.create', () => {
    const src = readSection();
    const guardAt = src.indexOf('if (looksLikeCredential(refName)) {');
    const createAt = src.indexOf("'registry.instances.create'");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(createAt);
  });

  test('the looksLikeCredential guard runs before registry.instances.update', () => {
    const src = readSection();
    const guardAt = src.indexOf('if (looksLikeCredential(refName)) {');
    const updateAt = src.indexOf("'registry.instances.update'");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(updateAt);
  });

  test('the named-field error copy is byte-identical', () => {
    const src = readSection();
    expect(src).toContain(
      '`"${secretField?.label ?? \'Secret ref\'}" holds the secret\'s name, not the secret. Put the key in "Secret value" and give this field a name like "my-api-key".`',
    );
  });

  test('the guard still fires only when a secret value is being set', () => {
    const src = readSection();
    expect(src).toContain('const hasSecret = !!refName && !!draft.secretValue.trim();');
    expect(src).toContain('if (hasSecret) {');
  });

  test('a successful save still sets the secret then refreshes and clears the draft', () => {
    const src = readSection();
    expect(src).toContain(
      "await gatewayRequest('registry.secrets.set', { refName, value: draft.secretValue.trim() });",
    );
    expect(src).toContain('setDraft(null);');
    expect(src).toContain('await refreshCapabilities();');
    expect(src).toContain('await load();');
  });

  test('create/update payloads and the id validation are untouched', () => {
    const src = readSection();
    expect(src).toContain('setError(\'Instance id must be lowercase alphanumeric with hyphens.\');');
    expect(src).toContain('id: draft.id,');
    expect(src).toContain('kind: draft.kind,');
    expect(src).toContain("await gatewayRequest('registry.instances.create', {");
    expect(src).toContain("await gatewayRequest('registry.instances.update', {");
  });

  test('the catch/finally and delete path stay untouched', () => {
    const src = readSection();
    expect(src).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
    expect(src).toContain("await gatewayRequest('registry.instances.delete', { id });");
  });
});
