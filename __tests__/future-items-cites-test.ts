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
  test('P1 attachment controls cite live behavior instead of fragile line numbers', () => {
    expect(p1Section).toContain('supportsImageInput');
    expect(p1Section).toContain('supportsFileInput');
    expect(chatScreen.join('\n')).toContain('const canAttach = supportsImageInput(selectedModelInfo)');
    expect(chatScreen.join('\n')).toContain('const canAttachFile = supportsFileInput(selectedModelInfo)');
    expect(chatScreen.join('\n')).toContain('onTakePhoto={canAttach ? handleTakePhoto : undefined}');
    expect(chatScreen.join('\n')).toContain('onAttachFile={canAttachFile ? handleAttachFile : undefined}');
  });

  test('P1 menu and capability helpers are present in the live source', () => {
    expect(chatComposer.join('\n')).toContain('onAttach && !callActive && !isStreaming');
    expect(chatComposer.join('\n')).toContain('onTakePhoto && !callActive && !isStreaming');
    expect(chatComposer.join('\n')).toContain('onAttachFile && !callActive && !isStreaming');
    expect(chatParts.join('\n')).toContain('export function supportsImageInput');
    expect(chatParts.join('\n')).toContain('export function supportsFileInput');
  });

  test('D5 names spend-per-bot as the budget-cap surface, not scorecards', () => {
    expect(d5Section).not.toMatch(/`scorecards-section\.tsx` surfaces the cap/);
    expect(d5Section).toContain('`spend-per-bot-section.tsx`');
    expect(d5Section).toContain('botBudget');
    expect(d5Section).toContain('budgetRowCopy');
    expect(spendPerBot.join('\n')).toContain('botBudget(budgets, gatewayId, row.botId)');
    expect(spendPerBot.join('\n')).toContain('budgetRowCopy(cap)');
  });

  test('D5 keeps scorecards botSpendCapCopy distinct as the session-list bound', () => {
    expect(d5Section).toContain('botSpendCapCopy');
    expect(d5Section).toContain('session-list bound');
    expect(scorecards.join('\n')).toContain('botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)');
  });

  test('keep-working: P1 and D5 headers and their shipped/remaining split stay', () => {
    expect(futureItems).toContain('### P1. Multimodal composer — camera and file attach shipped');
    expect(futureItems).toContain('### D5. Budgets with hard stops — shipped (pre-run refusal + Run once + fail-closed read)');
    expect(p1Section).toContain('**Shipped 2026-10-13.**');
    expect(p1Section).toContain('**Remaining (device acceptance).**');
    expect(d5Section).toContain('**State verified 2026-09-23/2026-10-13.**');
    expect(d5Section).toContain('**Resolved (2026-10-13).**');
    expect(d5Section).not.toContain('**Remaining.**');
    expect(d5Section).toContain('client-side');
  });
});
