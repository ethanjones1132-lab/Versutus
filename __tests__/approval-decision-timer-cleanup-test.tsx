declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('approval decision timer cleanup', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'components', 'activity', 'approval-decision-card.tsx'].join(SEP), 'utf8');

  it('retains the decision timer and clears it when the run leaves', () => {
    expect(src).toContain('const decisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);');
    expect(src).toMatch(/useEffect\(\(\) => \{\s*return \(\) => \{\s*if \(decisionTimer\.current\) clearTimeout\(decisionTimer\.current\);\s*\};\s*\}, \[runId\]\);/);
    expect(src).toContain('decisionTimer.current = setTimeout(() => onResolve(approved, feedback), duration);');
    expect(src).toContain('if (decisionTimer.current) clearTimeout(decisionTimer.current);');
  });

  it('preserves the lock, duration and trimmed Deny feedback behavior', () => {
    expect(src).toContain('if (locked.current) return;');
    expect(src).toContain('const duration = approvalExitDuration(next);');
    expect(src).toContain('const feedback = approved ? undefined : trimmed;');
  });
});
