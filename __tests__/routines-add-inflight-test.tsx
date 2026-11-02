// While an add is in flight the pane's three draft fields stayed editable, so
// an operator could keep typing into a draft the create had already captured —
// then `applyRoutineCreate` landed over those edits (clearing them on success,
// restoring the submitted values on failure). The fields now follow the same
// `busy` flag as the Add button, so the draft cannot be edited mid-flight.
// These render the real pane with the kit's inputs as host components, and pin
// both halves: locked while in flight, unlocked with the honest result after.

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  DisclosureRow: 'DisclosureRow',
  ErrorCard: 'ErrorCard',
  ListRow: 'ListRow',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { RoutinesPane } from '@/components/chat/routines-pane';
import { DEFAULT_ROUTINE_SCHEDULE } from '@/lib/gateway/routines';

type CreateInput = { title: string; prompt: string; schedule: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let renderer: ReactTestRenderer | null = null;

async function mount(onCreate: (input: CreateInput) => Promise<unknown>): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(RoutinesPane, {
        jobs: [],
        loaded: true,
        failed: false,
        onCreate,
        onTogglePause: async () => undefined,
      }),
    );
  });
  // The create form lives inside the collapsed disclosure; open it the way an
  // operator does.
  await act(async () => {
    renderer?.root.findByType('DisclosureRow' as ElementType).props.onPress();
  });
}

function fields(): ReactTestInstance[] {
  if (!renderer) throw new Error('the pane is not mounted');
  return renderer.root.findAllByType('TextField' as ElementType);
}

function button(label: string): ReactTestInstance {
  if (!renderer) throw new Error('the pane is not mounted');
  const found = renderer.root
    .findAllByType('Button' as ElementType)
    .find((node) => node.props.label === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** Type a valid draft into the title and prompt fields. */
async function fillDraft(): Promise<void> {
  const [titleField, , promptField] = fields();
  await act(async () => {
    titleField.props.onChangeText('inbox');
    promptField.props.onChangeText('Summarize overnight mail');
  });
}

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
});

describe('routine add in flight', () => {
  test('the draft fields are locked while the add is in flight', async () => {
    const pending = deferred<unknown>();
    await mount(() => pending.promise);
    await fillDraft();

    expect(button('Add').props.disabled).toBe(false);

    await act(async () => {
      button('Add').props.onPress();
    });

    expect(button('Adding…')).toBeDefined();
    // All three fields refuse edits for the duration of the add, and still
    // show exactly what was submitted — no half-overwritten draft.
    expect(fields().map((field) => field.props.editable)).toEqual([false, false, false]);
    expect(fields().map((field) => field.props.value)).toEqual([
      'inbox',
      DEFAULT_ROUTINE_SCHEDULE,
      'Summarize overnight mail',
    ]);
  });

  test('a confirmed add unlocks the fields and empties the title and prompt', async () => {
    const pending = deferred<unknown>();
    await mount(() => pending.promise);
    await fillDraft();

    await act(async () => {
      button('Add').props.onPress();
    });
    await act(async () => {
      pending.resolve({ id: 'job-2' });
      await pending.promise;
    });

    expect(button('Add')).toBeDefined();
    expect(fields().map((field) => field.props.editable)).toEqual([true, true, true]);
    expect(fields().map((field) => field.props.value)).toEqual([
      '',
      DEFAULT_ROUTINE_SCHEDULE,
      '',
    ]);
  });

  test('a refused add unlocks the fields with the submitted draft restored', async () => {
    const pending = deferred<unknown>();
    await mount(() => pending.promise);
    await fillDraft();

    await act(async () => {
      button('Add').props.onPress();
    });
    await act(async () => {
      pending.reject(new Error('gate refused'));
      await pending.promise.catch(() => undefined);
    });

    expect(button('Add')).toBeDefined();
    expect(fields().map((field) => field.props.editable)).toEqual([true, true, true]);
    expect(fields().map((field) => field.props.value)).toEqual([
      'inbox',
      DEFAULT_ROUTINE_SCHEDULE,
      'Summarize overnight mail',
    ]);
  });
});
