declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/** The last JSDoc block before `marker`, or '' when none precedes it. */
function docBefore(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const before = src.slice(0, at);
  const start = before.lastIndexOf('/**');
  return start < 0 ? '' : before.slice(start);
}

/**
 * executeRun's doc block used to sit above requestStop, so the function the
 * run lifecycle is built around had none and requestStop's doc was doubled.
 */
describe('run lifecycle doc placement', () => {
  const src = readSource('src', 'lib', 'gateway', 'runs.ts');

  test('executeRun carries the "start a run and drive it" doc that describes it', () => {
    expect(docBefore(src, 'export async function executeRun(')).toContain(
      'Start a run and drive it to a terminal state',
    );
  });

  test('requestStop keeps only its own doc and does not borrow executeRun’s', () => {
    const stopDoc = docBefore(src, 'async function requestStop(');
    expect(stopDoc).toContain('Ask the gateway to stop a run');
    expect(stopDoc).not.toContain('Start a run and drive it');
  });
});
