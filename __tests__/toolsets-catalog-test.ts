import {
  applyToolsetsRead,
  EMPTY_TOOLSETS,
  toolsetsListCopy,
  toolsetsReadFromUnknown,
} from '@/lib/gateway/toolsets';

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

const section = () =>
  readSource('src', 'components', 'gateway', 'toolsets-section.tsx');

test('a raw listToolsets result renders as rows with names plus descriptions', () => {
  const read = toolsetsReadFromUnknown({
    toolsets: [
      { id: 'fs', tools: ['read', 'write'] },
      { name: 'browser', description: 'Fetch a page' },
    ],
  });
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.toolsets).toEqual([
    { name: 'fs', description: 'read, write' },
    { name: 'browser', description: 'Fetch a page' },
  ]);
  const src = section();
  // Each toolset becomes a row carrying its name and one-line description.
  expect(src).toContain('toolsetsReadFromUnknown');
  expect(src).toContain("gatewayRequest('tools.list'");
  expect(src).toContain('ListRow');
  expect(src).toContain('title={toolset.name}');
  expect(src).toContain('subtitle={toolset.description');
});

test('a rejected read renders the named error, never an empty no-tools story', () => {
  const failed = applyToolsetsRead(EMPTY_TOOLSETS, { ok: false });
  // The lib already refuses the empty story on a failed first read.
  expect(toolsetsListCopy(failed)).toBe('Tools could not be read.');
  expect(toolsetsListCopy(failed)).not.toBe('No tools.');
  const src = section();
  // The refusal names itself through the caught failure.
  expect(src).toContain('caught instanceof Error ? caught.message : String(caught)');
  expect(src).toContain('setError(caught instanceof Error');
  // The named error renders only until a good list lands — it never
  // replaces the rows with a blank "no tools" claim.
  expect(src).toContain('{error && !shown.loaded ?');
});

test('the catalog block lives beside the capabilities section on the Gateway screen', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('ToolsetsSection');
  const route = readSource('src', 'app', 'gateway', 'capabilities.tsx');
  expect(route).toContain('ToolsetsSection');
});

test('/tools slash text and the registry kinds/instances CRUD stay untouched', () => {
  const src = section();
  expect(src).not.toContain('registry.kinds.list');
  expect(src).not.toContain('registry.instances');
  expect(src).not.toContain("slash: '/tools'");
  const dashboard = readSource('src', 'lib', 'gateway', 'dashboard.ts');
  expect(dashboard).toContain("slash: '/tools'");
  // No host-side change: the Gate dispatch and REST twin are only read.
  expect(src).not.toContain('gate/core');
});
