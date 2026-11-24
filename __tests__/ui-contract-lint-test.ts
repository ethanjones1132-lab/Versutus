/**
 * The lint half of the UI contracts: the same rule objects `eslint.config.js`
 * loads are run through `RuleTester` here, so a call site that drops half an
 * EmptyState action or makes a SwitchRow uncontrolled fails the gate instead of
 * quietly drifting back.
 */

import { RuleTester } from 'eslint';
import type { Rule } from 'eslint';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

const { rules } = jest.requireActual('../eslint-rules/ui-contracts.js') as {
  rules: Record<string, Rule.RuleModule>;
};

function readRepo(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('ui-contracts/empty-state-contract', rules['empty-state-contract'], {
  valid: [
    { code: '<EmptyState icon={icon} title="Nothing here yet" />' },
    {
      code: '<EmptyState icon={icon} title="Nothing here yet" actionLabel="Retry" onAction={retry} />',
    },
  ],
  invalid: [
    {
      code: '<EmptyState icon={icon} title="Nothing here yet" actionLabel="Retry" />',
      errors: [{ messageId: 'pairedAction' }],
    },
    {
      code: '<EmptyState icon={icon} title="Nothing here yet" onAction={retry} />',
      errors: [{ messageId: 'pairedAction' }],
    },
  ],
});

describe('the repo lint config', () => {
  test('enables both contract guards for every screen and component', () => {
    const config = readRepo('eslint.config.js');
    expect(config).toContain('"src/**/*.{ts,tsx}"');
    expect(config).toContain('"ui-contracts/empty-state-contract": "error"');
    expect(config).toContain('"ui-contracts/switch-row-contract": "error"');
  });
});

ruleTester.run('ui-contracts/switch-row-contract', rules['switch-row-contract'], {
  valid: [
    { code: '<SwitchRow title="Push notifications" value={on} onValueChange={setOn} />' },
    {
      code: '<SwitchRow title="Push notifications" body="Runs arrive here." value={on} onValueChange={setOn} disabled />',
    },
  ],
  invalid: [
    {
      code: '<SwitchRow title="Push notifications" value={on} />',
      errors: [{ messageId: 'controlled' }],
    },
    {
      code: '<SwitchRow title="Push notifications" onValueChange={setOn} />',
      errors: [{ messageId: 'controlled' }],
    },
    {
      code: '<SwitchRow {...row} />',
      errors: [{ messageId: 'controlled' }],
    },
    {
      code: '<SwitchRow title="Push notifications" value={on} onValueChange={setOn} defaultValue={false} />',
      errors: [{ messageId: 'uncontrolled', data: { name: 'defaultValue' } }],
    },
    {
      code: '<SwitchRow title="Push notifications" value={on} onValueChange={setOn} onChange={setOn} />',
      errors: [{ messageId: 'uncontrolled', data: { name: 'onChange' } }],
    },
  ],
});
