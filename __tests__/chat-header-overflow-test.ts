declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatHeaderSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-header.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('chat header subtitle fits beside usage and controls', () => {
  test('the model button yields width to the session usage note and ellipsizes long names', () => {
    const src = readChatHeaderSource();
    const modelButton = src.match(/onPress=\{onModelPress\}[\s\S]*?<\/PressableScale>/)?.[0];
    const modelStyle = src.match(/subtitleRow:\s*\{([^}]+)\}/)?.[1];
    const spendStyle = src.match(/spend:\s*\{([^}]+)\}/)?.[1];

    expect(modelButton).toBeDefined();
    expect(modelButton).toContain('accessibilityLabel={showModel ? `Model: ${modelLabel}. Change model.` : undefined}');
    expect(modelButton).toContain('<Text variant="caption" color="secondary" numberOfLines={1} style={styles.subtitle}>');
    expect(modelStyle).toMatch(/flex:\s*1/);
    expect(modelStyle).toMatch(/minWidth:\s*0/);
    expect(modelStyle).toMatch(/flexShrink:\s*1/);
    expect(spendStyle).toMatch(/minWidth:\s*0/);
    expect(spendStyle).toMatch(/flexShrink:\s*1/);
    expect(src).toContain('<Text variant="caption" color="tertiary" numberOfLines={1} style={styles.spend}>');
  });

  test('the back and options controls keep their fixed hit targets and accessible labels', () => {
    const src = readChatHeaderSource();
    const controlStyle = src.match(/control:\s*\{([^}]+)\}/)?.[1];

    expect(controlStyle).toMatch(/width:\s*40/);
    expect(controlStyle).toMatch(/height:\s*40/);
    expect(src).toContain('accessibilityLabel="Back to roster"');
    expect(src).toContain('accessibilityLabel="Chat options"');
    expect(src).toContain('hitSlop={10}');
  });
});

describe('the live call clock fits beside the title and options', () => {
  test('the live control keeps its own width instead of the 40 pt icon circle', () => {
    const src = readChatHeaderSource();
    const liveStyle = src.match(/liveCallControl:\s*\{([^}]+)\}/)?.[1];

    expect(liveStyle).toBeDefined();
    // The shared `control` style pins width: 40 for the icon circles; the live
    // control has to opt back out of it or the clock is cut to "0:…".
    expect(liveStyle).toMatch(/width:\s*'auto'/);
    expect(liveStyle).toMatch(/flexShrink:\s*0/);
    // A floor that fits "00:00" in the 13 pt caption beside the 8 pt dot:
    // 8 dot + 4 gap + the clock + 8 padding is already more than 40.
    const minWidth = Number(liveStyle?.match(/minWidth:\s*(\d+)/)?.[1]);
    expect(minWidth).toBeGreaterThanOrEqual(64);
    expect(liveStyle).toMatch(/maxWidth:\s*156/);
    // The live control is still drawn from the shared circle plus the live
    // overrides, so its alignment, radius and 44 pt hit target are unchanged.
    expect(src).toContain(
      'style={[styles.control, styles.callHitTarget, styles.callControl, callMode !== \'start\' && styles.liveCallControl]}',
    );
    expect(src).toContain('minWidth: 44');
    expect(src).toContain('minHeight: 44');
  });

  test('the clock never wraps or drops digits, and the titles shrink first', () => {
    const src = readChatHeaderSource();
    const callText = src.match(/callText:\s*\{([^}]+)\}/)?.[1];
    const titles = src.match(/titles:\s*\{([^}]+)\}/)?.[1];
    const identity = src.match(/identity:\s*\{([^}]+)\}/)?.[1];

    expect(callText).toMatch(/fontVariant:\s*\['tabular-nums'\]/);
    expect(src).toMatch(
      /<Text variant="caption"[\s\S]{0,120}?numberOfLines=\{1\}\s+style=\{styles\.callText\}>/,
    );
    // "On a call with <Bot>" may ellipsize the Bot name, never the word call.
    expect(src).toContain('On a call with ${callLabel ?? \'Bot\'}');

    // The title block is what yields: it can shrink and ellipsize while the
    // live control (flexShrink: 0) keeps its clock.
    expect(identity).toMatch(/flexShrink:\s*1/);
    expect(identity).toMatch(/minWidth:\s*0/);
    expect(titles).toMatch(/flexShrink:\s*1/);
    expect(titles).toMatch(/minWidth:\s*0/);
  });
});
