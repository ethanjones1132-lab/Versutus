import {
  defaultConfigForFields,
  isValidInstanceId,
  parseFieldValue,
  stringifyFieldValue,
} from '@/lib/gateway/capability-form';
import type { GatewayCapabilityField } from '@/lib/portal/manifest';

const FIELDS: GatewayCapabilityField[] = [
  { key: 'schedule', label: 'Schedule', type: 'string', required: true },
  { key: 'models', label: 'Models', type: 'string-list', required: true },
  { key: 'streaming', label: 'Streaming', type: 'boolean', default: true },
  { key: 'apiKeyEnv', label: 'API key', type: 'secret-ref', required: true },
];

describe('capability-form', () => {
  test('builds a default config from field types and defaults', () => {
    expect(defaultConfigForFields(FIELDS)).toEqual({
      schedule: '',
      models: [],
      streaming: true,
      apiKeyEnv: '',
    });
  });

  test('round-trips a string-list through stringify/parse', () => {
    const field = FIELDS[1];
    const text = stringifyFieldValue(field, ['a', 'b']);
    expect(parseFieldValue(field, text)).toEqual(['a', 'b']);
  });

  test('parses boolean text', () => {
    expect(parseFieldValue(FIELDS[2], 'true')).toBe(true);
    expect(parseFieldValue(FIELDS[2], 'false')).toBe(false);
  });

  test('rejects reserved or malformed instance ids', () => {
    expect(isValidInstanceId('standup')).toBe(true);
    expect(isValidInstanceId('registry')).toBe(false);
    expect(isValidInstanceId('Standup')).toBe(false);
  });
});
