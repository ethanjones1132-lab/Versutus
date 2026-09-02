import { botToEditInput, buildBotUpdatePatch, type PublicBot } from '@/lib/gateway/bots';

function bot(overrides: Partial<PublicBot> = {}): PublicBot {
  return {
    id: 'coder',
    displayName: 'Coder',
    routable: true,
    ...overrides,
  };
}

describe('bot edit form helpers', () => {
  test('botToEditInput prefills from what the Gate reports', () => {
    const input = botToEditInput(
      bot({
        description: 'Reads code and writes findings',
        model: { default: 'opencode-zen/laguna-s-2.1-free', provider: 'opencode-zen' },
      }),
    );
    expect(input).toEqual({
      name: 'Coder',
      description: 'Reads code and writes findings',
      modelId: 'opencode-zen/laguna-s-2.1-free',
      providerId: 'opencode-zen',
    });
  });

  test('botToEditInput tolerates an older Gate that reports neither description nor pin', () => {
    expect(botToEditInput(bot())).toEqual({
      name: 'Coder',
      description: '',
      modelId: '',
      providerId: '',
    });
  });

  test('buildBotUpdatePatch keeps only the fields the form actually filled', () => {
    // Blank means "leave unchanged" — the patch must omit it entirely so the
    // Gate never wipes a stored value the form did not show.
    expect(buildBotUpdatePatch({ description: 'Reads code' })).toEqual({ description: 'Reads code' });
  });

  test('buildBotUpdatePatch trims values and drops whitespace-only ones', () => {
    expect(
      buildBotUpdatePatch({
        description: '  Reads code  ',
        soul: '   ',
        modelId: 'zen/laguna',
        providerId: '',
      }),
    ).toEqual({ description: 'Reads code', modelId: 'zen/laguna' });
  });

  test('an all-blank form produces an empty patch instead of a wipe', () => {
    expect(buildBotUpdatePatch({})).toEqual({});
  });

  test('explicit null model fields are preserved as clear instructions', () => {
    expect(buildBotUpdatePatch({ modelId: null, providerId: null })).toEqual({
      modelId: null,
      providerId: null,
    });
  });
});
