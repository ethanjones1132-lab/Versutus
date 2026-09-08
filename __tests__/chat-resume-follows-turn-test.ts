declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

function screenSrc(): string {
  return readSource('src', 'components', 'chat', 'chat-screen.tsx');
}

function resumeBlock(src: string): string {
  const start = src.indexOf('const handleResumeMessage');
  const end = src.indexOf('const handleSkillInvoke');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

test('pin-set: a resumed turn re-pins the transcript so new deltas auto-follow', () => {
  const block = resumeBlock(screenSrc());
  // Mirrors handleSend / handleSkillInvoke: without this,
  // handleContentSizeChange only follows while pinned and the resumed turn
  // streams below the viewport for an operator who scrolled up.
  expect(block).toContain('pinnedRef.current = true');
});

test('scroll-to-end: a resumed turn scrolls to the end on the same rAF idiom', () => {
  const block = resumeBlock(screenSrc());
  expect(block).toMatch(/requestAnimationFrame\(\(\) => listRef\.current\?\.scrollToEnd/);
});

test('resend-text-identical: resume still resends the exact previous user text', () => {
  const block = resumeBlock(screenSrc());
  expect(block).toContain('previousUser.text.trim()');
  expect(block).toMatch(/sendChatInput\(previousUser\.text\.trim\(\)/);
});

test('skills-passthrough-identical: resume keeps the same skills passthrough', () => {
  const block = resumeBlock(screenSrc());
  expect(block).toContain('{ skills: skillsState.skills }');
});

test('no-previous-user-noop: resume stays a no-op with no previous user text', () => {
  const block = resumeBlock(screenSrc());
  expect(block).toContain('if (previousUser?.text.trim())');
});

test('handleSend-untouched: the sibling send path keeps its own pin and scroll', () => {
  const src = screenSrc();
  const start = src.indexOf('const handleSend');
  const end = src.indexOf('const handleResumeMessage');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  expect(block).toContain("setDraft('')");
  expect(block).toContain('pinnedRef.current = true');
  expect(block).toMatch(/requestAnimationFrame\(\(\) => listRef\.current\?\.scrollToEnd/);
});
