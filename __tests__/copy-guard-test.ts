// The copy guard (spec §2d). The priority screens speak in the operator's
// words: no environment variables, no protocol acronyms, no "profile", no
// dangling separators. This reads the source with the TypeScript parser rather
// than a regex so comments and identifiers cannot trip it and a real string
// cannot hide behind one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const ROOT = path.join(__dirname, '..');

/** Screens and copy modules that have been through the voice pass; add to this list as more do. */
const PRIORITY = [
  'src/components/onboarding/onboarding-screen.tsx',
  'src/components/chat/chat-roster.tsx',
  'src/components/terminal/terminal-screen.tsx',
  'src/components/gateway/gateway-command-panel.tsx',
  'src/components/gateway/compact-gateway-list.tsx',
  'src/components/gateway/gateway-home-dashboard.tsx',
  'src/app/gateway/settings.tsx',
  // Copy the roster, the call banner and the address check render from, so the
  // words they show are guarded at their source too.
  'src/lib/gateway/bots.ts',
  'src/lib/voice/handsfree-call-copy.ts',
  'src/lib/onboarding/validate-pc-address.ts',
];

type Found = { file: string; line: number; text: string };

function stringLiterals(file: string): Found[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Found[] = [];
  const push = (node: ts.Node, value: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    out.push({ file, line, text: value });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      push(node.head, node.head.text);
      for (const span of node.templateSpans) push(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const BANNED: { name: string; test: (text: string) => boolean }[] = [
  { name: 'API_SERVER_KEY', test: (text) => text.includes('API_SERVER_KEY') },
  { name: 'RPC', test: (text) => /\bRPC\b/.test(text) },
  { name: 'vshowcase', test: (text) => text.includes('vshowcase') },
  {
    name: 'a dangling " - " separator',
    test: (text) => /\S - \S/.test(text),
  },
  {
    name: '"profile" in prose',
    // Method ids and paths ("profiles.list") are code, not copy.
    test: (text) => /\bprofiles?\b/i.test(text) && /\s/.test(text),
  },
  {
    // The roster names the consequence; the listen key itself lives in Details.
    name: 'the internal "No listen key" verdict',
    test: (text) => text === 'No listen key',
  },
  {
    // The call names the operator's computer, not the gateway behind it.
    name: "a \"gateway connection\" in the call's end line",
    test: (text) => text.includes('gateway connection'),
  },
  {
    // The address check asks for a PC name; the network product is not its word.
    name: 'a Tailscale host in the address check',
    test: (text) => /Tailscale (?:name|hostname)/i.test(text),
  },
];

test('the priority screens use the operator’s words', () => {
  const offenders: string[] = [];
  for (const file of PRIORITY) {
    for (const found of stringLiterals(file)) {
      for (const rule of BANNED) {
        if (rule.test(found.text)) {
          offenders.push(`${found.file}:${found.line} has ${rule.name}: ${found.text.trim()}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('the guard still catches the wording it replaced', () => {
  // Verbatim strings from before the voice pass. If a rule ever stops matching
  // its own old wording the guard has narrowed silently, which is worse than a
  // failing screen nobody noticed.
  const replaced = [
    'No listen key',
    'The call ended because the gateway connection dropped.',
    'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).',
    'Enter your PC Tailscale name or 100.x.x.x address.',
  ];
  for (const text of replaced) {
    expect(BANNED.filter((rule) => rule.test(text)).length).toBeGreaterThan(0);
  }

  // And the words that replaced them pass, so the guard cannot be satisfied by
  // banning too much.
  const replacements = [
    'Not set up yet',
    'The call ended because the connection to your computer dropped.',
    'Use a PC name, 100.x.x.x address, or LAN IP — optional :port (Gate is 8760).',
    'Enter your PC name or 100.x.x.x address.',
  ];
  for (const text of replacements) {
    expect(BANNED.filter((rule) => rule.test(text)).map((rule) => rule.name)).toEqual([]);
  }
});

test('the voice the roster already had is still there', () => {
  const roster = fs.readFileSync(path.join(ROOT, 'src/components/chat/chat-roster.tsx'), 'utf8');
  // Kept deliberately (spec §2): the roster's tone is the one to match.
  expect(roster).toContain('Your team');
  expect(roster).toContain('Talk to any model, no Bot in between');
});
