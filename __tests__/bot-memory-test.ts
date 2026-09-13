import { botMemoryCopy, botMemoryFromUnknown, memoryFileSearch } from '@/lib/gateway/bot-memory';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('botMemoryFromUnknown', () => {
  it('keeps the whitelisted files and their text', () => {
    const memory = botMemoryFromUnknown({
      id: 'researcher',
      files: [{ name: 'MEMORY.md', text: '- cites sources\n' }, { name: 'USER.md', text: 'Ethan\n' }],
    });
    expect(memory.id).toBe('researcher');
    expect(memory.files.map((file) => file.name)).toEqual(['MEMORY.md', 'USER.md']);
  });

  it('drops a non-whitelisted or blank file', () => {
    const memory = botMemoryFromUnknown({
      files: [
        { name: 'SECRET.md', text: 'sk-nope' },
        { name: 'MEMORY.md', text: '   ' },
        { name: 'USER.md', text: 'kept' },
      ],
    });
    expect(memory.files.map((file) => file.name)).toEqual(['USER.md']);
  });

  it('reads junk as no memory', () => {
    expect(botMemoryFromUnknown(null).files).toEqual([]);
    expect(botMemoryFromUnknown({ files: 'nope' }).files).toEqual([]);
  });
});

describe('memoryFileSearch', () => {
  const files = [{ name: 'MEMORY.md', text: 'alpha\nbeta source\ngamma' }];

  it('an empty query returns every non-empty line with its number', () => {
    expect(memoryFileSearch(files, '')).toEqual([
      { name: 'MEMORY.md', line: 1, text: 'alpha' },
      { name: 'MEMORY.md', line: 2, text: 'beta source' },
      { name: 'MEMORY.md', line: 3, text: 'gamma' },
    ]);
  });

  it('filters case-insensitively', () => {
    expect(memoryFileSearch(files, 'SOURCE')).toEqual([{ name: 'MEMORY.md', line: 2, text: 'beta source' }]);
    expect(memoryFileSearch(files, 'zzz')).toEqual([]);
  });
});

describe('botMemoryCopy', () => {
  it('names the file line counts, or an honest empty', () => {
    expect(botMemoryCopy({ files: [{ name: 'MEMORY.md', text: 'a\nb\n' }] })).toBe(
      'Memory on the Gate host — MEMORY.md · 2 lines',
    );
    expect(botMemoryCopy({ files: [] })).toBe('No memory stored on this Bot yet.');
  });
});

describe('the Bot detail sheet mounts the memory pane', () => {
  it('imports and renders BotMemoryPane', () => {
    const sheet = readSource(['src', 'components', 'chat', 'bot-detail-sheet.tsx']);
    expect(sheet).toContain("import { BotMemoryPane } from '@/components/chat/bot-memory-pane'");
    expect(sheet).toContain('<BotMemoryPane');
    expect(sheet).toContain('botId=');
  });
});
