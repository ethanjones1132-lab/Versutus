/** A CLI adapter this Gate ships, as advertised by environments.adapters.list. */
export type EnvironmentAdapter = {
  adapterId: string;
  adapterRevision: string;
  supportedCliVersions: string;
  protocols: string[];
  capabilities: string[];
  operations: string[];
};

export type EnvironmentSnapshot = {
  id: string;
  label: string;
  adapterId: string;
  enabled: boolean;
  providerRefs: string[];
  state: string;
  executable: { path: string };
  protocolPreference: string[];
  workspacePolicy: {
    defaultRoot: string;
    defaultSandbox: string;
  };
  lifecycle: {
    startup: string;
    maxConcurrentRuns: number;
  };
  probe?: { cliVersion?: string; protocol?: string; message?: string };
};

export type EnvironmentRunEvent = {
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
};

/**
 * One retained run as the Gate's list endpoint reports it. This is how the
 * app finds its way back to a run after the stream dropped — the event
 * endpoint replays from sequence 0, but only once the run id is known again.
 */
export type EnvironmentRunSummary = {
  runId: string;
  environmentId: string;
  operation: string;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
};
