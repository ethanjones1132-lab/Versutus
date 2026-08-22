import { useCallback, useEffect, useMemo, useState } from 'react';

import { EnvironmentCard } from '@/components/gateway/environment-card';
import { EnvironmentRegistrationForm } from '@/components/gateway/environment-registration-form';
import { EnvironmentRunLauncher } from '@/components/gateway/environment-run-launcher';
import { Button, EmptyState, ErrorCard, Skeleton } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { createEnvironmentClient, buildEnvironmentUpdatePatch, snapshotToEditInput, type CreateEnvironmentInput } from '@/lib/gateway/environment-client';
import { createProviderClient } from '@/lib/gateway/provider-client';
import type { EnvironmentAdapter, EnvironmentSnapshot } from '@/lib/gateway/environment-types';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

/** CLI agents attached to the Gate: OpenCode, Codex, Claude Code, Hermes. */
export function EnvironmentsSection() {
  const { status, gatewayRequest, gatewayFetch } = useGateway();
  const client = useMemo(() => createEnvironmentClient(gatewayRequest, gatewayFetch), [gatewayRequest, gatewayFetch]);
  const providerClient = useMemo(() => createProviderClient(gatewayRequest), [gatewayRequest]);
  const [environments, setEnvironments] = useState<EnvironmentSnapshot[]>([]);
  const [adapters, setAdapters] = useState<EnvironmentAdapter[]>([]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<EnvironmentSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [runTarget, setRunTarget] = useState<EnvironmentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage CLI environments.');
      setLoaded(true);
      return;
    }
    try {
      setEnvironments(await client.list());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // Registration extras — an older Gate lists environments without them.
    try {
      setAdapters(await client.listAdapters());
    } catch {
      setAdapters([]);
    }
    try {
      setProviders(await providerClient.list());
    } catch {
      setProviders([]);
    } finally {
      setLoaded(true);
    }
  }, [client, providerClient, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function register(input: CreateEnvironmentInput) {
    setBusy(true);
    setError(null);
    try {
      await client.create(input);
      setRegistering(false);
      // Probe immediately so a bad path or unsupported version shows up now,
      // not the first time a run is attempted.
      await client.check(input.id).catch(() => undefined);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save an edited environment. Only the form-owned fields go over the wire
   * (the Gate merges them), then the same immediate probe as registration —
   * a fixed path should prove itself before the operator tries a run again.
   */
  async function saveEdit(input: CreateEnvironmentInput) {
    const target = editing;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await client.update(target.id, buildEnvironmentUpdatePatch(input, target));
      setEditing(null);
      await client.check(target.id).catch(() => undefined);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeEnvironment(id: string) {
    setError(null);
    try {
      await client.remove(id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const canRegister = status === 'connected' && adapters.length > 0;

  return (
    <>
      {error ? (
        <ErrorCard
          cause={error}
          affected="CLI environments on this Gate"
          next={status === 'connected' ? 'Retry, or check the Gate log for the failing call.' : 'Connect to the Gate first.'}
          onRetry={() => void load()}
        />
      ) : null}

      {canRegister && !registering && !editing ? (
        <Button label="Add environment" onPress={() => setRegistering(true)} />
      ) : null}

      {registering || editing ? (
        <EnvironmentRegistrationForm
          key={editing ? `edit-${editing.id}` : 'register'}
          adapters={adapters}
          providers={providers}
          initial={editing ? snapshotToEditInput(editing) : undefined}
          busy={busy}
          error={error}
          onSubmit={(input) => void (editing ? saveEdit(input) : register(input))}
          onCancel={() => { setRegistering(false); setEditing(null); setError(null); }}
        />
      ) : null}

      {!loaded && status === 'connected' ? (
        <>
          <Skeleton height={96} style={{ marginBottom: Spacing.three }} />
          <Skeleton height={96} />
        </>
      ) : null}

      {loaded && environments.length === 0 && !registering && !editing && status === 'connected' ? (
        <EmptyState
          icon={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
          title="No CLI environments yet"
          description="Attach a CLI such as OpenCode, Codex or Claude Code to this Gate."
          actionLabel={canRegister ? 'Add environment' : undefined}
          onAction={canRegister ? () => setRegistering(true) : undefined}
        />
      ) : null}

      {environments.map((environment) => (
        <EnvironmentCard
          key={environment.id}
          environment={environment}
          onCheck={() => void client.check(environment.id).then(load)}
          onStart={() => void client.start(environment.id).then(load)}
          onStop={() => void client.stop(environment.id).then(load)}
          onRun={() => setRunTarget(environment)}
          onEdit={() => { setRegistering(false); setEditing(environment); }}
          onRemove={() => void removeEnvironment(environment.id)}
        />
      ))}

      <EnvironmentRunLauncher
        environment={runTarget}
        client={client}
        visible={runTarget !== null}
        onClose={() => setRunTarget(null)}
      />
    </>
  );
}
