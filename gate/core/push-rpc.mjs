const EXPO_PUSH_TOKEN = /^ExponentPushToken\[.+\]$/;
const DEFAULT_PREFERENCES = Object.freeze({
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
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
  };
}

function requireDevice(ctx) {
  const deviceId = ctx?.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    const error = new Error('A paired device grant is required');
    error.status = 403;
    error.code = 'pairing_required';
    throw error;
  }
  return deviceId;
}

export function createPushRpc({ tokens, send }) {
  if (!tokens || typeof tokens.upsert !== 'function' || typeof tokens.get !== 'function' || typeof tokens.remove !== 'function') {
    throw new Error('tokens must provide upsert(), get(), and remove()');
  }
  if (typeof send !== 'function') throw new Error('send must be a function');

  return {
    'notifications.register': async (params, ctx) => {
      const deviceId = requireDevice(ctx);
      const expoPushToken = requiredString(params?.expoPushToken, 'expoPushToken');
      if (!EXPO_PUSH_TOKEN.test(expoPushToken)) {
        throw new Error('expoPushToken must match ExponentPushToken[...]');
      }
      const platform = requiredString(params?.platform, 'platform');
      const timezone = requiredString(params?.timezone, 'timezone');
      return tokens.upsert(deviceId, { expoPushToken, platform, timezone });
    },

    'notifications.deregister': async (params, ctx) => {
      const deviceId = requireDevice(ctx);
      const removed = await tokens.remove(deviceId);
      return { removed };
    },

    'notifications.preferences.get': async (params, ctx) => {
      const deviceId = requireDevice(ctx);
      return preferencesFrom(await tokens.get(deviceId));
    },

    'notifications.preferences.set': async (params, ctx) => {
      const deviceId = requireDevice(ctx);
      const patch = {
        ...(optionalBoolean(params?.enabled, 'enabled') === undefined ? {} : { enabled: params.enabled }),
        ...(optionalBoolean(params?.richBody, 'richBody') === undefined ? {} : { richBody: params.richBody }),
        ...(validBotIds(params?.botIds) === undefined ? {} : { botIds: validBotIds(params.botIds) }),
        ...(validQuietHours(params?.quietHours) === undefined ? {} : { quietHours: validQuietHours(params.quietHours) }),
      };
      return tokens.upsert(deviceId, patch);
    },

    'notifications.test': async (params, ctx) => {
      const deviceId = requireDevice(ctx);
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
