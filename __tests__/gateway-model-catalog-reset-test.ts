// MODEL-1: the in-memory model catalog outlived every gateway and scope change,
// so gateway B's picker showed gateway A's rows until B's read answered — or
// under B's error. `resetSessionSelector` (called at every teardown and scope
// change) now clears it and settles the picker so an already-open sheet does
// not spin on "The gateway is answering." with no read in flight.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function resetSessionSelector(): string {
  const start = provider.indexOf('const resetSessionSelector = useCallback');
  expect(start).toBeGreaterThan(-1);
  const end = provider.indexOf('}, []);', start);
  expect(end).toBeGreaterThan(start);
  return provider.slice(start, end);
}

describe('MODEL-1: a gateway or scope change clears the model catalog', () => {
  test('resetSessionSelector clears the catalog and settles it as unreadable', () => {
    const reset = resetSessionSelector();
    expect(reset).toContain('setModelCatalog([]);');
    expect(reset).toContain("setModelCatalogError('Model catalog could not be read.');");
    expect(reset).toContain('setModelCatalogLoaded(false);');
  });
});
