// ─── Registration refusal renders once ──────────────────────────────────────
// A failed provider/CLI-environment registration used to draw the identical
// message twice on one screen: the section's ErrorCard (cause/affected/next +
// Retry) and a bare default-color caption inside the open form, both fed the
// same `error` string. The ErrorCard is the keeper; the forms must stop
// rendering the section-owned error. Field-level notes (bindingsProblem,
// empty-profile/adapters copy) are form-owned and stay.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const providerForm = () =>
  readSource('src', 'components', 'gateway', 'provider-registration-form.tsx');
const environmentForm = () =>
  readSource('src', 'components', 'gateway', 'environment-registration-form.tsx');
const providersSection = () =>
  readSource('src', 'components', 'gateway', 'providers-section.tsx');
const environmentsSection = () =>
  readSource('src', 'components', 'gateway', 'environments-section.tsx');

describe('a refused registration renders once — in the section ErrorCard, not again in the form', () => {
  test('provider form no longer declares or renders the section-owned error prop', () => {
    const src = providerForm();
    expect(src).not.toContain('error?: string | null;');
    expect(src).not.toContain('error,');
    expect(src).not.toContain('{error ? <Text');
    expect(src).not.toMatch(/<Text[^>]*>\{error\}<\/Text>/);
  });

  test('environment form no longer declares or renders the section-owned error prop', () => {
    const src = environmentForm();
    expect(src).not.toContain('error?: string | null;');
    expect(src).not.toContain('error,');
    expect(src).not.toContain('{error ? <Text');
    expect(src).not.toMatch(/<Text[^>]*>\{error\}<\/Text>/);
  });

  test('sections no longer pass error into the open registration form', () => {
    expect(providersSection()).not.toContain('error={error}');
    expect(environmentsSection()).not.toContain('error={error}');
  });

  test('the section ErrorCard is still the single renderer of the refusal', () => {
    const providers = providersSection();
    expect(providers).toContain('<ErrorCard');
    expect(providers).toContain('cause={error}');
    expect(providers).toContain('affected="Providers on this Gate"');
    const environments = environmentsSection();
    expect(environments).toContain('<ErrorCard');
    expect(environments).toContain('cause={error}');
    expect(environments).toContain('affected="CLI environments on this Gate"');
  });

  test('form-owned field notes and wiring stay intact', () => {
    expect(environmentForm()).toContain('bindingsProblem');
    expect(environmentForm()).toContain(
      '{bindingsProblem ? <Text variant="caption">{bindingsProblem}</Text> : null}',
    );
    expect(providerForm()).toContain('onSubmit({ id, label, profile, baseUrl })');
    expect(providerForm()).toContain('Registering…');
    expect(environmentForm()).toContain('Registering…');
    expect(providersSection()).toContain(
      'onCancel={() => { setRegistering(false); setError(null); }}',
    );
    expect(environmentsSection()).toContain(
      'onCancel={() => { setRegistering(false); setEditing(null); setError(null); }}',
    );
  });
});
