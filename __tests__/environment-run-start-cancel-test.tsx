jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Badge: 'Badge',
  Button: 'Button',
  Chip: 'Chip',
  ListRow: 'ListRow',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { EnvironmentRunLauncher } from '@/components/gateway/environment-run-launcher';
import type { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentRunEvent, EnvironmentSnapshot } from '@/lib/gateway/environment-types';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
type Client = ReturnType<typeof createEnvironmentClient>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function environment(id: string): EnvironmentSnapshot {
  return {
    id,
    label: id,
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

function setup() {
  const starts: ReturnType<typeof deferred<{ runId: string }>>[] = [];
  const cancellations: { envId: string; runId: string; response: ReturnType<typeof deferred<void>> }[] = [];
  const streamEnds: ReturnType<typeof deferred<void>>[] = [];
  const streams: { envId: string; runId: string; signal?: AbortSignal }[] = [];
  const client = {
    startRun: jest.fn(() => {
      const next = deferred<{ runId: string }>();
      starts.push(next);
      return next.promise;
    }),
    cancelRun: jest.fn((envId: string, runId: string) => {
      const response = deferred<void>();
      cancellations.push({ envId, runId, response });
      return response.promise;
    }),
    streamRun: jest.fn(async (envId: string, runId: string, _onEvent: (event: EnvironmentRunEvent) => void, signal?: AbortSignal) => {
      streams.push({ envId, runId, signal });
      const ended = deferred<void>();
      streamEnds.push(ended);
      return ended.promise;
    }),
    listRuns: jest.fn(async () => []),
    listCommands: jest.fn(async () => ({})),
    approveRun: jest.fn(async () => undefined),
  };
  const onClose = jest.fn();
  return { client, starts, cancellations, streamEnds, streams, onClose };
}

let renderer: ReactTestRenderer;

function render(client: ReturnType<typeof setup>['client'], onClose: () => void, env: EnvironmentSnapshot | null, visible: boolean) {
  act(() => {
    renderer.update(createElement(EnvironmentRunLauncher, {
      environment: env,
      client: client as unknown as Client,
      visible,
      onClose,
    }));
  });
}

function mount(client: ReturnType<typeof setup>['client'], onClose: () => void, env: EnvironmentSnapshot) {
  act(() => {
    renderer = create(createElement(EnvironmentRunLauncher, {
      environment: env,
      client: client as unknown as Client,
      visible: true,
      onClose,
    }));
  });
}

async function press(label: string): Promise<void> {
  const button = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  expect(button).toBeDefined();
  await act(async () => button?.props.onPress());
}

function pressWithoutWaiting(label: string): void {
  const button = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  expect(button).toBeDefined();
  act(() => { void button?.props.onPress(); });
}

async function promptAndStart(): Promise<void> {
  const field = renderer.root.findAllByType(TEXT_FIELD)[0];
  await act(async () => field?.props.onChangeText('go'));
  pressWithoutWaiting('Start run');
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (renderer) {
    const old = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => old.unmount());
  }
  jest.clearAllMocks();
});

test('Cancel during startup waits for and cancels only the late run id', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  pressWithoutWaiting('Cancel run');
  run.starts[0].resolve({ runId: 'late-run' });
  await settle();

  expect(run.client.cancelRun).toHaveBeenCalledTimes(1);
  expect(run.client.cancelRun).toHaveBeenCalledWith('alpha', 'late-run');
  expect(run.streams).toHaveLength(0);
});

test('a new startup clears the previous active id before its late id arrives', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  run.starts[0].resolve({ runId: 'prior-run' });
  await settle();
  run.streamEnds[0].resolve();
  await settle();

  pressWithoutWaiting('Start run');
  pressWithoutWaiting('Cancel run');
  run.starts[1].resolve({ runId: 'new-run' });
  await settle();

  expect(run.client.cancelRun).toHaveBeenCalledTimes(1);
  expect(run.client.cancelRun).toHaveBeenCalledWith('alpha', 'new-run');
  expect(run.streams).toHaveLength(1);
});

test('alpha startup cancellation cannot swallow beta cancellation on the mounted launcher', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  pressWithoutWaiting('Cancel run');

  render(run.client, run.onClose, environment('beta'), true);
  await promptAndStart();
  pressWithoutWaiting('Cancel run');
  run.starts[1].resolve({ runId: 'run-beta' });
  await settle();

  expect(run.client.cancelRun).toHaveBeenCalledTimes(1);
  expect(run.client.cancelRun).toHaveBeenCalledWith('beta', 'run-beta');
  expect(run.streams).toHaveLength(0);
});

test('old pending cancel does not block a new same-environment run cancellation', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  run.starts[0].resolve({ runId: 'run-old' });
  await settle();
  pressWithoutWaiting('Cancel run');
  expect(run.cancellations).toHaveLength(1);

  // Closing and reopening the same target retires the old ticket while its
  // Gate cancellation is still unresolved.
  await press('Close');
  render(run.client, run.onClose, environment('alpha'), true);
  await promptAndStart();
  pressWithoutWaiting('Cancel run');
  run.starts[1].resolve({ runId: 'run-new' });
  await settle();

  expect(run.client.cancelRun).toHaveBeenCalledTimes(2);
  expect(run.client.cancelRun).toHaveBeenNthCalledWith(1, 'alpha', 'run-old');
  expect(run.client.cancelRun).toHaveBeenNthCalledWith(2, 'alpha', 'run-new');
  expect(run.streams).toHaveLength(1);
  expect(run.streams[0]).toMatchObject({ envId: 'alpha', runId: 'run-old' });
  expect(run.streams[0].signal?.aborted).toBe(true);
});

test('an old cancellation finishing cannot release the pending new ticket guard', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  run.starts[0].resolve({ runId: 'run-old' });
  await settle();
  pressWithoutWaiting('Cancel run');

  await press('Close');
  render(run.client, run.onClose, environment('alpha'), true);
  await promptAndStart();
  run.starts[1].resolve({ runId: 'run-new' });
  await settle();
  pressWithoutWaiting('Cancel run');
  expect(run.client.cancelRun).toHaveBeenCalledTimes(2);

  // Settle only the old request while the new one is still pending, then tap
  // Cancel again: it must deduplicate against the new ticket, not the old one.
  run.cancellations[0].response.resolve();
  await settle();
  pressWithoutWaiting('Cancel run');
  expect(run.client.cancelRun).toHaveBeenCalledTimes(2);
  expect(run.streams).toHaveLength(2);
  expect(run.streams[0]).toMatchObject({ envId: 'alpha', runId: 'run-old' });
  expect(run.streams[0].signal?.aborted).toBe(true);
  expect(run.streams[1]).toMatchObject({ envId: 'alpha', runId: 'run-new' });
  expect(run.streams[1].signal?.aborted).toBe(true);
});

test('a rejected start reports its error and never issues a phantom cancel', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  pressWithoutWaiting('Cancel run');
  run.starts[0].reject(new Error('start refused'));
  await settle();

  expect(run.client.cancelRun).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Text' as ElementType).some((node) => String(node.props.children).includes('start refused'))).toBe(true);
});

test('a refused cancellation names the error, remains retryable, and success settles its own ticket', async () => {
  const run = setup();
  mount(run.client, run.onClose, environment('alpha'));
  await promptAndStart();
  run.starts[0].resolve({ runId: 'run-1' });
  await settle();
  pressWithoutWaiting('Cancel run');
  run.cancellations[0].response.reject(new Error('Gate refused cancellation'));
  await settle();

  expect(renderer.root.findAllByType('Text' as ElementType).some((node) => String(node.props.children).includes('Gate refused cancellation'))).toBe(true);
  expect(renderer.root.findAllByType(BUTTON).some((node) => node.props.label === 'Cancel run')).toBe(true);

  pressWithoutWaiting('Cancel run');
  expect(run.client.cancelRun).toHaveBeenCalledTimes(2);
  run.cancellations[1].response.resolve();
  await settle();
  expect(renderer.root.findAllByType(BUTTON).some((node) => node.props.label === 'Start run')).toBe(true);
});

test('explicit Cancel followed by dismissal still cancels the captured environment; plain dismissal does not', async () => {
  const explicit = setup();
  mount(explicit.client, explicit.onClose, environment('alpha'));
  await promptAndStart();
  pressWithoutWaiting('Cancel run');
  await press('Close');
  render(explicit.client, explicit.onClose, environment('beta'), true);
  explicit.starts[0].resolve({ runId: 'run-alpha' });
  await settle();
  expect(explicit.client.cancelRun).toHaveBeenCalledWith('alpha', 'run-alpha');
  expect(explicit.streams).toHaveLength(0);

  const dismissed = setup();
  mount(dismissed.client, dismissed.onClose, environment('alpha'));
  await promptAndStart();
  await press('Close');
  dismissed.starts[0].resolve({ runId: 'run-detached' });
  await settle();
  expect(dismissed.client.cancelRun).not.toHaveBeenCalled();
  expect(dismissed.streams).toHaveLength(0);
});
