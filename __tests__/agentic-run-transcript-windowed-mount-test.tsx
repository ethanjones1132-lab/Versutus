// A FlatList inside BaseSheet only windows once it has a short viewport.
// Mocking BaseSheet as a host string means Yoga never lays the list out, so a
// mounted-node count cannot prove the phone path. This test asserts the bound
// on the list element's own style — the same pin thread-config and the slash
// palette use (`maxHeight: listMaxHeight`).

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Divider: 'Divider',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { createElement } from 'react';
import { Dimensions, FlatList } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  AgenticRunSheet,
  TRANSCRIPT_LIST_CHROME,
  TRANSCRIPT_LIST_MIN_HEIGHT,
  transcriptListMaxHeight,
} from '@/components/activity/agentic-run-sheet';
import type { RunEvent } from '@/lib/gateway/types';
import { sheetMaxHeight } from '@/lib/motion/sheet-height';

function event(index: number): RunEvent {
  return { type: 'tool.result', data: { step: index } } as unknown as RunEvent;
}

function listBound(renderer: ReactTestRenderer): number | undefined {
  const list = renderer.root.findByType(FlatList);
  const style = list.props.style as unknown;
  const entries = Array.isArray(style) ? style : [style];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && 'maxHeight' in entry) {
      const height = (entry as { maxHeight: unknown }).maxHeight;
      return typeof height === 'number' ? height : undefined;
    }
  }
  return undefined;
}

function textLines(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAll((node) => String(node.type) === 'Text').map((node) => {
    const children = node.props.children;
    if (Array.isArray(children)) return children.join('');
    return children == null ? '' : String(children);
  });
}

let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
});

describe('transcript list height bound', () => {
  test('fills the remaining sheet, not the 380 picker cap', () => {
    // Session/model pickers cap at 380 because they share the sheet with search
    // and a switcher. This list is the sheet body, so the bound is the sheet
    // ceiling minus BaseSheet chrome — a long replay still fills the sheet.
    const h = transcriptListMaxHeight({ windowHeight: 844, insetTop: 47, insetBottom: 34 });
    const sheet = sheetMaxHeight({ windowHeight: 844, insetTop: 47, insetBottom: 34 });
    expect(h).toBe(Math.max(TRANSCRIPT_LIST_MIN_HEIGHT, Math.round(sheet - TRANSCRIPT_LIST_CHROME)));
    expect(h).toBeGreaterThan(380);
    expect(h).toBeLessThanOrEqual(sheet);
  });

  test('never collapses below the floor on a tiny window', () => {
    // sheetMaxHeight floors at 240, so 240 minus chrome is 130 — still above
    // the list floor. The floor is the last guard if chrome grows.
    expect(transcriptListMaxHeight({ windowHeight: 0 })).toBeGreaterThanOrEqual(TRANSCRIPT_LIST_MIN_HEIGHT);
  });

  it('pins maxHeight on the list so a phone FlatList has a viewport', async () => {
    await act(async () => {
      renderer = create(
        createElement(AgenticRunSheet, {
          runId: 'run-long',
          loadEvents: async () => [event(0)],
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const expected = transcriptListMaxHeight({
      windowHeight: Dimensions.get('window').height,
      insetTop: 47,
      insetBottom: 34,
    });
    const bound = listBound(renderer!);
    expect(bound).toBe(expected);
    expect(bound).toBeGreaterThanOrEqual(TRANSCRIPT_LIST_MIN_HEIGHT);
  });

  it('names how many older events the loader left out', async () => {
    await act(async () => {
      renderer = create(
        createElement(AgenticRunSheet, {
          runId: 'run-long',
          loadEvents: async () => ({ events: [event(0)], omitted: 12 }),
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(textLines(renderer!).some((line) => line.includes('12 earlier events not shown.'))).toBe(true);
  });

  it('hides the omitted line when the whole replay fits', async () => {
    await act(async () => {
      renderer = create(
        createElement(AgenticRunSheet, {
          runId: 'run-short',
          loadEvents: async () => [event(0), event(1)],
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(textLines(renderer!).some((line) => line.includes('earlier events not shown'))).toBe(false);
  });
});
