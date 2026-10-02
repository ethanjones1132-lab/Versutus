declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function read(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const futureItems = read('FUTURE-ITEMS.md');
const chatScreen = read('src', 'components', 'chat', 'chat-screen.tsx').split('\n');
const chatComposer = read('src', 'components', 'chat', 'chat-composer.tsx').split('\n');
const chatParts = read('src', 'lib', 'gateway', 'chat-parts.ts').split('\n');
const spendPerBot = read('src', 'components', 'gateway', 'spend-per-bot-section.tsx').split('\n');
const scorecards = read('src', 'components', 'activity', 'scorecards-section.tsx').split('\n');

const p1Section = futureItems.split('### P1.')[1]?.split('\n### ')[0] ?? '';
const d5Section = futureItems.split('### D5.')[1]?.split('\n## ')[0] ?? '';

describe('FUTURE-ITEMS open cites describe the live tree', () => {
  test('P1 attach offer cites the live chat-screen lines, not the drifted ones', () => {
    expect(p1Section).toContain('`src/components/chat/chat-screen.tsx:1357,2968`');
    expect(p1Section).not.toContain('1146,2446');
    expect(p1Section).not.toContain('1157,2492');
    expect(p1Section).not.toContain('1154,2473');
    expect(p1Section).not.toContain('1153,2468');
    expect(p1Section).not.toContain('1125,2324');
    expect(p1Section).not.toContain('1142,2407');
    expect(p1Section).not.toContain('1157,2495');
    expect(p1Section).not.toContain('1173,2594');
    expect(p1Section).not.toContain('1216,2656');
    // R4X3 moved both rows again: the merged round-4 tree pulled more
    // voice/session code above `canAttach`. FUTURE-ITEMS.md and the pins below
    // now follow the same live lines.
    expect(chatScreen[1356]).toContain('canAttach = supportsImageInput');
    expect(chatScreen[2967]).toContain('onAttach={canAttach ? handleAttach : undefined}');
  });

  test('P1 keeps the live composer-draw and supportsImageInput cites', () => {
    expect(p1Section).toContain('`src/components/chat/chat-composer.tsx:333-350`');
    expect(p1Section).toContain('`src/lib/gateway/chat-parts.ts:144`');
    // The attach row moved further down as the merged round-4 composer grew
    // (voice/call controls landed above it). The row itself is the one the
    // cite names.
    expect(chatComposer[332]).toContain('onAttach && !callActive && !isStreaming');
    expect(chatComposer.slice(332, 350).join('\n')).toContain('accessibilityLabel="Attach an image"');
    // Same drift: the picker fold now carries a per-turn byte budget beside the
    // count cap, so `supportsImageInput` sits lower in the file.
    expect(chatParts[143]).toContain('export function supportsImageInput');
  });

  test('D5 names spend-per-bot as the budget-cap surface, not scorecards', () => {
    expect(d5Section).not.toMatch(/`scorecards-section\.tsx` surfaces the cap/);
    expect(d5Section).toContain('`spend-per-bot-section.tsx`');
    expect(d5Section).toContain('botBudget');
    expect(d5Section).toContain('budgetRowCopy');
    expect(spendPerBot[78]).toContain('botBudget(budgets, gatewayId, row.botId)');
    expect(spendPerBot[126]).toContain('budgetRowCopy(cap)');
  });

  test('D5 keeps scorecards botSpendCapCopy distinct as the session-list bound', () => {
    expect(d5Section).toContain('botSpendCapCopy');
    expect(d5Section).toContain('session-list bound');
    expect(scorecards[291]).toContain('botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)');
  });

  test('keep-working: P1 and D5 headers and their shipped/remaining split stay', () => {
    expect(futureItems).toContain('### P1. Multimodal composer — library images shipped; camera and files remain');
    expect(futureItems).toContain('### D5. Budgets with hard stops — pre-run refusal shipped; approval escalation remains');
    expect(p1Section).toContain('**Shipped.**');
    expect(p1Section).toContain('**Remaining.**');
    expect(d5Section).toContain('**State verified 2026-09-23.**');
    expect(d5Section).toContain('**Remaining.**');
    expect(d5Section).toContain('client-side');
  });
});
