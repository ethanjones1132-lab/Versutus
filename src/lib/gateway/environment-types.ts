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
