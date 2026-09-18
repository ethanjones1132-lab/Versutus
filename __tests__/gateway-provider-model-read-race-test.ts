// ─── A model catalog read that completes after a Gateway replacement must be discarded
// openModelPicker guards only a local modelReadSeqRef, while Gateway replacement
// increments clientGenerationRef and installs a new client without invalidating
// that read. Bind the read to the client/Gateway generation. Pinned off the
// source, the way the rest of the provider suites pin theirs.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = provider.indexOf(startMarker);
  const end = provider.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return provider.slice(start, end);
}

const openModelPicker = sliceBetween(
  'const openModelPicker = useCallback',
  'const closeModelPicker = useCallback',
);

describe('model catalog read is scoped to the Gateway that started it', () => {
  test('the read captures the client generation it starts against', () => {
    expect(openModelPicker).toContain('const generation = clientGenerationRef.current;');
    expect(openModelPicker).toContain('const isCurrent = () => clientGenerationRef.current === generation;');
  });

  test('a model catalog answer only lands while the client that asked is still current', () => {
    expect(openModelPicker).toContain('const client = clientRef.current;');
    expect(openModelPicker).toMatch(/const models = await client\.getModels\(\);/);
    expect(openModelPicker).toMatch(/if \(seq !== modelReadSeqRef\.current \|\| !isCurrent\(\)\) return;/);
    expect(openModelPicker).not.toMatch(/if \(seq !== modelReadSeqRef\.current\) return;\s*setModelCatalog\(models\);/);
  });

  test('a model catalog error only lands while the client that asked is still current', () => {
    const catchBlock = openModelPicker.slice(openModelPicker.indexOf('catch (error)'));
    expect(catchBlock).toMatch(/if \(seq !== modelReadSeqRef\.current \|\| !isCurrent\(\)\) return;/);
    expect(catchBlock).not.toMatch(/if \(seq !== modelReadSeqRef\.current\) return;\s*setModelCatalogError\(/);
  });

  test('resetSessionSelector retires in-flight model reads on Gateway replacement', () => {
    const reset = provider.slice(
      provider.indexOf('const resetSessionSelector = useCallback'),
      provider.indexOf('const resetSessionSelector = useCallback') + 600,
    );
    expect(reset).toContain('++modelReadSeqRef.current;');
  });

  test('every Gateway replacement seam bumps the generation and resets model reads', () => {
    // attachClient supersede, disconnectGateway, deleteGateway, teardownRetiredActiveGateway
    const resets = provider.match(/clientGenerationRef\.current \+= 1;/g) ?? [];
    expect(resets).toHaveLength(4);
    const modelResets = provider.match(/\+\+modelReadSeqRef\.current;/g) ?? [];
    // resetSessionSelector is called at all 4 seams; it should increment modelReadSeqRef
    expect(modelResets).toHaveLength(1); // only in resetSessionSelector
  });

  test('a successful current read still populates the catalog and clears errors', () => {
    expect(openModelPicker).toContain('setModelCatalog(models);');
    expect(openModelPicker).toContain('setModelCatalogError(undefined);');
  });
});