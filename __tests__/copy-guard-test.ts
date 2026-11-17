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
  'src/components/chat/handsfree-call-sheet.tsx',
  'src/components/terminal/terminal-screen.tsx',
  'src/components/gateway/gateway-command-panel.tsx',
  'src/components/gateway/compact-gateway-list.tsx',
  'src/components/gateway/gateway-home-dashboard.tsx',
  'src/app/gateway/settings.tsx',
  // Copy the roster, the call banner and the address check render from, so the
  // words they show are guarded at their source too.
  'src/lib/gateway/bots.ts',
  'src/lib/voice/handsfree-call-copy.ts',
  'src/lib/voice/handsfree-start-policy.ts',
  'src/lib/voice/voice-engine-choice.ts',
  'src/lib/voice/voice-engine-copy.ts',
  'src/lib/onboarding/validate-pc-address.ts',
];

/**
 * The call surface's own words: the sheet, the end line, the start failures,
 * the engine names and the engine decision. They are held to the term map in
 * `docs/voice.md` in addition to the shared rules above.
 */
const CALL_SURFACE = [
  'src/components/chat/handsfree-call-sheet.tsx',
  'src/lib/voice/handsfree-call-copy.ts',
  'src/lib/voice/handsfree-start-policy.ts',
  'src/lib/voice/voice-engine-choice.ts',
  'src/lib/voice/voice-engine-copy.ts',
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
    // The roster's one line says "Not set up yet"; the key's name is Details.
    name: 'a listen key on the main view',
    test: (text) => /\blisten key\b/i.test(text) && /\s/.test(text),
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

/**
 * Internal words the call surface must not speak. Prose only (`\s`): the copy
 * modules also carry method ids, engine ids and case labels ('thread-changed',
 * 'no-gateway-url') and those are code, not copy.
 */
const CALL_BANNED: { name: string; test: (text: string) => boolean }[] = [
  {
    name: 'the internal word "gateway" in call copy',
    test: (text) => /\bgateway\b/i.test(text) && /\s/.test(text),
  },
  {
    name: 'the internal word "host" in call copy',
    test: (text) => /\bhost\b/i.test(text) && /\s/.test(text),
  },
  {
    name: 'a "chat session" in call copy',
    test: (text) => /\bchat session\b/i.test(text) && /\s/.test(text),
  },
  {
    name: 'the internal word "session" in call prose',
    test: (text) => /\bsessions?\b/i.test(text) && /\s/.test(text),
  },
  {
    name: 'the internal word "thread" in call prose',
    test: (text) => /\bthreads?\b/i.test(text) && /\s/.test(text),
  },
  {
    name: 'a "media path" in call copy',
    test: (text) => /\bmedia path\b/i.test(text) && /\s/.test(text),
  },
  {
    // The field is the message box; "composer" is the name in the code.
    name: 'the composer in call copy',
    test: (text) => /\bcomposer\b/i.test(text) && /\s/.test(text),
  },
];

const ALL_BANNED = [...BANNED, ...CALL_BANNED];

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

test('the call surface uses the operator’s words', () => {
  const offenders: string[] = [];
  for (const file of CALL_SURFACE) {
    for (const found of stringLiterals(file)) {
      for (const rule of CALL_BANNED) {
        if (rule.test(found.text)) {
          offenders.push(`${found.file}:${found.line} has ${rule.name}: ${found.text.trim()}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('the call surface’s words are pinned', () => {
  // Verbatim, so a reverted sentence fails here even when it is not caught by a
  // banned word: this is the half of the guard that pins the replacement copy.
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const callCopy = read('src/lib/voice/handsfree-call-copy.ts');
  const sheet = read('src/components/chat/handsfree-call-sheet.tsx');
  const policy = read('src/lib/voice/handsfree-start-policy.ts');
  const choice = read('src/lib/voice/voice-engine-choice.ts');
  const engineCopy = read('src/lib/voice/voice-engine-copy.ts');

  for (const line of [
    'The call ended because the connection to your computer dropped.',
    'What you said is back in the message box.',
    'This phone would not start a call.',
    'Versutus does not have this PC’s address, so a call cannot start. Reconnect to the PC, then try again.',
    'The PC could not open a chat for this call. Try again from the conversation you want to call.',
    'Getting this chat ready…',
    'The PC has not approved this phone, so it will not open a call. Approve this phone on the PC, then start again.',
    'The PC voice engine is not ready. Install the voice models in Settings, then start again.',
    'Calls need a secure connection to your computer. Use HTTPS or Tailscale. Then start again.',
    'The PC opened a call without an audio link, so this phone could not join it. Try again.',
    'The call ended before it finished opening. The connection dropped or you changed conversations. Start again from the conversation you want to call.',
  ]) {
    expect(callCopy).toContain(line);
  }

  expect(sheet).toContain("'Start a hands-free call?'");
  expect(sheet).toContain('Using {engineLabel}');
  expect(sheet).toContain('Change engine');
  expect(policy).toContain('Versutus is not connected to your computer yet.');
  expect(choice).toContain("'Gate voice is turned off on this PC.'");
  expect(engineCopy).toContain("label: 'This PC',");
  expect(engineCopy).toContain("label: 'ChatGPT on this PC',");
  expect(engineCopy).toContain("label: 'This phone only',");
});

test('the guard still catches the wording it replaced', () => {
  // Verbatim strings from before the voice pass. If a rule ever stops matching
  // its own old wording the guard has narrowed silently, which is worse than a
  // failing screen nobody noticed.
  const replaced = [
    'No listen key',
    'Default listen key refused',
    'The call ended because the gateway connection dropped.',
    'The call ended because a turn could not be sent. What you said is back in the composer.',
    'The PC opened a call without a media path, so this phone could not join it.',
    'This thread does not have a chat session yet.',
    'Calls need a secure connection to your gateway. Use HTTPS or Tailscale.',
    'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).',
    'Enter your PC Tailscale name or 100.x.x.x address.',
  ];
  for (const text of replaced) {
    expect(ALL_BANNED.filter((rule) => rule.test(text)).length).toBeGreaterThan(0);
  }

  // And the words that replaced them pass, so the guard cannot be satisfied by
  // banning too much.
  const replacements = [
    'Not set up yet',
    'The call ended because the connection to your computer dropped.',
    'What you said is back in the message box.',
    'The PC opened a call without an audio link, so this phone could not join it. Try again.',
    'The PC could not open a chat for this call. Try again from the conversation you want to call.',
    'Calls need a secure connection to your computer. Use HTTPS or Tailscale. Then start again.',
    'Use a PC name, 100.x.x.x address, or LAN IP — optional :port (Gate is 8760).',
    'Enter your PC name or 100.x.x.x address.',
  ];
  for (const text of replacements) {
    expect(ALL_BANNED.filter((rule) => rule.test(text)).map((rule) => rule.name)).toEqual([]);
  }
});

test('the voice the roster already had is still there', () => {
  const roster = fs.readFileSync(path.join(ROOT, 'src/components/chat/chat-roster.tsx'), 'utf8');
  // Kept deliberately (spec §2): the roster's tone is the one to match.
  expect(roster).toContain('Your team');
  expect(roster).toContain('Talk to any model, no Bot in between');
});
