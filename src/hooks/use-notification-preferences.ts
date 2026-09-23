// ─── Gate notification preferences (Solution A5/A6) ────────────────────────
// The Settings → Notifications screen reads and writes this device's relay
// preferences over the paired-device grant (`notifications.preferences.*`),
// asks for the OS permission from the enable toggle — a user action, never
// at launch — and offers the Gate's own `notifications.test` round trip.

import { useCallback, useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';

import { useGateway } from '@/context/gateway-provider';
import { describeGatewayError } from '@/lib/gateway/error-humanizer';
import { pushDeviceParams, syncPushRegistration } from '@/lib/notifications/push-registration';

export type NotificationPreferences = {
  enabled: boolean;
  richBody: boolean;
  widgetUpdates: boolean;
  botIds: string[];
  quietHours: { startMinutes: number; endMinutes: number } | null;
  quietHoursAllowApprovals: boolean;
};

const DEFAULT_PREFS: NotificationPreferences = {
  enabled: false,
  richBody: false,
  widgetUpdates: false,
  botIds: [],
  quietHours: null,
  quietHoursAllowApprovals: false,
};

function normalize(raw: unknown): NotificationPreferences {
  const row = (raw ?? {}) as Partial<NotificationPreferences>;
  return {
    enabled: row.enabled === true,
    richBody: row.richBody === true,
    widgetUpdates: row.widgetUpdates === true,
    quietHoursAllowApprovals: row.quietHoursAllowApprovals === true,
    botIds: Array.isArray(row.botIds) ? row.botIds.filter((id): id is string => typeof id === 'string') : [],
    quietHours:
      row.quietHours &&
      Number.isInteger(row.quietHours.startMinutes) &&
      Number.isInteger(row.quietHours.endMinutes)
        ? { startMinutes: row.quietHours.startMinutes, endMinutes: row.quietHours.endMinutes }
        : null,
  };
}

export function useNotificationPreferences() {
  const { activeGateway, gatewayRequest, status } = useGateway();
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFS);
  // The first read has not landed yet: DEFAULT_PREFS is a placeholder, not
  // the Gate's answer, so consumers must skeleton until load() settles it.
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const isCustom = activeGateway?.kind === 'custom';
  const connected = status === 'connected' && isCustom;

  useEffect(() => {
    let cancelled = false;
    Notifications.getPermissionsAsync()
      .then((result) => {
        if (!cancelled) setPermission(result.granted ? 'granted' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setPermission('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!connected) {
      // Nothing will be fetched, so no read is in flight — never spin.
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    let sentDeviceId = false;
    try {
      const params = await pushDeviceParams();
      sentDeviceId = true;
      const raw = await gatewayRequest<Record<string, unknown>>('notifications.preferences.get', params);
      setPrefs(normalize(raw));
    } catch (err) {
      // A refusal that arrived after the phone named itself is the Gate's own
      // verdict (unpaired), not the missing-identity copy.
      setError(describeGatewayError(err, { sentDeviceId }));
    } finally {
      setLoading(false);
    }
  }, [connected, gatewayRequest]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const setPatch = useCallback(
    async (patch: Partial<NotificationPreferences>) => {
      setSaving(true);
      setError(null);
      let sentDeviceId = false;
      try {
        const params = await pushDeviceParams();
        sentDeviceId = true;
        const raw = await gatewayRequest<Record<string, unknown>>('notifications.preferences.set', {
          ...(patch as Record<string, unknown>),
          // The row a bootstrap-token phone owns is filed under its device id.
          ...params,
        });
        setPrefs(normalize(raw));
      } catch (err) {
        setError(describeGatewayError(err, { sentDeviceId }));
      } finally {
        setSaving(false);
      }
    },
    [gatewayRequest],
  );

  /**
   * The enable toggle. Turning on asks the OS first — permission comes from
   * this user action, never at launch — then registers the token the same
   * connect-time path uses. Returns false when there is nothing to save.
   */
  const setEnabled = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (on) {
        try {
          const result = await Notifications.requestPermissionsAsync();
          setPermission(result.granted ? 'granted' : 'denied');
          if (!result.granted) {
            setError('Notifications are off for Versutus in the system settings — allow them, then try again.');
            return false;
          }
        } catch {
          setError('The system permission request failed — try again.');
          return false;
        }
        await setPatch({ enabled: true });
        // The token may postdate the last connect (fresh permission): sync it now.
        try {
          await syncPushRegistration({
            rpcRequest: (method, params) => gatewayRequest(method, params ?? {}),
          });
        } catch {
          // Registration retries on the next connect; the toggle still stands.
        }
        return true;
      }
      await setPatch({ enabled: false });
      return true;
    },
    [gatewayRequest, setPatch],
  );

  const sendTest = useCallback(async () => {
    setSendingTest(true);
    setTestResult(null);
    setError(null);
    let sentDeviceId = false;
    try {
      const params = await pushDeviceParams();
      sentDeviceId = true;
      const result = (await gatewayRequest<Record<string, unknown>>('notifications.test', params)) as {
        skipped?: string;
        ok?: boolean;
      };
      if (typeof result?.skipped === 'string') {
        setTestResult(
          result.skipped === 'no-token'
            ? 'The Gate has no token for this device yet — reconnect, then try again.'
            : `The Gate skipped the test (${result.skipped}).`,
        );
      } else if (result?.ok !== true) {
        setError('The Gate could not send the test through Expo — try again.');
      } else {
        setTestResult('Test sent — it should arrive with the app backgrounded or killed.');
      }
    } catch (err) {
      setError(describeGatewayError(err, { sentDeviceId }));
    } finally {
      setSendingTest(false);
    }
  }, [gatewayRequest]);

  return {
    prefs,
    loading,
    saving,
    sendingTest,
    permission,
    error,
    testResult,
    connected,
    setPatch,
    setEnabled,
    sendTest,
    reload: load,
  };
}
