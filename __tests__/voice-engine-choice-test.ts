import {
  chooseVoiceEngine,
  type VoiceEngineCapabilities,
} from '@/lib/voice/voice-engine-choice';

function caps(
  local: VoiceEngineCapabilities['engines']['local'],
  codex: VoiceEngineCapabilities['engines']['codex'] = { state: 'disabled', reason: 'no codex' },
  enabled = true,
): VoiceEngineCapabilities {
  return { enabled, engines: { local, codex } };
}

const localReady = { state: 'ready' } as const;
const codexReady = { state: 'ready' } as const;

describe('chooseVoiceEngine', () => {
  test('the phone is chosen when that is the preference, with no fallback', () => {
    expect(chooseVoiceEngine('phone', caps(localReady, codexReady))).toEqual({ engine: 'phone' });
  });

  test('the kill switch leaves only the phone, and names why', () => {
    expect(chooseVoiceEngine('local', caps(localReady, codexReady, false))).toEqual({
      engine: 'phone',
      fellBackFrom: 'local',
      reason: 'Gate voice is turned off.',
    });
    expect(chooseVoiceEngine('auto', caps(localReady, codexReady, false))).toEqual({
      engine: 'phone',
      reason: 'Gate voice is turned off.',
    });
  });

  test('auto prefers local, then codex, then the phone', () => {
    expect(chooseVoiceEngine('auto', caps(localReady, codexReady)).engine).toBe('local');
    expect(chooseVoiceEngine('auto', caps({ state: 'not-installed' }, codexReady)).engine).toBe('codex');
    const neither = chooseVoiceEngine('auto', caps({ state: 'not-installed', reason: 'not installed' }));
    expect(neither.engine).toBe('phone');
    expect(neither.fellBackFrom).toBeUndefined();
    expect(neither.reason).toBe('not installed');
  });

  test('an explicit ready engine is chosen unchanged', () => {
    expect(chooseVoiceEngine('local', caps(localReady, codexReady))).toEqual({ engine: 'local' });
    expect(chooseVoiceEngine('codex', caps(localReady, codexReady))).toEqual({ engine: 'codex' });
  });

  test('an unavailable local falls to codex, then phone, naming the fallback', () => {
    const notReady = { state: 'not-installed', reason: 'PC voice is not installed' } as const;
    expect(chooseVoiceEngine('local', caps(notReady, codexReady))).toEqual({
      engine: 'codex',
      fellBackFrom: 'local',
      reason: 'PC voice is not installed',
    });
    expect(chooseVoiceEngine('local', caps(notReady, { state: 'disabled' }))).toEqual({
      engine: 'phone',
      fellBackFrom: 'local',
      reason: 'PC voice is not installed',
    });
  });

  test('an unavailable codex falls to local, then phone, naming the fallback', () => {
    const notReady = { state: 'over-allowance', reason: 'out of minutes' } as const;
    expect(chooseVoiceEngine('codex', caps(localReady, notReady))).toEqual({
      engine: 'local',
      fellBackFrom: 'codex',
      reason: 'out of minutes',
    });
    expect(chooseVoiceEngine('codex', caps({ state: 'not-installed' }, notReady))).toEqual({
      engine: 'phone',
      fellBackFrom: 'codex',
      reason: 'out of minutes',
    });
  });

  test('a missing reason still names the fallback engine, never silently', () => {
    const choice = chooseVoiceEngine('local', caps({ state: 'installing' }, { state: 'disabled' }));
    expect(choice.engine).toBe('phone');
    expect(choice.fellBackFrom).toBe('local');
    expect(choice.reason).toBeTruthy();
  });
});
