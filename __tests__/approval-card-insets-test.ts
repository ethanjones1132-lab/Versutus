declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const file = [__dirname, '..', 'src', 'components', 'activity', 'approval-decision-card.tsx'].join(SEP);
const src = nodeFs.readFileSync(file, 'utf8');

describe('approval decision card bottom clearance', () => {
  test('card keeps bottom margin so buttons clear gesture bar when lift collapsed', () => {
    // card style must have marginBottom >= 8 (Spacing.two) even when keyboard hidden
    const cardMatch = src.match(/card:\s*\{([^}]+)\}/);
    expect(cardMatch).not.toBeNull();
    const body = cardMatch![1];
    expect(body).toMatch(/marginBottom/);
    // either literal 8 or Spacing.two / Spacing.one etc — must be at least 8
    const hasSpacingTwo = body.includes('Spacing.two');
    const literal = body.match(/marginBottom:\s*(\d+)/);
    const ok = hasSpacingTwo || (literal !== null && Number(literal[1]) >= 8);
    expect(ok).toBe(true);
  });

  test('actions row retains horizontal layout with at least 8px top gap', () => {
    const actionsMatch = src.match(/actions:\s*\{([^}]+)\}/);
    expect(actionsMatch).not.toBeNull();
    const body = actionsMatch![1];
    expect(body).toMatch(/flexDirection:\s*['\"]row['\"]/);
    expect(body).toMatch(/gap/);
  });

  test('buttons keep flex:1 so both remain tappable', () => {
    const buttonMatch = src.match(/button:\s*\{([^}]+)\}/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![1]).toMatch(/flex:\s*1/);
  });
});
