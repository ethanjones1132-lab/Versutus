const EXPO_PUSH_TOKEN = /^ExponentPushToken\[.+\]$/;
const DEFAULT_PREFERENCES = Object.freeze({
  enabled: false,
  richBody: false,
  widgetUpdates: false,
  botIds: [],
  quietHours: null,
  quietHoursAllowApprovals: false,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function validBotIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((botId) => typeof botId !== 'string' || botId.trim().length === 0)) {
    throw new Error('botIds must be an array of non-empty strings');
  }
  return [...new Set(value.map((botId) => botId.trim()))];
}

function validQuietHours(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || !Number.isInteger(value.startMinutes)
    || !Number.isInteger(value.endMinutes)
    || value.startMinutes < 0
    || value.startMinutes >= 24 * 60
    || value.endMinutes < 0
    || value.endMinutes >= 24 * 60) {
    throw new Error('quietHours must contain integer startMinutes and endMinutes between 0 and 1439');
  }
  return { startMinutes: value.startMinutes, endMinutes: value.endMinutes };
}

function preferencesFrom(row) {
  return {
    ...DEFAULT_PREFERENCES,
    ...(isRecord(row) ? row : {}),
    botIds: Array.isArray(row?.botIds) ? row.botIds : [],
    quietHours: isRecord(row?.quietHours) ? row.quietHours : null,
    // A legacy row with no such field reads as off, never as on.
    quietHoursAllowApprovals: row?.quietHoursAllowApprovals === true,
  };
}

/** A client-supplied device id: a stable identifier, never free text. */
const BOOTSTRAP_DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The push row this caller owns.
 *
 * A paired device grant is its own identity, and a client-supplied id is
 * ignored for it. A caller holding the Gate's bootstrap token has no grant —
 * and on 2026-09-16 that was the phone, so every registration was refused and
 * push could never reach it. The bootstrap token is already full operator
 * access, so refusing it push protects nothing; what must still hold is that it
 * cannot overwrite a PAIRED device's row. It registers under its own
 * well-formed device id in a separate `bootstrap:` namespace.
 */
function requireDevice(ctx, params) {
  const deviceId = ctx?.deviceId;
  if (typeof deviceId === 'string' && deviceId.length > 0) return deviceId;
  const supplied = params?.deviceId;
  if (ctx?.bootstrap === true && typeof supplied === 'string' && BOOTSTRAP_DEVICE_ID.test(supplied)) {
    return `bootstrap:${supplied}`;
  }
  const error = new Error('A paired device grant is required');
  error.status = 403;
  error.code = 'pairing_required';
  throw error;
}

export function createPushRpc({ tokens, send }) {
  if (!tokens || typeof tokens.upsert !== 'function' || typeof tokens.get !== 'function' || typeof tokens.remove !== 'function') {
    throw new Error('tokens must provide upsert(), get(), and remove()');
  }
  if (typeof send !== 'function') throw new Error('send must be a function');

  return {
    'notifications.register': async (params, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const expoPushToken = requiredString(params?.expoPushToken, 'expoPushToken');
      if (!EXPO_PUSH_TOKEN.test(expoPushToken)) {
        throw new Error('expoPushToken must match ExponentPushToken[...]');
      }
      const platform = requiredString(params?.platform, 'platform');
      const timezone = requiredString(params?.timezone, 'timezone');
      return tokens.upsert(deviceId, { expoPushToken, platform, timezone });
    },

    'notifications.deregister': async (params, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const removed = await tokens.remove(deviceId);
      return { removed };
    },

    'notifications.preferences.get': async (params, ctx) => {
      const deviceId = requireDevice(ctx, params);
      return preferencesFrom(await tokens.get(deviceId));
    },

    'notifications.preferences.set': async (params, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const patch = {
        ...(optionalBoolean(params?.enabled, 'enabled') === undefined ? {} : { enabled: params.enabled }),
        ...(optionalBoolean(params?.richBody, 'richBody') === undefined ? {} : { richBody: params.richBody }),
        ...(optionalBoolean(params?.widgetUpdates, 'widgetUpdates') === undefined ? {} : { widgetUpdates: params.widgetUpdates }),
        ...(validBotIds(params?.botIds) === undefined ? {} : { botIds: validBotIds(params.botIds) }),
        ...(validQuietHours(params?.quietHours) === undefined ? {} : { quietHours: validQuietHours(params.quietHours) }),
        ...(optionalBoolean(params?.quietHoursAllowApprovals, 'quietHoursAllowApprovals') === undefined
          ? {}
          : { quietHoursAllowApprovals: params.quietHoursAllowApprovals }),
      };
      return tokens.upsert(deviceId, patch);
    },

    'notifications.test': async (params, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const row = await tokens.get(deviceId);
      if (!row?.expoPushToken) return { skipped: 'no-token' };
      const result = await send([{
        to: row.expoPushToken,
        title: 'Versutus notification test',
        body: '',
        data: { kind: 'test' },
        channelId: 'model-replies',
        sound: 'default',
      }]);
      const deadTokens = Array.isArray(result?.deadTokens) ? result.deadTokens : [];
      await Promise.all(deadTokens.map((token) => tokens.removeByToken(token)));
      return result;
    },
  };
}
