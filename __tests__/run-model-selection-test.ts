import { resolveSendModel } from '@/lib/gateway/model-selection';
import { executeRun, type RunCapableClient } from '@/lib/gateway/runs';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const gateway = {
  model: 'chat-model',
  backendModels: { 'hermes-local': 'environment-model' },
  botModels: { researcher: 'bot-model' },
};

describe('run model selection', () => {
  test('runTask resolves its model from the live Bot and CLI environment scope', () => {
    const provider = nodeFs.readFileSync(`${__dirname}/../src/context/gateway-provider.tsx`, 'utf8');
    const runTask = provider.slice(provider.indexOf('const runTask = useCallback('), provider.indexOf('const stopActivityRun = useCallback('));
    expect(runTask).toMatch(/\.\.\.resolveSendModel\(gateway, selectedBackendIdRef\.current, selectedBotIdRef\.current\)/);
    expect(runTask).not.toContain('model: gateway.model');
  });

  test.each([
    ['Bot pick', 'hermes-local', 'researcher', 'bot-model'],
    ['Bot default', 'hermes-local', 'unpicked', undefined],
    ['CLI environment pick', 'hermes-local', undefined, 'environment-model'],
    ['CLI environment default', 'unpicked', undefined, undefined],
    ['configurable chat pick', undefined, undefined, 'chat-model'],
  ])('%s reaches the run start without another scope overriding it', async (_name, backendId, botId, model) => {
    const client: RunCapableClient = {
      startRun: jest.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' }),
      getRunStatus: jest.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' }),
      streamRunEvents: jest.fn().mockResolvedValue(undefined),
      resolveApproval: jest.fn().mockResolvedValue(undefined),
      stopRun: jest.fn().mockResolvedValue(undefined),
    };
    await executeRun(client, 'summarize the report', {
      sessionId: 'session-1',
      ...resolveSendModel(gateway, backendId, botId),
      onApprovalRequired: async () => ({ approved: false }),
    });
    expect(client.startRun).toHaveBeenCalledWith('summarize the report', {
      sessionId: 'session-1',
      model,
    });
  });
});
