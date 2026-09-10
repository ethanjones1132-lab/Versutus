// The native bridge is mocked as the repo's notification suites mock
// expo-notifications: the module owns the platform call, the suite owns the
// device the call reports.
const mockWrite = jest.fn<void, [string]>();
const mockShareAsync = jest.fn<Promise<void>, [string, unknown?]>();
const mockIsAvailableAsync = jest.fn<Promise<boolean>, []>();

jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache' } },
  // The real `File` joins its arguments into one uri — a string segment is a
  // path component, a Directory contributes its own uri.
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
  shareTranscriptFile,
  transcriptShareAvailable,
} from '@/lib/gateway/transcript-share';

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

const FILE_NAME = 'versutus-transcript-session-a.md';
const MARKDOWN = '# Command history\n\n## status\n\n- Status: complete\n';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAvailableAsync.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
});

test('the platform is asked whether it has a share sheet at all', async () => {
  await expect(transcriptShareAvailable()).resolves.toBe(true);
  mockIsAvailableAsync.mockResolvedValue(false);
  await expect(transcriptShareAvailable()).resolves.toBe(false);
  // A probe that cannot answer is the same answer as one that says no: a
  // platform with no share module (web) answers false rather than throwing at
  // a surface that asked whether it may draw the control.
  mockIsAvailableAsync.mockRejectedValue(new Error('no native module'));
  await expect(transcriptShareAvailable()).resolves.toBe(false);
});

test('the shared file holds exactly the string it was handed, and the sheet opens on it', async () => {
  const shared = await shareTranscriptFile(FILE_NAME, MARKDOWN);
  expect(shared).toBe(true);
  // One write, of the composer's own bytes — nothing added, nothing re-cut.
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockWrite.mock.calls[0][0]).toBe(MARKDOWN);
  // The sheet is opened on the cache file, named by the caller's fold, and it
  // is told what the file is so the platform can offer the handlers for it.
  expect(mockShareAsync).toHaveBeenCalledTimes(1);
  expect(mockShareAsync.mock.calls[0][0]).toBe(`file:///cache/${FILE_NAME}`);
  expect(mockShareAsync.mock.calls[0][1]).toMatchObject({ mimeType: 'text/markdown' });
});

test('a device with no share sheet writes no file and opens nothing', async () => {
  mockIsAvailableAsync.mockResolvedValue(false);
  await expect(shareTranscriptFile(FILE_NAME, MARKDOWN)).resolves.toBe(false);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockShareAsync).not.toHaveBeenCalled();
});

test('a write that throws opens no sheet and answers false', async () => {
  mockWrite.mockImplementation(() => {
    throw new Error('cache unwritable');
  });
  await expect(shareTranscriptFile(FILE_NAME, MARKDOWN)).resolves.toBe(false);
  expect(mockShareAsync).not.toHaveBeenCalled();
});

test('a sheet that throws answers false rather than reading as a share', async () => {
  mockShareAsync.mockRejectedValue(new Error('no handler for that type'));
  await expect(shareTranscriptFile(FILE_NAME, MARKDOWN)).resolves.toBe(false);
});

test('this seam opens a sheet and reaches nothing else', () => {
  const src = readSource('src', 'lib', 'gateway', 'transcript-share.ts');
  // The two platform modules live here, off the pure naming rule and off the
  // surface that draws the button.
  expect(src).toContain("from 'expo-file-system'");
  expect(src).toContain("from 'expo-sharing'");
  // The file name is the caller's — this module holds no naming rule of its own.
  expect(src).toContain('new File(Paths.cache, fileName)');
  // Nothing is uploaded, sent, or hosted: the file is the share.
  expect(src).not.toContain('gatewayRequest');
  expect(src).not.toContain('fetch(');
  expect(src).not.toContain('keyValueStorage');
});
