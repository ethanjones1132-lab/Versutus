import type { GatewayCapabilityField } from '@/lib/portal/manifest';

export function defaultValueForField(field: GatewayCapabilityField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'string-list':
      return [];
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return field.options?.[0] ?? '';
    case 'secret-ref':
    case 'string':
    default:
      return '';
  }
}

export function defaultConfigForFields(
  fields: GatewayCapabilityField[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    config[field.key] = defaultValueForField(field);
  }
  return config;
}

export function stringifyFieldValue(field: GatewayCapabilityField, value: unknown): string {
  if (field.type === 'string-list') {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : '';
  }
  if (field.type === 'boolean') return value ? 'true' : 'false';
  if (value === undefined || value === null) return '';
  return String(value);
}

export function parseFieldValue(field: GatewayCapabilityField, text: string): unknown {
  const trimmed = text.trim();
  switch (field.type) {
    case 'string-list':
      return trimmed ? trimmed.split(',').map((item) => item.trim()).filter(Boolean) : [];
    case 'number': {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case 'boolean':
      return trimmed === 'true' || trimmed === '1' || trimmed.toLowerCase() === 'yes';
    default:
      return trimmed;
  }
}

export function isValidInstanceId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id) && id !== 'registry';
}
