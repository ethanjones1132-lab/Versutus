import { useCallback, useEffect, useMemo, useState } from 'react';

import { OauthProgressSheet } from '@/components/gateway/oauth-progress-sheet';
import { ProviderCard } from '@/components/gateway/provider-card';
import { ProviderKeySheet } from '@/components/gateway/provider-key-sheet';
import { ProviderRegistrationForm } from '@/components/gateway/provider-registration-form';
import { Button, EmptyState, ErrorCard, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { createProviderClient, type CreateProviderInput } from '@/lib/gateway/provider-client';
import {
  isOAuthAttemptPollUnsupported,
  isUnknownOAuthAttempt,
  OAUTH_ATTEMPT_POLL_MS,
  oauthAttemptExpired,
  resolveOAuthBeginDisplay,
} from '@/lib/gateway/provider-oauth';
import type { ProviderProfile, ProviderSnapshot } from '@/lib/gateway/provider-types';

/** Model providers the Gate owns: registration, credentials, catalogs. */
export function ProvidersSection() {
  const { status, gatewayRequest } = useGateway();
  const client = useMemo(() => createProviderClient(gatewayRequest), [gatewayRequest]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = useState('');
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthAttemptId, setOauthAttemptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage providers.');
      setLoaded(true);
      return;
    }
    try {
      setProviders(await client.list());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // A Gate predating providers.profiles.list still lists fine — it just
    // cannot offer registration, so this must not clear the list.
    try {
      setProfiles(await client.listProfiles());
    } catch {
      setProfiles([]);
    } finally {
      setLoaded(true);
    }
  }, [client, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Follow the OAuth attempt the begin answer named: while the Gate still
  // tracks it the browser authorization is pending; once the Gate consumes it
  // (`unknown attempt`) or its budget runs out, reload providers so the new
  // credential shows and name the outcome in the sheet. A Gate that predates
  // the attempt read keeps the fire-and-forget copy — no polling, no error.
  useEffect(() => {
    if (!oauthAttemptId) return;
    const attemptId = oauthAttemptId;
    let cancelled = false;
    async function pollOnce(): Promise<boolean> {
      try {
        const attempt = await client.authAttempt(attemptId);
        if (cancelled) return false;
        if (oauthAttemptExpired(attempt)) {
          setOauthMessage('Authorization expired before it completed. Try again.');
          setOauthAttemptId(null);
          void load();
          return false;
        }
        return true;
      } catch (caught) {
        if (cancelled) return false;
        if (isUnknownOAuthAttempt(caught)) {
          setOauthMessage('Authorization finished. Providers reloaded.');
          setOauthAttemptId(null);
          void load();
          return false;
        }
        if (isOAuthAttemptPollUnsupported(caught)) return false;
        return true;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (cancelled) return;
      timer = setTimeout(() => {
        void pollOnce().then((keepGoing) => {
          if (keepGoing) schedule();
        });
      }, OAUTH_ATTEMPT_POLL_MS);
    }
    void pollOnce().then((keepGoing) => {
      if (keepGoing) schedule();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [oauthAttemptId, client, load]);

  async function register(input: CreateProviderInput) {
    setBusy(true);
    setError(null);
    try {
      await client.create(input);
      setRegistering(false);
      await load();
      // A provider without a key is inert, so go straight to the prompt.
      setEditingId(input.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Save the key, then prove it works rather than leaving it to be discovered later. */
  async function saveKey(id: string, value: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.setApiKey(id, value);
      const snapshot = await client.check(id);
      if (snapshot.readiness?.state === 'ready') {
        setNotice(`${snapshot.label} is ready.`);
      } else {
        setError(
          `${snapshot.label}: ${snapshot.readiness?.message ?? snapshot.readiness?.state ?? 'not ready'}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditingId(null);
      setBusy(false);
      void load();
    }
  }

  const canRegister = status === 'connected' && profiles.length > 0;

  /**
   * Rename a provider's label on the Gate. The trimmed value is what reaches
   * `providers.update` -- the schema rejects empty strings and the Gate strips
   * nothing, so the phone is the right place to refuse whitespace the operator
   * could not see. The id stays in the path (not the patch); the Gate uses it
   * to look up the stored credential at `provider/${id}/api-key`, and a
   * renamed id would orphan the credential under a path the Gate cannot read.
   */
  const handleRename = useCallback(
    async (snapshotId: string, nextLabel: string) => {
      const trimmed = nextLabel.trim();
      if (!trimmed) return;
      try {
        await client.update(snapshotId, { label: trimmed });
      } finally {
        await load();
      }
    },
    [client, load],
  );

  /**
   * Run one card lifecycle tap (Check/Refresh/Disconnect/Disable/Delete/Enable)
   * the way saveKey surfaces a refusal: the reason lands in the section
   * ErrorCard, and only a success touches state — the map-snapshot replace for
   * check/refresh, a full load() for the rest.
   */
  async function runCardAction(
    id: string,
    action: 'check' | 'refresh' | 'disconnect' | 'disable' | 'delete' | 'enable',
  ) {
    setError(null);
    try {
      if (action === 'check') {
        const next = await client.check(id);
        setProviders((current) => current.map((item) => (item.id === id ? next : item)));
        return;
      }
      if (action === 'refresh') {
        const next = await client.refreshCatalog(id);
        setProviders((current) => current.map((item) => (item.id === id ? next : item)));
        return;
      }
      if (action === 'disconnect') {
        await client.disconnect(id);
      } else if (action === 'disable') {
        await client.update(id, { enabled: false });
      } else if (action === 'enable') {
        await client.update(id, { enabled: true });
      } else {
        await client.remove(id);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <>
      {error ? (
        <ErrorCard
          cause={error}
          affected="Providers on this Gate"
          next={status === 'connected' ? 'Retry, or check the Gate log for the failing call.' : 'Connect to the Gate first.'}
          onRetry={() => void load()}
        />
      ) : null}
      {notice ? <Text variant="caption">{notice}</Text> : null}

      {canRegister && !registering ? (
        <Button label="Add provider" onPress={() => setRegistering(true)} />
      ) : null}

      {registering ? (
        <ProviderRegistrationForm
          profiles={profiles}
          busy={busy}
          error={error}
          onSubmit={(input) => void register(input)}
          onCancel={() => { setRegistering(false); setError(null); }}
        />
      ) : null}

      {!loaded && status === 'connected' ? (
        <>
          <Skeleton height={96} style={{ marginBottom: Spacing.three }} />
          <Skeleton height={96} />
        </>
      ) : null}

      {loaded && providers.length === 0 && !registering && status === 'connected' ? (
        <EmptyState
          icon={{ ios: 'square.stack.3d.up', android: 'layers', web: 'layers' }}
          title="No providers yet"
          description="Register a provider to give this Gate a model catalog."
          actionLabel={canRegister ? 'Add provider' : undefined}
          onAction={canRegister ? () => setRegistering(true) : undefined}
        />
      ) : null}

      {providers.map((snapshot) => (
        <ProviderCard
          key={snapshot.id}
          snapshot={snapshot}
          onCheck={() => void runCardAction(snapshot.id, 'check')}
          onRefresh={() => void runCardAction(snapshot.id, 'refresh')}
          onDisconnect={() => void runCardAction(snapshot.id, 'disconnect')}
          onDisable={() => void runCardAction(snapshot.id, 'disable')}
          onDelete={() => void runCardAction(snapshot.id, 'delete')}
          onSetKey={() => setEditingId(snapshot.id)}
          onAuthorize={() => {
            void (async () => {
              setError(null);
              try {
                const answer = await client.beginAuth(snapshot.id);
                const display = resolveOAuthBeginDisplay(answer);
                setOauthUrl(display?.authorizationUrl ?? null);
                // Only a begin answer with something to open starts the
                // attempt poll; anything else keeps the fire-and-forget copy.
                setOauthAttemptId(display?.attemptId ?? null);
                setOauthMessage('Continue authorization in the desktop browser.');
              } catch (caught) {
                // A begin refusal (oauth not configured on the Gate) surfaces
                // as an error, not the progress sheet.
                setOauthUrl(null);
                setOauthAttemptId(null);
                setOauthMessage('');
                setError(caught instanceof Error ? caught.message : String(caught));
              }
            })();
          }}
          onEnable={() => void runCardAction(snapshot.id, 'enable')}
          onRename={(nextLabel) => handleRename(snapshot.id, nextLabel)}
        />
      ))}

      <ProviderKeySheet
        visible={editingId !== null}
        label={providers.find((provider) => provider.id === editingId)?.label ?? editingId ?? ''}
        busy={busy}
        onSubmit={(value) => { if (editingId) void saveKey(editingId, value); }}
        onClose={() => setEditingId(null)}
      />

      <OauthProgressSheet
        visible={!!oauthMessage}
        message={oauthMessage}
        authorizationUrl={oauthUrl ?? undefined}
        onClose={() => { setOauthMessage(''); setOauthUrl(null); setOauthAttemptId(null); }}
      />
    </>
  );
}
