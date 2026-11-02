// ─── The picked-file note reports the character COUNT, not the file text ────
// `pickFile` built the note as
//   `Read ${picked.name}: ${picked.content.toLocaleString()} characters.`
// `toLocaleString` on a string is `String.prototype.toLocaleString`, which
// answers the string unchanged — so the note reprinted the whole packet under
// the field instead of saying how long it was. The count must be formatted and
// shown; the text itself must not be echoed there.

type FileBehaviour = { text?: string; throws?: string };

const mockFileBehaviour: FileBehaviour = {};
const mockGetDocumentAsync = jest.fn();

jest.mock('expo-file-system', () => ({
  File: class MockFile {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async text(): Promise<string> {
      if (mockFileBehaviour.throws) throw new Error(mockFileBehaviour.throws);
      return mockFileBehaviour.text ?? '';
    }
  },
  Directory: class MockDirectory {},
  Paths: { cache: 'file:///cache/', document: 'file:///document/' },
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

jest.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }));

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    hasBotManagement: true,
    createBot: async () => undefined,
    requestSurface: jest.fn(),
  }),
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Screen: 'Screen',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ImportBotScreen from '@/app/gateway/import';
import { buildBotHandoff } from '@/lib/gateway/handoff';

const BUTTON = 'Button' as ElementType;

/** A distinctive soul so the test can tell the file TEXT from its count. */
const SOUL_MARKER = 'Watch the eastern gate.';

/** A real packet, long enough that its count is grouped (over a thousand). */
const PACKET = JSON.stringify(
  buildBotHandoff({
    bot: {
      id: 'scout',
      name: 'Scout',
      description: 'keeps the watch',
      soul: `${SOUL_MARKER} `.repeat(80).trim(),
    },
    now: () => '2026-09-13T00:00:00.000Z',
  }),
);

let renderer: ReactTestRenderer;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ImportBotScreen));
  });
}

/** Every text node the screen renders. */
function shown(): string {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return collected.join('\n');
}

async function press(label: string): Promise<void> {
  const button = renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

/** Drain the pick chain (picker → File.text() → the state write). */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function picked(name = 'packet.json'): void {
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///cache/packet.json', name, mimeType: 'application/json' }],
  });
}

async function pickOneFile(): Promise<string> {
  await mount();
  await press('Pick file');
  await settle();
  return shown();
}

beforeEach(() => {
  mockFileBehaviour.text = '';
  mockFileBehaviour.throws = undefined;
  mockGetDocumentAsync.mockReset();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

test('the note reads the file’s character count, formatted as a number', async () => {
  mockFileBehaviour.text = PACKET;
  picked('packet.json');

  const text = await pickOneFile();

  // The same formatting call the screen uses, so the expectation does not
  // depend on this machine's locale grouping.
  expect(text).toContain(`Read packet.json: ${PACKET.length.toLocaleString()} characters.`);
});

test('the note does not reprint the whole file text', async () => {
  mockFileBehaviour.text = PACKET;
  picked('packet.json');

  const text = await pickOneFile();

  // The soul only lives inside the packet body: an echoed packet would show it.
  expect(text).not.toContain(SOUL_MARKER);
  expect(text).not.toContain(PACKET);
});

test('a short file still reports its own count', async () => {
  mockFileBehaviour.text = 'abc';
  picked('small.json');

  const text = await pickOneFile();

  expect(text).toContain('Read small.json: 3 characters.');
});
