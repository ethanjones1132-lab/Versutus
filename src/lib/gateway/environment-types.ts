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
