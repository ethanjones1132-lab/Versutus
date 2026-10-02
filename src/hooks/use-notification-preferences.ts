// ─── Gate notification preferences (Solution A5/A6) ────────────────────────
// The Settings → Notifications screen reads and writes this device's relay
// preferences over the paired-device grant (`notifications.preferences.*`),
// asks for the OS permission from the enable toggle — a user action, never
// at launch — and offers the Gate's own `notifications.test` round trip.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
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

/**
 * What this phone reports about notifications, in the four states the screen can
 * honestly paint.
 *
 * `undetermined` is a state of its own and not a refusal: it is what Android
 * 13+ and every first launch on iOS answer before anybody has been asked, and
 * collapsing it into `denied` told a fresh install its notifications were off.
 * `unknown` means the phone could not be asked at all, which is no fact about
 * the operator's choice and so names nothing.
 */
export type NotificationPermission = 'unknown' | 'granted' | 'denied' | 'undetermined';

/** The three statuses `getPermissionsAsync` reports, and their `canAskAgain`. */
type PermissionAnswer = { granted: boolean; status: string; canAskAgain: boolean };

function permissionFrom(answer: PermissionAnswer): NotificationPermission {
  if (answer.granted) return 'granted';
  if (answer.status === 'denied') return 'denied';
  if (answer.status === 'undetermined') {
    // canAskAgain false is the same final answer spelled the other way round:
    // the one dialog has been spent, so there is nothing left to ask for.
    return answer.canAskAgain === false ? 'denied' : 'undetermined';
  }
  return 'unknown';
}

/** One queued write: the patch the operator asked for, and who is waiting. */
type PendingWrite = {
  patch: Partial<NotificationPreferences>;
  seq: number;
  settle: (saved: boolean) => void;
  /**
   * The gateway generation this patch was computed against, so a queued write
   * is dropped, not re-routed, when the operator switches gateways.
   */
  gatewayEpoch: number;
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
  const [permission, setPermission] = useState<NotificationPermission>('unknown');
  const [error, setError] = useState<string | null>(null);
  // Whether the prefs on screen are the Gate's: a read or write has landed.
  // Until then they are DEFAULT_PREFS, so every switch drawn from them is a
  // guess, and a tap would write one field over preferences never read.
  const [synced, setSynced] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // The last row the Gate itself confirmed. A refused write rolls back to this,
  // never to whatever a reply still in flight claimed.
  const confirmedRef = useRef<NotificationPreferences>(DEFAULT_PREFS);
  // Writes go out one at a time, in the order the operator flipped them: the
  // Gate keeps one row per device, so a second write issued before the first is
  // answered would be computed against a row the first has not confirmed yet.
  const queueRef = useRef<PendingWrite[]>([]);
  const inFlightRef = useRef(false);
  const saveCountRef = useRef(0);
  const seqRef = useRef(0);
  // Reads of the phone are numbered, so an answer that turns up after a newer
  // one — or after this screen is gone — paints nothing.
  const readSeqRef = useRef(0);
  // Reads of the Gate's row are numbered the same way. A `get` issued against
  // gateway A can outlive the switch to B (disconnect cancels no in-flight
  // request), and without this its late answer would paint A's switches over
  // B's — with `synced` left true, so the next tap writes A's row onto B.
  const loadSeqRef = useRef(0);
  // Bumped whenever the active gateway changes. A write queued against one
  // gateway is dropped rather than sent through another's client, and a reply
  // still owed by the old gateway paints nothing on the new screen.
  const gatewayEpochRef = useRef(0);
  const liveRef = useRef(true);

  const isCustom = activeGateway?.kind === 'custom';
  const connected = status === 'connected' && isCustom;
  const activeGatewayId = activeGateway?.id ?? null;

  /**
   * Read what the phone allows right now. A READ, never the request: this
   * decides what a screen paints and must not spend a system dialog the
   * operator did not ask for. `getPermissionsAsync` is called on every mount,
   * every return to the foreground and every write that lands, because this
   * screen is a Stack child — a trip to the OS Settings does not remount it —
   * and a cached first answer would outlive the permission it described.
   */
  const readPermission = useCallback(async (): Promise<NotificationPermission> => {
    const seq = ++readSeqRef.current;
    try {
      const answer = permissionFrom(await Notifications.getPermissionsAsync());
      if (liveRef.current && seq === readSeqRef.current) setPermission(answer);
      return answer;
    } catch {
      if (liveRef.current && seq === readSeqRef.current) setPermission('unknown');
      return 'unknown';
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    liveRef.current = true;
    const refresh = () => {
      if (!cancelled) void readPermission();
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      cancelled = true;
      liveRef.current = false;
      subscription.remove();
    };
  }, [readPermission]);

  const load = useCallback(async () => {
    // Bumped in every branch, so a switch away from a gateway (which re-runs
    // this with `connected` false) retires the answer that gateway still owes.
    const seq = ++loadSeqRef.current;
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
      // A newer load (a gateway change re-ran this) owns the screen now.
      if (seq !== loadSeqRef.current) return;
      const row = normalize(raw);
      confirmedRef.current = row;
      setPrefs(row);
      setSynced(true);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      // A refusal that arrived after the phone named itself is the Gate's own
      // verdict (unpaired), not the missing-identity copy.
      setError(describeGatewayError(err, { sentDeviceId }));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [connected, gatewayRequest]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // `saving` is true while ANY write is queued or in the air, so it is counted
  // rather than set per call: the first call to finish must not hand the
  // switches back with another write still owed a trip.
  const beginSave = useCallback(() => {
    saveCountRef.current += 1;
    setSaving(true);
  }, []);

  const endSave = useCallback(() => {
    saveCountRef.current = Math.max(0, saveCountRef.current - 1);
  }, []);

  // A gateway switch re-keys every write. Anything still queued was computed
  // against the old gateway's row and must not be sent through the new client,
  // and any reply the old gateway still owes must paint nothing here.
  useEffect(() => {
    gatewayEpochRef.current += 1;
    const stale = queueRef.current;
    queueRef.current = [];
    for (const write of stale) {
      write.settle(false);
      endSave();
    }
    if (stale.length > 0) setSaving(saveCountRef.current > 0);
  }, [activeGatewayId, endSave]);

  /**
   * One write at a time, out of the queue. Everything waiting behind the write
   * in the air rides along in the next one: the Gate merges each patch onto its
   * own row, so taps made in the same breath need one trip, not one each.
   */
  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const batch = queueRef.current;
        queueRef.current = [];
        const seq = batch.reduce((highest, write) => Math.max(highest, write.seq), 0);
        const epoch = batch.reduce((highest, write) => Math.max(highest, write.gatewayEpoch), 0);
        const patch = batch.reduce<Partial<NotificationPreferences>>(
          (merged, write) => ({ ...merged, ...write.patch }),
          {},
        );
        // Whether this batch is still the newest one asked for. Read when the
        // reply lands, not when the batch left: a tap made while this write was
        // in the air is what makes this reply stale.
        const newest = () => seq === seqRef.current;
        // Whether the gateway this batch was computed against is still the one
        // on screen. A reply from a gateway the operator has left must not
        // repaint the new gateway's row or re-arm `synced` behind it.
        const sameGateway = () => epoch === gatewayEpochRef.current;
        let saved = false;
        let sentDeviceId = false;
        try {
          const params = await pushDeviceParams();
          sentDeviceId = true;
          const raw = await gatewayRequest<Record<string, unknown>>('notifications.preferences.set', {
            ...(patch as Record<string, unknown>),
            // The row a bootstrap-token phone owns is filed under its device id.
            ...params,
          });
          const row = normalize(raw);
          if (sameGateway()) {
            confirmedRef.current = row;
            // Only the newest write's reply owns the screen. An older row predates
            // a tap the operator has already made, so painting it would move a
            // switch back under their finger.
            if (newest()) setPrefs(row);
            setSynced(true);
            void readPermission();
          }
          saved = true;
        } catch (err) {
          if (sameGateway()) {
            setError(describeGatewayError(err, { sentDeviceId }));
            // The Gate did not take this row, so the card falls back to the last
            // row it did confirm and stops offering switches it cannot vouch for:
            // the error above them promises they stay locked until the Gate's own
            // settings are read.
            if (newest()) setPrefs(confirmedRef.current);
            setSynced(false);
          }
        } finally {
          // One waiter's answer and one count back per write, so a coalesced
          // batch of three taps still hands `saving` back exactly once.
          for (const write of batch) {
            write.settle(saved);
            endSave();
          }
        }
      }
    } finally {
      inFlightRef.current = false;
      // A tap that landed between the queue emptying and here is still owed a
      // trip, so `saving` must not read false while one is waiting.
      setSaving(saveCountRef.current > 0);
    }
  }, [endSave, gatewayRequest, readPermission]);

  /**
   * Apply a patch on screen at once and have the Gate told afterwards. The
   * switch moves on the tap; the round trip that can take the whole 30 s
   * request timeout is not what the operator waits through to see it move.
   * Answers true when the Gate took the row.
   */
  const setPatch = useCallback(
    (patch: Partial<NotificationPreferences>): Promise<boolean> => {
      const seq = ++seqRef.current;
      setPrefs((current) => ({ ...current, ...patch }));
      setError(null);
      beginSave();
      return new Promise<boolean>((resolve) => {
        queueRef.current.push({ patch, seq, settle: resolve, gatewayEpoch: gatewayEpochRef.current });
        void flush();
      });
    },
    [beginSave, flush],
  );

  /**
   * The enable toggle. Turning on asks the OS first — permission comes from
   * this user action, never at launch — then registers the token the same
   * connect-time path uses. Returns false when there is nothing to save.
   *
   * What the phone answers decides whether there is anything to ask: a refusal
   * has no dialog left, so asking again spends the one chance the operator
   * still has in Settings, and a permission nobody was ever asked about is
   * exactly the one a dialog can still be shown for. The read is a read — it
   * costs no dialog and paints the card's own caption.
   */
  const setEnabled = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (on) {
        const current = await readPermission();
        if (current === 'denied') {
          setError('Notifications are off for Versutus in the system settings — allow them, then try again.');
          return false;
        }
        if (current !== 'granted') {
          try {
            const result = await Notifications.requestPermissionsAsync();
            setPermission(permissionFrom(result));
            if (!result.granted) {
              setError('Notifications are off for Versutus in the system settings — allow them, then try again.');
              return false;
            }
          } catch {
            setError('The system permission request failed — try again.');
            return false;
          }
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
    [gatewayRequest, readPermission, setPatch],
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
    synced,
    setPatch,
    setEnabled,
    sendTest,
    reload: load,
  };
}
