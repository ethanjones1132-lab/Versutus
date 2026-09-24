jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { Palette } from '@/constants/tokens';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(file: string): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'chat', file].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const interiorFiles = [
  'thread-config-sheet.tsx',
  'group-room-action-sheet.tsx',
  'create-group-sheet.tsx',
  'confirmation-sheet.tsx',
  'chat-overflow-sheet.tsx',
  'message-actions-sheet.tsx',
] as const;

describe('chat sheet interiors use the locked modal language', () => {
  it.each(interiorFiles)('%s leaves glass, gold, and focus-tint chrome behind', (file) => {
    const src = readSource(file);
    expect(src).not.toMatch(/glassBorder|glassHighlight|Palette\.glass|tokens\.gold|Palette\.gold|accentWarm/);
  });

  it('thread-config selection uses a muted brand fill, brand border, and cool resting hairline', () => {
    const src = readSource('thread-config-sheet.tsx');
    expect(src.match(/backgroundColor: isCurrent \? tokens\.accentMuted : tokens\.backgroundInset/g) ?? []).toHaveLength(2);
    expect(src.match(/borderColor: isCurrent \? tokens\.accent : tokens\.border/g) ?? []).toHaveLength(2);
    expect(src).toContain('backgroundColor: tokens.accentMuted, borderColor: tokens.accent');
    expect(src).toContain('color={pinned ? \'accent\' : \'textTertiary\'}');
    expect(src).not.toContain('tokens.borderSubtle');
    expect(src).toContain('selected={item.id === selectedBackendId}');
  });

  it('confirmation command and diff panels use the shared cool border', () => {
    const src = readSource('confirmation-sheet.tsx');
    expect(src.match(/backgroundColor: tokens\.backgroundInset, borderColor: tokens\.border/g) ?? []).toHaveLength(2);
    expect(src.match(/borderColor: tokens\.border/g) ?? []).toHaveLength(2);
    expect(src).not.toContain('tokens.glassBorder');
  });

  it('brand accent is violet and remains distinct from metallic gold', () => {
    const [red, green, blue] = (Palette.accent.match(/[0-9a-f]{2}/gi) ?? []).map((part) => parseInt(part, 16));
    expect(red).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(green);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});

describe('chat sheet interior behavior remains wired', () => {
  it('thread selection, labels, and backend switching stay present', () => {
    const src = readSource('thread-config-sheet.tsx');
    expect(src).toContain('onSelect?.(item.id);');
    expect(src).toContain('onSelect?.(item.id, item.providerId ?? item.provider);');
    expect(src).toContain('onPress={() => onSelect?.(item.id)}');
    expect(src).toContain('accessibilityState={{ selected: isCurrent }}');
  });

  it('group actions retain create, rename, membership, and disband paths', () => {
    const src = readSource('group-room-action-sheet.tsx');
    for (const action of ['onRename', 'onAddMembers', 'onRemoveMember', 'onDisband']) {
      expect(src).toContain(action);
    }
    expect(src).toContain('onSubmitEditing={submitRename}');
    expect(src).toContain('onPress={submitRemove}');
  });

  it('create and confirm flows keep their callbacks and gates', () => {
    const create = readSource('create-group-sheet.tsx');
    expect(create).toContain('onPress={() => onCreate({ name: name.trim(), memberIds })}');
    expect(create).toContain('disabled={busy || !validation.ok}');

    const confirmation = readSource('confirmation-sheet.tsx');
    expect(confirmation).toContain('onConfirm();');
    expect(confirmation).toContain('onCancel();');
    expect(confirmation).toContain('preview.applyCommand');
  });

  it('overflow and message actions remain BaseSheet surfaces', () => {
    const overflow = readSource('chat-overflow-sheet.tsx');
    const message = readSource('message-actions-sheet.tsx');
    expect(overflow).toContain('<BaseSheet');
    expect(overflow).toContain('onStartRun');
    expect(message).toContain('<BaseSheet');
    expect(message).toContain('onDelete(message.id)');
  });
});
