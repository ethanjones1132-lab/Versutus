import { releaseProfiles } from './profiles/registry.mjs';

const SCHEMA_VERSION = 2;
const KIND = 'provider';
/** Provider types with a shipped profile — the only ones a remote mode can use. */
const PROVIDER_TYPES = new Set(releaseProfiles.keys());
const MODES = new Set(['api_key', 'oauth', 'local_interface']);
const REMOTE_PROTOCOLS = new Set(['openai_chat', 'openai_responses', 'anthropic_messages']);
const LOCAL_PROTOCOL = 'versutus_provider_v1';

const API_KEY_FIELDS = new Set(['mode', 'protocol', 'baseUrl', 'credentialRef']);
const OAUTH_FIELDS = new Set(['mode', 'protocol', 'resourceBaseUrl', 'oauthProfileId']);
const LOCAL_FIELDS = new Set(['mode', 'protocol', 'manifestUrl', 'adapterCredentialRef', 'credentialCustodian']);
const TOP_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'label',
  'providerType',
  'enabled',
  'registration',
  'catalogPolicy',
  'requestPolicy',
]);

function err(errors, field, message) {
  errors.push({ field, message });
}

function requireObject(value, field, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(errors, field, 'must be an object');
    return false;
  }
  return true;
}

function requireString(value, field, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    err(errors, field, 'must be a non-empty string');
    return false;
  }
  return true;
}

function rejectUnknown(object, allowed, prefix, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      err(errors, prefix ? `${prefix}.${key}` : key, 'is not allowed');
    }
  }
}

function validateRegistration(registration, errors) {
  if (!requireObject(registration, 'registration', errors)) return;
  if (!requireString(registration.mode, 'registration.mode', errors)) return;
  if (!MODES.has(registration.mode)) {
    err(errors, 'registration.mode', `must be one of [${[...MODES].join(', ')}]`);
    return;
  }

  if (registration.mode === 'api_key') {
    rejectUnknown(registration, API_KEY_FIELDS, 'registration', errors);
    if (requireString(registration.protocol, 'registration.protocol', errors) && !REMOTE_PROTOCOLS.has(registration.protocol)) {
      err(errors, 'registration.protocol', `must be one of [${[...REMOTE_PROTOCOLS].join(', ')}]`);
    }
    requireString(registration.baseUrl, 'registration.baseUrl', errors);
    requireString(registration.credentialRef, 'registration.credentialRef', errors);
    return;
  }

  if (registration.mode === 'oauth') {
    rejectUnknown(registration, OAUTH_FIELDS, 'registration', errors);
    if (requireString(registration.protocol, 'registration.protocol', errors) && !REMOTE_PROTOCOLS.has(registration.protocol)) {
      err(errors, 'registration.protocol', `must be one of [${[...REMOTE_PROTOCOLS].join(', ')}]`);
    }
    requireString(registration.resourceBaseUrl, 'registration.resourceBaseUrl', errors);
    requireString(registration.oauthProfileId, 'registration.oauthProfileId', errors);
    return;
  }

  rejectUnknown(registration, LOCAL_FIELDS, 'registration', errors);
  if (registration.protocol !== LOCAL_PROTOCOL) {
    err(errors, 'registration.protocol', `must be ${LOCAL_PROTOCOL}`);
  }
  requireString(registration.manifestUrl, 'registration.manifestUrl', errors);
  if (registration.adapterCredentialRef !== undefined) {
    requireString(registration.adapterCredentialRef, 'registration.adapterCredentialRef', errors);
  }
  if (registration.credentialCustodian !== 'external') {
    err(errors, 'registration.credentialCustodian', "must be 'external'");
  }
}

export function validateProviderRegistration(value) {
  const errors = [];
  if (!requireObject(value, '', errors)) {
    return { ok: false, errors: errors.map((item) => (item.field === '' ? { field: 'value', message: item.message } : item)) };
  }

  rejectUnknown(value, TOP_FIELDS, '', errors);

  if (value.schemaVersion !== SCHEMA_VERSION) {
    err(errors, 'schemaVersion', `must be ${SCHEMA_VERSION}`);
  }
  if (value.kind !== KIND) {
    err(errors, 'kind', `must be '${KIND}'`);
  }
  requireString(value.id, 'id', errors);
  requireString(value.label, 'label', errors);
  if (requireString(value.providerType, 'providerType', errors)) {
    // A remote provider is reached through a shipped profile (origins, models
    // path, auth headers). `profileIdFor` silently falls back to 'openai' for an
    // unknown type, so without this an unrecognised type registers cleanly and
    // then fails at request time against the wrong vendor's shape entirely.
    // Local-interface providers bring their own manifest and are exempt.
    const mode = value.registration?.mode;
    if (mode && mode !== 'local_interface' && !PROVIDER_TYPES.has(value.providerType)) {
      err(
        errors,
        'providerType',
        `must be one of [${[...PROVIDER_TYPES].join(', ')}] — no profile ships for "${value.providerType}". A CLI agent such as OpenCode is registered as a CLI environment, not a provider.`,
      );
    }
  }
  if (typeof value.enabled !== 'boolean') {
    err(errors, 'enabled', 'must be a boolean');
  }

  validateRegistration(value.registration, errors);

  if (requireObject(value.catalogPolicy, 'catalogPolicy', errors)) {
    rejectUnknown(value.catalogPolicy, new Set(['ttlSeconds', 'allowLastKnownGood']), 'catalogPolicy', errors);
    if (!Number.isInteger(value.catalogPolicy.ttlSeconds) || value.catalogPolicy.ttlSeconds < 0) {
      err(errors, 'catalogPolicy.ttlSeconds', 'must be a non-negative integer');
    }
    if (typeof value.catalogPolicy.allowLastKnownGood !== 'boolean') {
      err(errors, 'catalogPolicy.allowLastKnownGood', 'must be a boolean');
    }
  }

  if (requireObject(value.requestPolicy, 'requestPolicy', errors)) {
    rejectUnknown(value.requestPolicy, new Set(['timeoutMs']), 'requestPolicy', errors);
    if (!Number.isInteger(value.requestPolicy.timeoutMs) || value.requestPolicy.timeoutMs < 1) {
      err(errors, 'requestPolicy.timeoutMs', 'must be a positive integer');
    }
  }

  return { ok: errors.length === 0, errors };
}
