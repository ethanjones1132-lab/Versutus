import {
  buildChatContent,
  chatAttachmentFromUnknown,
  chatAttachmentsFromPicker,
  MAX_CHAT_ATTACHMENTS,
  supportsImageInput,
} from '@/lib/gateway/chat-parts';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('chatAttachmentFromUnknown', () => {
  it('keeps an image with a uri', () => {
    expect(chatAttachmentFromUnknown({ uri: 'data:image/png;base64,AA', mimeType: 'image/png' })).toEqual({
      kind: 'image',
      uri: 'data:image/png;base64,AA',
      mimeType: 'image/png',
      name: undefined,
    });
  });

  it('drops a non-image or a uri-less record', () => {
    expect(chatAttachmentFromUnknown({ uri: 'x', mimeType: 'application/pdf' })).toBeNull();
    expect(chatAttachmentFromUnknown({ mimeType: 'image/png' })).toBeNull();
    expect(chatAttachmentFromUnknown(null)).toBeNull();
  });
});

describe('chatAttachmentsFromPicker', () => {
  it('caps the count and drops duplicates and non-images', () => {
    const assets = [
      { uri: 'img:1', mimeType: 'image/png' },
      { uri: 'img:1', mimeType: 'image/png' },
      { uri: 'doc:1', mimeType: 'application/pdf' },
      { uri: 'img:2', mimeType: 'image/jpeg' },
      { uri: 'img:3', mimeType: 'image/png' },
      { uri: 'img:4', mimeType: 'image/png' },
      { uri: 'img:5', mimeType: 'image/png' },
    ];
    expect(chatAttachmentsFromPicker(assets).map((a) => a.uri)).toEqual([
      'img:1',
      'img:2',
      'img:3',
      'img:4',
    ]);
  });

  it('turns a base64 picker asset into a data URL the provider can fetch', () => {
    const [attachment] = chatAttachmentsFromPicker([
      { uri: 'file:///tmp/a.png', mimeType: 'image/png', base64: 'QUJD', fileName: 'a.png' },
    ]);
    expect(attachment.uri).toBe('data:image/png;base64,QUJD');
    expect(attachment.name).toBe('a.png');
  });

  it('respects the room left when attachments already exist', () => {
    const assets = [{ uri: 'a' }, { uri: 'b' }, { uri: 'c' }];
    expect(chatAttachmentsFromPicker(assets, MAX_CHAT_ATTACHMENTS - 1).map((a) => a.uri)).toEqual(['a']);
  });
});

describe('buildChatContent', () => {
  it('keeps a plain string when there are no attachments', () => {
    expect(buildChatContent('  hello  ')).toBe('hello');
    expect(buildChatContent('hello', [])).toBe('hello');
  });

  it('puts text first, then each image part', () => {
    expect(
      buildChatContent('what is this?', [
        { kind: 'image', uri: 'data:image/png;base64,AA' },
        { kind: 'image', uri: 'data:image/png;base64,BB' },
      ]),
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BB' } },
    ]);
  });

  it('allows an image-only turn with no empty text part', () => {
    expect(buildChatContent('   ', [{ kind: 'image', uri: 'data:image/png;base64,AA' }])).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ]);
  });
});

describe('supportsImageInput', () => {
  it('is true only for an explicit image signal', () => {
    expect(supportsImageInput({ capabilities: ['image'] })).toBe(true);
    expect(supportsImageInput({ input_modalities: ['text', 'image'] })).toBe(true);
  });

  it('fails closed for an absent or text-only model', () => {
    expect(supportsImageInput(null)).toBe(false);
    expect(supportsImageInput({ capabilities: ['text', 'tools'] })).toBe(false);
    expect(supportsImageInput({ capabilities: 'image' })).toBe(false);
  });
});

describe('the composer attach is capability-gated', () => {
  it('chat-screen offers onAttach only when the model declares image input', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain('supportsImageInput(selectedModelInfo)');
    expect(screen).toContain('onAttach={canAttach ? handleAttach : undefined}');
    expect(screen).toContain("sendChatInput(text, { skills: skillsState.skills, attachments: files })");
  });

  it('the composer renders the attach control and the staged chips', () => {
    const composer = readSource(['src', 'components', 'chat', 'chat-composer.tsx']);
    expect(composer).toContain('onAttach');
    expect(composer).toContain('attachmentRow');
    expect(composer).toContain('onRemoveAttachment');
  });
});

describe('a denied photo-library permission is never a silent no-op', () => {
  it('the denial branch records a notice instead of returning with no state', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).not.toContain('if (!permission.granted) return;');
    expect(screen).toMatch(/if \(!permission\.granted\) \{[\s\S]{0,400}?setAttachNotice\(/);
  });

  it('the notice is rendered beside the composer and cleared before the picker opens', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toMatch(/\{attachNotice \?/);
    expect(screen).toMatch(/setAttachNotice\(undefined\)/);
  });

  it('a permanent denial names Settings; an askable denial offers another tap', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toMatch(/Photos access is off[^']*Settings/);
    expect(screen).toMatch(/canAskAgain/);
  });

  it('the notice can be dismissed and the capability gate is untouched', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain('onAttach={canAttach ? handleAttach : undefined}');
    expect(screen).toContain('accessibilityLabel="Dismiss attach notice"');
  });
});

describe('a refused export handoff is never a silent no-op', () => {
  it('the export awaits the share result instead of discarding it', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).not.toContain('void shareBotHandoff(');
    expect(screen).toMatch(/await shareBotHandoff\(/);
  });

  it('a false answer records the refusal line and a new attempt clears the old one', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain('setHandoffShareNotice(shareRefusalCopy())');
    expect(screen).toMatch(
      /const handleExportBot = useCallback\([\s\S]{0,200}?setHandoffShareNotice\(undefined\)/,
    );
  });

  it('the notice is threaded to the detail sheet and rendered under the export row', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain('exportNotice={handoffShareNotice}');
    const sheet = readSource(['src', 'components', 'chat', 'bot-detail-sheet.tsx']);
    expect(sheet).toMatch(/\{onExport && exportNotice \?/);
    expect(sheet).toContain('accessibilityLabel="Dismiss export notice"');
  });

  it('closing the sheet clears the notice so a later Bot never inherits it', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toMatch(
      /onClose=\{\(\) => \{[\s\S]{0,120}?setDetailBot\(null\);[\s\S]{0,120}?setHandoffShareNotice\(undefined\)/,
    );
  });

  it('keep-working: the payload and readiness gate are untouched', () => {
    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain(
      'skills: skillsState.botId === bot.id ? skillsState.skills : []',
    );
    expect(screen).toContain(
      'routines: routineState.botId === bot.id ? routineState.jobs : []',
    );
    expect(screen).toContain(
      'onExport={detailBot && handoffShareReady ? handleExportBot : undefined}',
    );
    expect(screen).toContain('shareRefusalCopy()');
  });
});
