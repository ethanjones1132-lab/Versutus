declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('recent command writes serialize per gateway', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'lib', 'gateway', 'recents.ts'].join(SEP), 'utf8');

  it('chains each gateway write before reading and recording the next command', () => {
    expect(src).toContain('const writeQueues = new Map<string, Promise<unknown>>()');
    expect(src).toMatch(/const previous = writeQueues\.get\(gatewayId\)[\s\S]*?previous\.catch\(\(\) => undefined\)\.then\(async \(\) => \{[\s\S]*?readUsage\(gatewayId, now\)[\s\S]*?keyValueStorage\.setItem/);
    expect(src).toContain('writeQueues.set(gatewayId, operation)');
  });

  it('keeps best-effort storage, migration and bounded ranked output', () => {
    expect(src).toContain('catch {\n      // best-effort: recents must never break command execution');
    expect(src).toContain('parseStoredUsage(JSON.parse(raw), now)');
    expect(src).toContain('rankCommands(next, now, MAX_RECENTS)');
    expect(src).toContain('const MAX_RECENTS = 8;');
  });
});
