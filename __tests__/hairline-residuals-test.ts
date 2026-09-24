declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const RESIDUALS = [
  {
    label: 'connection pill',
    parts: ['src', 'components', 'connection-badge.tsx'],
    borders: [{ needle: '{ borderColor: tokens.border }', count: 1 }],
    keep: ['variant="chip"', 'STATUS_LABELS', 'isPairing'],
  },
  {
    label: 'handsfree call controls',
    parts: ['src', 'components', 'voice', 'handsfree-call-banner.tsx'],
    borders: [
      {
        needle: 'style={[styles.control, { borderColor: tokens.border }]}',
        count: 2,
      },
    ],
    keep: ['onPress={muted ? unmute : mute}', 'onPress={skipReply}', 'onPress={end}'],
  },
  {
    label: 'fleet HUD',
    parts: ['src', 'components', 'fleet', 'constellation-view.tsx'],
    borders: [{ needle: 'borderTopColor: tokens.border', count: 1 }],
    keep: ['constellationSummaryCopy', 'onPressApproval', 'relativeLastSeenCopy'],
  },
  {
    label: 'gateway capability pill',
    parts: ['src', 'components', 'gateway', 'gateway-capabilities.tsx'],
    borders: [
      {
        needle: 'borderColor: tokens.border, backgroundColor: tokens.backgroundInset',
        count: 1,
      },
    ],
    keep: ['status === \'ready\'', 'accessibilityState={{ expanded: showAll }}', 'setShowAll'],
  },
  {
    label: 'gateway reachability pill',
    parts: ['src', 'components', 'gateway', 'compact-gateway-list.tsx'],
    borders: [
      {
        needle: 'borderColor: tokens.border, backgroundColor: tokens.backgroundInset',
        count: 1,
      },
    ],
    keep: ['state === \'unreachable\'', 'onDelete', 'onSelect'],
  },
  {
    label: 'group room card',
    parts: ['src', 'components', 'chat', 'group-room-view.tsx'],
    borders: [
      {
        needle: 'backgroundColor: tokens.backgroundRaised, borderColor: tokens.border',
        count: 1,
      },
    ],
    keep: ['setPlanExpanded', 'setDisbandVisible(true)', 'loadHistory'],
  },
  {
    label: 'visual preview metadata',
    parts: ['src', 'app', 'dev', 'preview.tsx'],
    borders: [{ needle: '{ borderColor: tokens.border }', count: 1 }],
    keep: ['scenarioId', 'sessionsVisible', 'scenario.lastError'],
  },
] as const;

it.each(RESIDUALS)('$label rests on the flat border role', ({ parts, borders, keep }) => {
  const src = readSource(...parts);
  expect(src).not.toContain('glassBorder');
  for (const { needle, count } of borders) {
    expect(src.split(needle)).toHaveLength(count + 1);
  }
  for (const needle of keep) {
    expect(src).toContain(needle);
  }
});
