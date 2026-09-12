declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readBaseField(): string {
  return readSource(['src', 'components', 'ui', 'TextField.tsx']);
}

function readIosField(): string {
  return readSource(['src', 'components', 'ui', 'TextField.ios.tsx']);
}

function readComposer(): string {
  return readSource(['src', 'components', 'chat', 'chat-composer.tsx']);
}

function readApprovalCard(): string {
  return readSource(['src', 'components', 'activity', 'approval-decision-card.tsx']);
}

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

// The kit TextField forwarded accessibilityLabel to the native field but
// never accessibilityState, so all three non-editable sites (composer
// Message input mid-stream, approval Deny reply while exiting, Activity
// run prompt while starting) were half-announced. The fix derives
// `disabled: !editable` inside the kit — mirroring how Button
// auto-announces `{ disabled: !!isDisabled }` — so all three sites are
// covered with no call-site edits.
describe('textfield disabled state', () => {
  test('the base field derives disabled from editable', () => {
    expect(readBaseField()).toContain('accessibilityState={{ disabled: !editable }}');
  });

  test('the iOS field derives disabled from editable', () => {
    expect(readIosField()).toContain('accessibilityState={{ disabled: !editable }}');
  });

  test('each impl derives the state exactly once', () => {
    expect(readBaseField().match(/accessibilityState=\{\{ disabled: !editable \}\}/g)?.length ?? 0).toBe(1);
    expect(readIosField().match(/accessibilityState=\{\{ disabled: !editable \}\}/g)?.length ?? 0).toBe(1);
  });

  test('neither impl adds any state key other than disabled', () => {
    for (const src of [readBaseField(), readIosField()]) {
      expect(src).not.toContain('busy');
      expect(src).not.toContain('selected');
      expect(src).not.toContain('expanded');
    }
  });

  test('the three editable gates stay byte-identical', () => {
    expect(readComposer()).toContain('editable={inputEditable}');
    // The composer gate picks up the hands-free call lock (a call owns the
    // microphone and its own auto-send), and nothing else.
    expect(readComposer()).toContain('const inputEditable = !callActive && canSend && !isStreaming;');
    expect(readApprovalCard()).toContain('editable={!busy}');
    expect(readActivity()).toContain("editable={!starting && status === 'connected'}");
  });

  test('the three field labels stay byte-identical', () => {
    expect(readComposer()).toContain('accessibilityLabel="Message input"');
    expect(readApprovalCard()).toContain('accessibilityLabel="Deny reply"');
    expect(readActivity()).toContain('accessibilityLabel="Run prompt"');
  });

  test('the validationState label fallback stays byte-identical in both impls', () => {
    for (const src of [readBaseField(), readIosField()]) {
      expect(src).toContain("? 'Invalid input'");
      expect(src).toContain("? 'Valid input'");
    }
  });

  test('the iOS disabled(true) modifier stays byte-identical', () => {
    expect(readIosField()).toContain('...(!editable ? [disabled(true)] : []),');
  });
});
