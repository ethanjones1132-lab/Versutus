import { gateLineFor, greetingFor } from '@/lib/home/greeting';

function at(hour: number): Date {
  const date = new Date(2026, 8, 25, hour, 30);
  return date;
}

describe('greetingFor', () => {
  test.each([
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [16, 'Good afternoon'],
    [17, 'Good evening'],
    [21, 'Good evening'],
    [22, 'Working late'],
    [2, 'Working late'],
  ])('%i:30 reads "%s"', (hour, expected) => {
    expect(greetingFor(at(hour))).toBe(expected);
  });
});

describe('gateLineFor', () => {
  const base = { gatewayName: 'Atlas', readyBots: 5, totalBots: 6 };

  test('a connected Gate counts the Bots that can take work', () => {
    expect(gateLineFor({ ...base, status: 'connected' })).toBe('Atlas · 5 of 6 Bots ready');
    expect(gateLineFor({ ...base, status: 'connected', readyBots: 6 })).toBe('Atlas · all 6 Bots ready');
    expect(gateLineFor({ ...base, status: 'connected', readyBots: 1, totalBots: 1 })).toBe(
      'Atlas · your Bot is ready',
    );
    expect(gateLineFor({ ...base, status: 'connected', readyBots: 0, totalBots: 0 })).toBe('Atlas is connected');
  });

  test('every other state says what the operator can expect, not the protocol state', () => {
    expect(gateLineFor({ ...base, status: 'connecting' })).toBe('Reaching Atlas…');
    expect(gateLineFor({ ...base, status: 'reconnecting' })).toBe('Reaching Atlas…');
    expect(gateLineFor({ ...base, status: 'pairing' })).toBe('Atlas is waiting for this phone to be approved');
    expect(gateLineFor({ ...base, status: 'disconnected' })).toBe('Atlas is offline — messages will wait');
  });
});
