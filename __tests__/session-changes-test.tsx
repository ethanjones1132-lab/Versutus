import { createElement, type ReactNode } from 'react';
import { Text as RNText, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/hooks/use-tokens', () => ({ useTokens: () => ({ backgroundInset: '#111' }) }));
jest.mock('@/components/ui', () => {
  const React = require('react') as typeof import('react');
  const Native = require('react-native') as typeof import('react-native');
  return {
    BaseSheet: ({ children }: { children: ReactNode }) => React.createElement(Native.View, null, children),
    ListRow: ({ title, subtitle }: { title: string; subtitle?: string }) => React.createElement(
      Native.View,
      null,
      React.createElement(Native.Text, null, title),
      subtitle ? React.createElement(Native.Text, null, subtitle) : null,
    ),
    Text: ({ children }: { children: ReactNode }) => React.createElement(Native.Text, null, children),
  };
});
jest.mock('@/components/chat/markdown/code-block', () => {
  const React = require('react') as typeof import('react');
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    CodeBlock: ({ code, language }: { code: string; language?: string }) => React.createElement(Text, null, `${language}:${code}`),
  };
});

import { SessionChangesSheet } from '@/components/chat/session-changes-sheet';

describe('session changes review', () => {
  test('shows a real file patch and makes the read-only limit clear', async () => {
    const loadChanges = jest.fn().mockResolvedValue({
      supported: true,
      files: [{ path: 'src/main.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ actual diff @@' }],
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(SessionChangesSheet, {
        visible: true,
        sessionId: 'session-1',
        onClose: () => undefined,
        loadChanges,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = renderer.root.findAllByType(RNText).map((node) => String(node.props.children)).join('\n');
    expect(loadChanges).toHaveBeenCalledWith('session-1');
    expect(text).toContain('src/main.ts');
    expect(text).toContain('diff:@@ actual diff @@');
    expect(text).toContain('Read-only review. This backend does not offer approve or reject for file changes.');
    renderer.unmount();
  });

  test('says when the backend has no real session diff API', async () => {
    const loadChanges = jest.fn().mockResolvedValue({ supported: false, files: [] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(SessionChangesSheet, {
        visible: true,
        sessionId: 'session-1',
        onClose: () => undefined,
        loadChanges,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = renderer.root.findAllByType(RNText).map((node) => String(node.props.children)).join('\n');
    expect(text).toContain('This backend does not expose session diffs. Changes are unavailable here.');
    expect(text).not.toContain('Read-only review.');
    renderer.unmount();
  });
});
