import { chatHeaderSubtitle, chatHeaderTitle } from '@/lib/motion/chat-header-layout';

test('a group room titles the room, not the gateway', () => {
  expect(
    chatHeaderTitle({ gatewayName: 'Office Gate', groupName: 'Standup' }),
  ).toBe('Standup');
});

test('a group room still titles the room when a backend label is also present', () => {
  expect(
    chatHeaderTitle({
      gatewayName: 'Office Gate',
      backendLabel: 'Hermes',
      groupName: 'Standup',
    }),
  ).toBe('Standup');
});

test('a blank group name still titles the gateway', () => {
  expect(chatHeaderTitle({ gatewayName: 'Office Gate', groupName: '  ' })).toBe('Office Gate');
});

test('a thread titles the backend, else the gateway', () => {
  expect(chatHeaderTitle({ gatewayName: 'Office Gate', backendLabel: 'Hermes' })).toBe('Hermes');
  expect(chatHeaderTitle({ gatewayName: 'Office Gate' })).toBe('Office Gate');
});

test('a thread that can pick a model draws the model as its tappable subtitle', () => {
  expect(
    chatHeaderSubtitle({
      gatewayName: 'Office Gate',
      modelLabel: 'deepseek-v4.1-flash',
      modelPress: true,
      backendLabel: 'Hermes',
      statusDetail: 'Reconnecting',
    }),
  ).toBe('deepseek-v4.1-flash');
});

test('no model press means the subtitle falls back to the gateway line, detail folded in', () => {
  expect(
    chatHeaderSubtitle({
      gatewayName: 'Office Gate',
      modelLabel: 'deepseek-v4.1-flash',
      modelPress: false,
      backendLabel: 'Hermes',
      statusDetail: 'Reconnecting',
    }),
  ).toBe('via Office Gate · Reconnecting');
  expect(
    chatHeaderSubtitle({
      gatewayName: 'Office Gate',
      modelPress: false,
      backendLabel: 'Hermes',
    }),
  ).toBe('via Office Gate');
});

test('a room attributes the gateway too', () => {
  expect(
    chatHeaderSubtitle({
      gatewayName: 'Office Gate',
      modelPress: false,
      groupName: 'Standup',
      statusDetail: 'Pairing',
    }),
  ).toBe('via Office Gate · Pairing');
});

test('with nothing else to say the subtitle is the connection detail', () => {
  expect(
    chatHeaderSubtitle({ gatewayName: 'Office Gate', modelPress: false, statusDetail: 'Looking for Office Gate' }),
  ).toBe('Looking for Office Gate');
  expect(chatHeaderSubtitle({ gatewayName: 'Office Gate', modelPress: false })).toBe(
    'Ready for chat and slash commands',
  );
});
