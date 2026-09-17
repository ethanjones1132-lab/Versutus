declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const scope = readSource('README.md').split('## Scope limits')[1]?.split('\n## ')[0] ?? '';
const localHeader = readSource('src', 'lib', 'notifications', 'local.ts').split('\n\n')[0];

describe('notification scope documentation', () => {
  test('the Gate relay is shipped, not deferred', () => {
    expect(scope).toContain('True push is implemented by the Versutus Gate relay');
    expect(scope).toContain('replies, run results, approvals, and Routine results');
    expect(scope).not.toContain('Not invented here');
    expect(localHeader).toContain('True push is delivered separately by the Gate relay');
    expect(localHeader).not.toMatch(/deferred|must supply later/i);
  });

  test('true push still depends on a companion and the Expo service', () => {
    expect(scope).toContain('requires the Gate companion server to be running');
    expect(scope).toContain('Expo Push Service');
    expect(scope).toContain('registered device with notification permission and push enabled');
    expect(scope).toContain('does not keep the app alive or expose the Gateway to the public internet');
  });

  test('local notices do not promise delivery without a Gateway connection', () => {
    expect(scope).toContain("Local notifications fire only while the app's Gateway connection is alive");
    expect(localHeader.replace(/\n\/\/ /g, ' ')).toContain(
      'only while its connection to the Gateway is alive',
    );
    expect(localHeader).toContain('do not deliver new Gateway events after that connection is lost');
  });
});
