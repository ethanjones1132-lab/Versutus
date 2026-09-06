declare const __dirname: string;

import {
  addableMembers,
  canAddMember,
  describeAddableExhaustion,
  MAX_GROUP_MEMBERS,
} from '@/lib/gateway/groups';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('room add keeps the cap and the addressability checks', () => {
  test('canAddMember refuses the six-member ceiling', () => {
    expect(MAX_GROUP_MEMBERS).toBe(6);
    expect(
      canAddMember({ memberIds: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toBe(false);
    expect(canAddMember({ memberIds: ['a', 'b'] })).toBe(true);
  });

  test('addableMembers offers routable non-members only, in roster order', () => {
    const room = { memberIds: ['coder'] };
    const bots = [
      { id: 'coder', routable: true },
      { id: 'silent', routable: false },
      { id: 'writer', routable: true },
    ];
    // Already in the room stays out even though it is routable; the
    // unroutable bot stays out even though it is new — the same
    // addressability verdict the action sheet's picker follows.
    expect(addableMembers(room, bots).map((bot) => bot.id)).toEqual([
      'writer',
    ]);
  });

  test('an empty picker names the roster state instead of claiming exhaustion', () => {
    expect(
      describeAddableExhaustion({ inventoryLoaded: true }),
    ).toContain('already in this room');
    expect(describeAddableExhaustion({ inventoryLoaded: false })).toContain(
      'Roster not loaded',
    );
  });
});

describe('group room view offers the add-member picker in place', () => {
  test('the room view takes the same add client the action sheet takes', () => {
    const src = readSource('src', 'components', 'chat', 'group-room-view.tsx');
    expect(src).toContain('onAddMembers?: (memberIds: string[]) => Promise<BotGroupRoom>');
    expect(src).toContain('addableMembers(');
    expect(src).toContain('canAddMember(group)');
    expect(src).toContain('describeAddableExhaustion(');
    expect(src).toContain('describeRoomError(');
  });

  test('the add pill only shows while the room has room, and the picker submits the selection', () => {
    const src = readSource('src', 'components', 'chat', 'group-room-view.tsx');
    expect(src).toMatch(/onAddMembers && canAddMember\(group\)/);
    expect(src).toContain('setAddVisible(true)');
    expect(src).toContain('onAddMembers(addSelection)');
    expect(src).toContain('MAX_GROUP_MEMBERS');
  });

  test('chat-screen wires the room view to the same addMembers client as the detail sheet', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const roomView = src.match(
      /<GroupRoomView[\s\S]*?\/>/,
    )?.[0];
    expect(roomView).toBeDefined();
    expect(roomView).toContain('onAddMembers');
    expect(roomView).toContain('botGroups.addMembers(activeGroup.id');
  });
});
