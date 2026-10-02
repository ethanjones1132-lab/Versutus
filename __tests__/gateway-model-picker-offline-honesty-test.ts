// MODEL-4: with no client the picker set `modelCatalogLoaded(true)`
// synchronously while the cached read was still in flight, so a remembered
// catalog landed under a "loaded" flag. The scan's severity was corrected: the
// rows render the same either way, and the observable effect is the empty-state
// copy. The flag is now settled by the read that actually settled the catalog.
// Pinned off the source.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function pickerBody(): string {
  const start = provider.indexOf('const openModelPicker = useCallback');
  expect(start).toBeGreaterThan(-1);
  return provider.slice(start, provider.indexOf('const closeModelPicker = useCallback', start));
}

describe('MODEL-4: the picker settles its loaded flag from the read that ran', () => {
  test('the no-client branch does not flip loaded synchronously when a cache read is in flight', () => {
    const body = pickerBody();
    // The `if (!client) { setModelCatalogLoaded(true); return; }` shape is gone;
    // with a cache id the cache read owns the flag.
    expect(body).not.toMatch(/if \(!client\) \{\s*setModelCatalogLoaded\(true\);\s*return;\s*\}/);
    expect(body).toMatch(/if \(!client\) \{[\s\S]*?if \(!cacheId\) \{[\s\S]*?readSettled = true;\s*setModelCatalogLoaded\(true\);\s*\}[\s\S]*?return;\s*\}/);
  });

  test('a cache miss with no client settles the empty list', () => {
    const body = pickerBody();
    expect(body).toMatch(/if \(!cached\) \{[\s\S]*?if \(!client\) \{[\s\S]*?readSettled = true;\s*setModelCatalogLoaded\(true\);/);
  });

  test('a remembered catalog does not set loaded on its own', () => {
    const body = pickerBody();
    // The cache hit only sets the catalog, never the loaded flag.
    expect(body).toMatch(/setModelCatalog\(cached\.value\);\s*\}\)\s*\.catch/);
    expect(body).not.toMatch(/setModelCatalog\(cached\.value\);\s*setModelCatalogLoaded\(true\)/);
  });
});
