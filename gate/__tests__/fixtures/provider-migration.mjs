import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function providerMigrationFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gate-provider-mig-'));
  const sourceRoot = join(tempRoot, 'source');
  const gateHome = join(tempRoot, 'gate-home');
  await mkdir(join(sourceRoot, 'registry'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'registry', 'nvidia.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'NVIDIA NIM',
      config: {
        flavor: 'openai',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY',
        models: ['deepseek-ai/deepseek-v4-flash-0731', 'meta/llama-3.1-8b-instruct'],
        streaming: true,
      },
    }, null, 2) + '\n',
    'utf8',
  );
  return { sourceRoot, gateHome, tempRoot };
}
