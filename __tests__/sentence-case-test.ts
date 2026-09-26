import { sentenceCase } from '@/lib/copy/sentence-case';

describe('sentenceCase', () => {
  test('an all-caps eyebrow reads in sentence case', () => {
    expect(sentenceCase('HANDS-FREE CALL')).toBe('Hands-free call');
    expect(sentenceCase('GROUP ROOMS')).toBe('Group rooms');
    expect(sentenceCase('ACTION')).toBe('Action');
    expect(sentenceCase('  READ ONLY ')).toBe('Read only');
  });

  test('a label the caller already cased is left exactly as written', () => {
    expect(sentenceCase('Bot')).toBe('Bot');
    expect(sentenceCase('Run on the TLS channel')).toBe('Run on the TLS channel');
  });

  test('empty and symbol-only labels survive', () => {
    expect(sentenceCase('')).toBe('');
    expect(sentenceCase('—')).toBe('—');
  });
});
