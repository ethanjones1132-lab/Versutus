import { normalizeOpenClawModel, normalizeOpenClawSession, readOpenClawCollection } from '@/lib/portal/openclaw-mapping';

describe('OpenClaw response mapping', () => {
  test('reads named model and session collections', () => {
    expect(readOpenClawCollection({ models: [{ id: 'm1' }] }, ['models'])).toEqual([{ id: 'm1' }]);
    expect(readOpenClawCollection({ sessions: [{ id: 's1' }] }, ['sessions'])).toEqual([{ id: 's1' }]);
  });

  test('normalizes named collection entries', () => {
    expect(normalizeOpenClawModel({ id: 'm1' })?.id).toBe('m1');
    expect(normalizeOpenClawSession({ id: 's1', createdAt: 10 })?.id).toBe('s1');
  });
});
