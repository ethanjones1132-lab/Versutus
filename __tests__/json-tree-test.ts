import { describeCommandResult, jsonExitSignal, jsonTreeNode, tryParseJson } from '@/lib/terminal/json-tree';

describe('jsonTreeNode', () => {
  test('models primitives with their type', () => {
    expect(jsonTreeNode('hi')).toEqual({ kind: 'primitive', value: '"hi"', primitive: 'string' });
    expect(jsonTreeNode(42)).toEqual({ kind: 'primitive', value: '42', primitive: 'number' });
    expect(jsonTreeNode(true)).toEqual({ kind: 'primitive', value: 'true', primitive: 'boolean' });
    expect(jsonTreeNode(null)).toEqual({ kind: 'primitive', value: 'null', primitive: 'null' });
  });

  test('query strings keep their quotes with escapes', () => {
    const node = jsonTreeNode('say "hi"');
    if (node.kind !== 'primitive') throw new Error('expected primitive');
    expect(node.value).toBe('"say \\"hi\\""');
  });

  test('models objects with entries and a preview', () => {
    const node = jsonTreeNode({ a: 1, b: 'x' });
    expect(node.kind).toBe('object');
    if (node.kind !== 'object') return;
    expect(node.entries.map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(node.preview).toBe('2 keys');
    expect(node.entries[0].node).toEqual({ kind: 'primitive', value: '1', primitive: 'number' });
  });

  test('models arrays with a preview', () => {
    const node = jsonTreeNode([1, 2, 3]);
    expect(node.kind).toBe('array');
    if (node.kind !== 'array') return;
    expect(node.children).toHaveLength(3);
    expect(node.preview).toBe('3 items');
  });

  test('empty containers collapse their preview', () => {
    expect(jsonTreeNode({}).kind === 'object').toBe(true);
    expect(jsonTreeNode([]).kind === 'array').toBe(true);
  });

  test('an empty string keeps its string type and quotes', () => {
    expect(jsonTreeNode('')).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
  });

  test('an empty string is not confused with null or undefined', () => {
    const empty = jsonTreeNode('');
    const nul = jsonTreeNode(null);
    const undef = jsonTreeNode(undefined);
    if (empty.kind !== 'primitive') throw new Error('expected primitive');
    expect(empty.value).toBe('""');
    expect(empty.primitive).toBe('string');
    expect(nul).toEqual({ kind: 'primitive', value: 'null', primitive: 'null' });
    expect(undef).toEqual({ kind: 'primitive', value: 'null', primitive: 'null' });
    expect(empty).not.toEqual(nul);
  });

  test('falsy non-string values keep their own primitives', () => {
    expect(jsonTreeNode(false)).toEqual({ kind: 'primitive', value: 'false', primitive: 'boolean' });
    expect(jsonTreeNode(0)).toEqual({ kind: 'primitive', value: '0', primitive: 'number' });
    expect(jsonTreeNode(-0)).toEqual({ kind: 'primitive', value: '0', primitive: 'number' });
    expect(jsonTreeNode(Number.NaN)).toEqual({ kind: 'primitive', value: 'null', primitive: 'null' });
  });

  test('empty strings survive inside nested objects', () => {
    const node = jsonTreeNode({ stdout: 'ok', stderr: '' });
    expect(node.kind).toBe('object');
    if (node.kind !== 'object') return;
    expect(node.entries.map((entry) => entry.key)).toEqual(['stdout', 'stderr']);
    expect(node.entries[1].node).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
    expect(node.preview).toBe('2 keys');
  });

  test('empty strings survive inside nested arrays, including deep nesting', () => {
    const node = jsonTreeNode({ args: ['', 'x', { tail: '' }] });
    if (node.kind !== 'object') throw new Error('expected object');
    const args = node.entries[0].node;
    if (args.kind !== 'array') throw new Error('expected array');
    expect(args.children[0]).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
    expect(args.children[1]).toEqual({ kind: 'primitive', value: '"x"', primitive: 'string' });
    const tail = args.children[2];
    if (tail.kind !== 'object') throw new Error('expected object');
    expect(tail.entries[0].node).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
  });
});

describe('tryParseJson', () => {
  test('parses valid JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('returns null for invalid or empty input', () => {
    expect(tryParseJson('not json')).toBeNull();
    expect(tryParseJson('')).toBeNull();
    expect(tryParseJson('   ')).toBeNull();
  });
});

describe('jsonExitSignal', () => {
  test('flags a nonzero exit code', () => {
    const signal = jsonExitSignal({ exitCode: 1 });
    expect(signal.failed).toBe(true);
    expect(signal.label).toBe('exit 1');
  });

  test('treats exit code 0 as success', () => {
    expect(jsonExitSignal({ exitCode: 0 }).failed).toBe(false);
  });

  test('reads numeric error strings', () => {
    expect(jsonExitSignal({ exit_code: '2' }).failed).toBe(true);
  });

  test('flags a non-empty error field', () => {
    const signal = jsonExitSignal({ error: 'boom' });
    expect(signal.failed).toBe(true);
    expect(signal.label).toContain('boom');
  });

  test('flags ok:false and in-flight statuses', () => {
    expect(jsonExitSignal({ ok: false }).failed).toBe(true);
    expect(jsonExitSignal({ status: 'running' }).failed).toBe(true);
    expect(jsonExitSignal({ status: 'complete' }).failed).toBe(false);
  });

  test('neutral for plain results', () => {
    expect(jsonExitSignal({}).failed).toBe(false);
    expect(jsonExitSignal([1, 2]).failed).toBe(false);
    expect(jsonExitSignal('hello').failed).toBe(false);
  });
});

describe('describeCommandResult', () => {
  test('treats blank input as empty', () => {
    expect(describeCommandResult('')).toEqual({ kind: 'empty' });
    expect(describeCommandResult('   ')).toEqual({ kind: 'empty' });
  });

  test('keeps non-JSON as plain text', () => {
    expect(describeCommandResult('Command failed: boom')).toEqual({
      kind: 'text',
      text: 'Command failed: boom',
    });
  });

  test('parses JSON and attaches the exit signal', () => {
    expect(describeCommandResult('{"exitCode":1,"ok":false}')).toEqual({
      kind: 'json',
      value: { exitCode: 1, ok: false },
      signal: { failed: true, label: 'exit 1' },
    });
    expect(describeCommandResult('{"ok":true}')).toEqual({
      kind: 'json',
      value: { ok: true },
      signal: { failed: false },
    });
  });

  test('keeps an empty command field as an empty string, not null', () => {
    const model = describeCommandResult('{"stdout":"ok","stderr":"","exitCode":0}');
    expect(model.kind).toBe('json');
    if (model.kind !== 'json') return;
    expect(model.value).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(model.signal).toEqual({ failed: false });
    const node = jsonTreeNode(model.value);
    expect(node.kind).toBe('object');
    if (node.kind !== 'object') return;
    expect(node.entries.map((entry) => entry.key)).toEqual(['stdout', 'stderr', 'exitCode']);
    expect(node.entries[1].node).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
    expect(node.entries[2].node).toEqual({ kind: 'primitive', value: '0', primitive: 'number' });
  });

  test('a JSON document that is a bare empty string stays a string value', () => {
    expect(describeCommandResult('""')).toEqual({
      kind: 'json',
      value: '',
      signal: { failed: false },
    });
    expect(jsonTreeNode('')).toEqual({ kind: 'primitive', value: '""', primitive: 'string' });
  });
});
