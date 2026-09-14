// The native bridge is mocked the way transcript-share-test.ts mocks it: the
// module owns the platform call, the suite owns the device the call reports.
const mockWrite = jest.fn<void, [string]>();
const mockShareAsync = jest.fn<Promise<void>, [string, unknown?]>();
const mockIsAvailableAsync = jest.fn<Promise<boolean>, []>();

jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache' } },
  File: class {
    uri: string;
    write = (content: string) => mockWrite(content);
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockIsAvailableAsync(),
  shareAsync: (url: string, options?: unknown) => mockShareAsync(url, options),
}));

import {
  botPacketShareAvailable,
  shareBotPacketFile,
} from '@/lib/gateway/bot-packet-share';

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

const FILE_NAME = 'Scout-packet-v1.json';
const JSON = '{"version":1,"kind":"versutus-bot-packet"}';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAvailableAsync.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
});

test('the platform is asked whether it has a share sheet at all', async () => {
  await expect(botPacketShareAvailable()).resolves.toBe(true);
  mockIsAvailableAsync.mockResolvedValue(false);
  await expect(botPacketShareAvailable()).resolves.toBe(false);
  // A probe that cannot answer (a platform with no share module, web) is the
  // same answer as no: no control is drawn that cannot finish.
  mockIsAvailableAsync.mockRejectedValue(new Error('no native module'));
  await expect(botPacketShareAvailable()).resolves.toBe(false);
});

test('the shared file holds exactly the packet bytes, and the sheet opens on it as JSON', async () => {
  const shared = await shareBotPacketFile(FILE_NAME, JSON);
  expect(shared).toBe(true);
  // One write, of the packet's own bytes — nothing added, nothing re-cut.
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockWrite.mock.calls[0][0]).toBe(JSON);
  // The sheet opens on the cache file named by the packet module's fold, told
  // what the file is so the platform offers the handlers a packet can land in.
  expect(mockShareAsync).toHaveBeenCalledTimes(1);
  expect(mockShareAsync.mock.calls[0][0]).toBe(`file:///cache/${FILE_NAME}`);
  expect(mockShareAsync.mock.calls[0][1]).toMatchObject({ mimeType: 'application/json' });
});

test('a device with no share sheet writes no file and opens nothing', async () => {
  mockIsAvailableAsync.mockResolvedValue(false);
  await expect(shareBotPacketFile(FILE_NAME, JSON)).resolves.toBe(false);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockShareAsync).not.toHaveBeenCalled();
});

test('a write that throws opens no sheet and answers false', async () => {
  mockWrite.mockImplementation(() => {
    throw new Error('cache unwritable');
  });
  await expect(shareBotPacketFile(FILE_NAME, JSON)).resolves.toBe(false);
  expect(mockShareAsync).not.toHaveBeenCalled();
});

test('a sheet that throws answers false rather than reading as a share', async () => {
  mockShareAsync.mockRejectedValue(new Error('no handler for that type'));
  await expect(shareBotPacketFile(FILE_NAME, JSON)).resolves.toBe(false);
});

test('this seam opens a sheet and reaches nothing else', () => {
  const src = readSource('src', 'lib', 'gateway', 'bot-packet-share.ts');
  // The two platform modules live here, off the pure packet fold and off the
  // surface that draws the row — the transcript-share one-seam pattern.
  expect(src).toContain("from 'expo-file-system'");
  expect(src).toContain("from 'expo-sharing'");
  expect(src).toContain('new File(Paths.cache, fileName)');
  // Nothing is uploaded, sent, or hosted: the file is the share.
  expect(src).not.toContain('gatewayRequest');
  expect(src).not.toContain('fetch(');
  expect(src).not.toContain('keyValueStorage');
});
