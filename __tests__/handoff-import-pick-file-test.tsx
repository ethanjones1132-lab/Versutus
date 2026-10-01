// ─── Picking a handoff packet reads the file on SDK 57 ──────────────────────
// `pickHandoffFile` did `await import('expo-file-system')` and then
// `FileSystem.readAsStringAsync(asset.uri)`. On expo-file-system@57 that root
// export is re-exported from `legacyWarnings`, whose body is an unconditional
// `throw` — the working copy only exists at `expo-file-system/legacy`. The
// declarations still list it, so tsc was green; the catch turned the throw
// into `content: ''`, and `pickFile` wrote that empty string into the field
// BEFORE it inspected `picked.error`, so a packet the operator had already
// pasted was destroyed by a failed pick.
//
// The mock below models the REAL SDK 57 root surface: the `File` class, and no
// `readAsStringAsync` at all — so anything still reaching for the legacy
// function fails here exactly as it fails on device.

type FileBehaviour = { text?: string; throws?: string };

const mockFileBehaviour: FileBehaviour = {};
const mockFileUris: string[] = [];

jest.mock('expo-file-system', () => ({
  // SDK 57 root export: File / Directory / Paths. Deliberately NO
  // readAsStringAsync — on device that name throws unconditionally.
  File: class MockFile {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
      mockFileUris.push(uri);
    }
    async text(): Promise<string> {
      if (mockFileBehaviour.throws) throw new Error(mockFileBehaviour.throws);
      return mockFileBehaviour.text ?? '';
    }
    textSync(): string {
      if (mockFileBehaviour.throws) throw new Error(mockFileBehaviour.throws);
      return mockFileBehaviour.text ?? '';
    }
  },
  Directory: class MockDirectory {},
  Paths: { cache: 'file:///cache/', document: 'file:///document/' },
}));

const mockGetDocumentAsync = jest.fn();

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

import ImportBotScreen, { pickHandoffFile } from '@/app/gateway/import';
import { buildBotHandoff } from '@/lib/gateway/handoff';

const BUTTON = 'Button' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;

/** A real packet, built the way the export writes one. */
const PACKET = JSON.stringify(
  buildBotHandoff({
    bot: { id: 'scout', name: 'Scout', description: 'keeps the watch', soul: 'Watchful.' },
    now: () => '2026-09-13T00:00:00.000Z',
  }),
);

let renderer: ReactTestRenderer;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ImportBotScreen));
  });
}

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

/** The packet field's current value. */
function fieldValue(): string {
  return String(renderer.root.findAllByType(TEXT_FIELD)[0]?.props.value ?? '');
}

/** The refusal the screen's ErrorCard is showing, or undefined. */
function errorCause(): string | undefined {
  const card = renderer.root.findAllByType(ERROR_CARD)[0];
  return card ? String(card.props.cause) : undefined;
}

async function paste(value: string): Promise<void> {
  const field = renderer.root.findAllByType(TEXT_FIELD)[0];
  await act(async () => {
    field?.props.onChangeText(value);
  });
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

function picked(uri = 'file:///cache/scout.json', name = 'scout.json'): void {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [{ uri, name, mimeType: 'application/json' }] });
}

beforeEach(() => {
  mockFileBehaviour.text = '';
  mockFileBehaviour.throws = undefined;
  mockFileUris.length = 0;
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

test('a picked file is read through the SDK 57 File class', async () => {
  mockFileBehaviour.text = PACKET;
  picked('file:///cache/scout.json', 'scout.json');

  await expect(pickHandoffFile()).resolves.toEqual({ name: 'scout.json', content: PACKET });
  // the picked uri is what gets opened, through `new File(uri)`
  expect(mockFileUris).toEqual(['file:///cache/scout.json']);
});

test('a picked file’s text lands in the packet field', async () => {
  mockFileBehaviour.text = PACKET;
  picked();

  await mount();
  await press('Pick file');
  await settle();

  expect(fieldValue()).toBe(PACKET);
  expect(shown()).toContain('Read scout.json');
});

test('a file that cannot be read leaves an already pasted packet alone', async () => {
  mockFileBehaviour.throws = 'ENOENT: no such file';
  picked();

  await mount();
  await paste(PACKET);
  await press('Pick file');
  await settle();

  expect(fieldValue()).toBe(PACKET);
  expect(errorCause()).toBe('The picked file could not be read.');
});

test('a cancelled picker leaves the field alone and shows no refusal', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null });

  await mount();
  await paste(PACKET);
  await press('Pick file');
  await settle();

  expect(fieldValue()).toBe(PACKET);
  expect(shown()).not.toContain('could not be read');
  expect(mockFileUris).toEqual([]);
});
