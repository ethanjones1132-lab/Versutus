// ─── Closing the run sheet ends the phone's side of the run ─────────────────
// `EnvironmentsSection` keeps ONE `EnvironmentRunLauncher` mounted for every
// environment (`visible={runTarget !== null}`), so Close only ever nulled
// `runTarget` — the instance holding `events`, `running` and `abortRef`
// survived. Pressing Close mid-stream left the stream open, `running` true and
// the old run's events in the bubble, so reopening the sheet for a *different*
// environment offered only "Cancel run" and appended the old run's output into
// the new run's reply.
//
// The contract these tests pin: Close (and a target change, and `visible`
// going false) aborts the local stream and clears the sheet; a retired run's
// callbacks and `finally` do nothing at all; the in-memory event log is
// bounded. The Gate-side run keeps going — Cancel run is the only cancel.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Badge: 'Badge',
  Button: 'Button',
  Chip: 'Chip',
  ListRow: 'ListRow',
  Text: 'Text',
  TextField: 'TextField',
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  capRunEvents,
  EnvironmentRunLauncher,
  MAX_RUN_EVENTS,
} from '@/components/gateway/environment-run-launcher';
import type { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentRunEvent, EnvironmentSnapshot } from '@/lib/gateway/environment-types';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;

type Client = ReturnType<typeof createEnvironmentClient>;
type Harness = ReturnType<typeof harness>;

function environment(id: string): EnvironmentSnapshot {
  return {
    id,
    label: id === 'alpha' ? 'Alpha' : 'Beta',
    adapterId: 'hermes',
    enabled: true,
    providerRefs: [],
    state: 'ready',
    executable: { path: '/usr/bin/hermes' },
    protocolPreference: ['acp'],
    workspacePolicy: { defaultRoot: '/tmp', defaultSandbox: 'read_only' },
    lifecycle: { startup: 'on_demand', maxConcurrentRuns: 1 },
  } as EnvironmentSnapshot;
}

let sequence = 0;
function frame(type: string, payload: Record<string, unknown>): EnvironmentRunEvent {
  sequence += 1;
  return { runId: 'run-1', sequence, timestamp: '2026-09-13T00:00:00.000Z', type, payload };
}

function output(text: string): EnvironmentRunEvent {
  return frame('run.output', { text });
}

const STARTED = frame('run.started', {});

/** A stream the test holds open: events are pushed by hand and the promise
 *  settles only when the test says so — the shape of a run still streaming. */
function harness() {
  const calls: {
    envId: string;
    runId: string;
    signal?: AbortSignal;
    onEvent: (event: EnvironmentRunEvent) => void;
  }[] = [];
  let settle: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const streamRun = jest.fn(
    async (
      envId: string,
      runId: string,
      onEvent: (event: EnvironmentRunEvent) => void,
      signal?: AbortSignal,
    ) => {
      calls.push({ envId, runId, signal, onEvent });
      await ended;
    },
  );
  const client = {
    streamRun,
    listRuns: jest.fn(async () => [] as unknown[]),
    listCommands: jest.fn(async () => ({})),
    startRun: jest.fn(async () => ({ runId: 'run-1' })),
    cancelRun: jest.fn(async () => undefined),
    approveRun: jest.fn(async () => undefined),
  };
  const onClose = jest.fn();
  return {
    calls,
    client,
    onClose,
    /** Push one frame through the nth stream this test opened. */
    emit: (index: number, event: EnvironmentRunEvent) => calls[index].onEvent(event),
    end: () => settle(),
  };
}

let renderer: ReactTestRenderer;

function render(
  client: Harness['client'],
  onClose: () => void,
  environmentValue: EnvironmentSnapshot | null,
  visible: boolean,
): void {
  act(() => {
    renderer.update(
      createElement(EnvironmentRunLauncher, {
        environment: environmentValue,
        client: client as unknown as Client,
        visible,
        onClose,
      }),
    );
  });
}

function mount(
  client: Harness['client'],
  onClose: () => void,
  environmentValue: EnvironmentSnapshot,
): void {
  act(() => {
    renderer = create(
      createElement(EnvironmentRunLauncher, {
        environment: environmentValue,
        client: client as unknown as Client,
        visible: true,
        onClose,
      }),
    );
  });
}

function labels(): string[] {
  return renderer.root.findAllByType(BUTTON).map((node) => String(node.props.label));
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

async function press(label: string): Promise<void> {
  const button = renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

async function typePrompt(text: string): Promise<void> {
  const field = renderer.root.findAllByType(TEXT_FIELD)[0];
  expect(field).toBeDefined();
  await act(async () => {
    field?.props.onChangeText(text);
  });
}

/** Start a run and leave its stream open. */
async function start(): Promise<void> {
  await typePrompt('go');
  await press('Start run');
}

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

test('Close mid-stream aborts the stream the phone was following', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();

  expect(run.calls).toHaveLength(1);
  expect(run.calls[0].signal?.aborted).toBe(false);

  await press('Close');

  expect(run.calls[0].signal?.aborted).toBe(true);
  expect(run.onClose).toHaveBeenCalled();
});

test('a run closed mid-stream can no longer write to the sheet', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();

  await press('Close');
  await act(async () => {
    run.emit(0, output('OLD-RUN-OUTPUT'));
  });

  expect(shown()).not.toContain('OLD-RUN-OUTPUT');
  // the sheet is clear, so the next target starts from nothing
  expect(shown()).toContain('No output yet.');
});

test("a retired run's finally does not refresh the run list", async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();
  // the mount-time visible read is the only list read this sheet may own
  expect(run.client.listRuns).toHaveBeenCalledTimes(1);

  await press('Close');
  await act(async () => {
    run.end();
  });

  expect(run.client.listRuns).toHaveBeenCalledTimes(1);
});

test('reopening for another environment offers Start run, not Cancel run', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();
  await act(async () => {
    run.emit(0, output('OLD-RUN-OUTPUT'));
  });
  expect(shown()).toContain('OLD-RUN-OUTPUT');

  // Close, then open the sheet for a different environment.
  await press('Close');
  render(run.client, run.onClose, null, false);
  render(run.client, run.onClose, environment('beta'), true);

  expect(labels()).toContain('Start run');
  expect(labels()).not.toContain('Cancel run');
  expect(shown()).not.toContain('OLD-RUN-OUTPUT');
});

test('pointing the sheet at another environment retires the run it was following', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();
  await act(async () => {
    run.emit(0, output('OLD-RUN-OUTPUT'));
  });

  render(run.client, run.onClose, environment('beta'), true);

  expect(run.calls[0].signal?.aborted).toBe(true);
  expect(labels()).toContain('Start run');
  expect(shown()).not.toContain('OLD-RUN-OUTPUT');
});

test('a second run never inherits the first run’s stream events', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();
  await press('Close');

  await start();
  expect(run.calls).toHaveLength(2);

  // the retired stream's callback can no longer reach the sheet
  await act(async () => {
    run.emit(0, output('OLD-RUN-OUTPUT'));
  });

  expect(shown()).not.toContain('OLD-RUN-OUTPUT');
});

test('the in-memory event log is capped, keeping the run.started marker', () => {
  const chunks = MAX_RUN_EVENTS + 500;
  const events: EnvironmentRunEvent[] = [
    STARTED,
    ...Array.from({ length: chunks }, (_, index) => output(`chunk-${index}`)),
  ];

  const capped = capRunEvents(events);

  expect(capped).toHaveLength(MAX_RUN_EVENTS);
  expect(capped[0].type).toBe('run.started');
  // the newest frames survive, the oldest are dropped
  expect(capped[capped.length - 1].payload?.text).toBe(`chunk-${chunks - 1}`);
  expect(capped.map((event) => event.payload?.text)).not.toContain('chunk-0');
});

test('a log already inside the cap is returned untouched', () => {
  const events = [STARTED, output('only-chunk')];
  expect(capRunEvents(events)).toBe(events);
});

test('a chatty run cannot grow the sheet heap past the cap', async () => {
  const run = harness();
  mount(run.client, run.onClose, environment('alpha'));
  await start();

  await act(async () => {
    for (let index = 0; index < MAX_RUN_EVENTS + 500; index += 1) run.emit(0, output('x'));
  });

  const bubble = shown()
    .split('\n')
    .find((text) => /^x+$/.test(text) && text.length > 1);
  expect(bubble).toHaveLength(MAX_RUN_EVENTS);
});

test('the launcher is still rendered once by the section, gated on the chosen target', () => {
  const source = readSource('src', 'components', 'gateway', 'environments-section.tsx');
  expect(source).toContain('<EnvironmentRunLauncher');
  expect(source).toContain('visible={runTarget !== null}');
  expect(source).toContain('onClose={() => setRunTarget(null)}');
});
