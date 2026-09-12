// Guards against config that looks like a gate but runs nothing.
//
// Two no-op configs shipped in the 2026-08-17/19 cycle: a `coverageThreshold`
// that never executed because `npm test` omitted `--coverage`, and smoke-test
// assertions that had been silently red since 2026-08-05. Both looked correct in
// review. Each check below turns one of those silent classes into a build error.
//
// Run: npx tsx scripts/verify-config.mts
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures: string[] = [];

function fail(check: string, detail: string) {
  failures.push(`${check}: ${detail}`);
  console.log(`  FAIL  ${check}\n        ${detail}`);
}

function pass(check: string, detail: string) {
  console.log(`  ok    ${check} — ${detail}`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  jest?: {
    coverageThreshold?: Record<string, Record<string, number>>;
    collectCoverageFrom?: string[];
  };
};

// ---------------------------------------------------------------------------
// 1. Every coverageThreshold key must point at files that exist AND are
//    collected. A key that matches nothing makes jest report "Coverage data for
//    X was not found" — which does fail, but only once coverage actually runs.
// ---------------------------------------------------------------------------
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const thresholds = pkg.jest?.coverageThreshold ?? {};
const thresholdKeys = Object.keys(thresholds).filter((key) => key !== 'global');

if (thresholdKeys.length === 0) {
  fail('coverage-threshold-present', 'no per-path coverageThreshold configured; the floor is not defended');
} else {
  for (const key of thresholdKeys) {
    const dir = join(root, key);
    const found = filesUnder(dir);
    if (found.length === 0) {
      fail('coverage-threshold-resolves', `coverageThreshold key "${key}" matches no .ts/.tsx files`);
    } else {
      pass('coverage-threshold-resolves', `"${key}" → ${found.length} files`);
    }
  }
}

// The threshold only runs if something actually passes --coverage.
const runsCoverage = Object.values(pkg.scripts ?? {}).some((cmd) => cmd.includes('--coverage'));
if (!runsCoverage) {
  fail(
    'coverage-threshold-executes',
    'no npm script passes --coverage, so coverageThreshold is dead config and gates nothing',
  );
} else {
  // Follow `verify` one level into the scripts it delegates to.
  const verify = pkg.scripts?.verify ?? '';
  const delegates = [...verify.matchAll(/npm run ([\w:-]+)/g)].map((m) => pkg.scripts?.[m[1]] ?? '');
  const reachesCoverage = [verify, ...delegates].some((cmd) => cmd.includes('--coverage'));
  if (!reachesCoverage) {
    fail('coverage-threshold-executes', '`verify` never reaches a --coverage script, so CI skips the floor');
  } else {
    pass('coverage-threshold-executes', 'verify reaches a --coverage run');
  }
}

// ---------------------------------------------------------------------------
// 2. Every `npm run X` referenced by CI must exist in package.json.
// ---------------------------------------------------------------------------
const ciPath = join(root, '.github', 'workflows', 'ci.yml');
if (!existsSync(ciPath)) {
  fail('ci-scripts-exist', '.github/workflows/ci.yml is missing');
} else {
  const ci = readFileSync(ciPath, 'utf8');
  const referenced = [...ci.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  const missing = referenced.filter((name) => !(pkg.scripts ?? {})[name]);
  if (missing.length > 0) {
    fail('ci-scripts-exist', `CI runs scripts that do not exist: ${[...new Set(missing)].join(', ')}`);
  } else {
    pass('ci-scripts-exist', `${new Set(referenced).size} referenced scripts all defined`);
  }
}

// ---------------------------------------------------------------------------
// 3. AGENTS.md tells every agent which Expo docs to read. If it drifts from the
//    installed SDK, every agent reads the wrong API surface -- which is exactly
//    what happened when the app moved to 57 and AGENTS.md still said 56.
// ---------------------------------------------------------------------------
const agentsPath = join(root, 'AGENTS.md');
if (!existsSync(agentsPath)) {
  fail('agents-md-expo-version', 'AGENTS.md is missing');
} else {
  const agents = readFileSync(agentsPath, 'utf8');
  const cited = agents.match(/docs\.expo\.dev\/versions\/v(\d+)/);
  const installed = (pkg.dependencies?.expo ?? '').match(/(\d+)/);
  if (!cited) {
    fail('agents-md-expo-version', 'AGENTS.md cites no https://docs.expo.dev/versions/vNN URL');
  } else if (!installed) {
    fail('agents-md-expo-version', 'package.json has no resolvable expo dependency version');
  } else if (cited[1] !== installed[1]) {
    fail(
      'agents-md-expo-version',
      `AGENTS.md cites Expo v${cited[1]} but package.json installs expo ${pkg.dependencies?.expo}`,
    );
  } else {
    pass('agents-md-expo-version', `both on Expo ${cited[1]}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Every key on GatewayContextValue must be consumed by a screen, component
//    or hook. `tlsFingerprintChange` shipped exposed and rendered by nothing:
//    the provider computed a fingerprint mismatch, blocked the connect and
//    returned, leaving the gateway unconnectable with no UI to resolve it.
//    A context key with no consumer is perfectly well-typed, so only this
//    catches it.
// ---------------------------------------------------------------------------

/** Keys consumed inside the provider itself. Written-down exceptions only. */
const CONTEXT_KEYS_WITHOUT_COMPONENT_CONSUMER = new Set<string>([
  // Passed into the slash-command execution context as
  // `runTask: (prompt, onEvent) => …` rather than destructured from useGateway.
  'runTask',
]);

function contextKeys(source: string): string[] {
  const start = source.indexOf('type GatewayContextValue = {');
  if (start === -1) return [];

  const keys: string[] = [];
  let depth = 0;
  let parens = 0;

  for (const rawLine of source.slice(start).split('\n')) {
    // Property names live at brace depth 1 and outside any parentheses; a
    // multi-line function signature puts its params at depth 1 too.
    if (depth === 1 && parens === 0) {
      const match = rawLine.trim().match(/^([A-Za-z_$][\w$]*)\??\s*:/);
      if (match) keys.push(match[1]);
    }
    depth += (rawLine.match(/\{/g) ?? []).length;
    depth -= (rawLine.match(/\}/g) ?? []).length;
    parens += (rawLine.match(/\(/g) ?? []).length;
    parens -= (rawLine.match(/\)/g) ?? []).length;
    if (depth === 0 && keys.length > 0) break;
  }

  return [...new Set(keys)];
}

const providerPath = join(root, 'src', 'context', 'gateway-provider.tsx');
if (!existsSync(providerPath)) {
  fail('context-has-no-dead-state', 'src/context/gateway-provider.tsx is missing');
} else {
  const keys = contextKeys(readFileSync(providerPath, 'utf8'));
  if (keys.length < 40) {
    // Guards the parser: a silent parse failure would make this check vacuous.
    fail('context-has-no-dead-state', `parsed only ${keys.length} context keys; the parser is broken`);
  } else {
    const consumers = ['src/app', 'src/components', 'src/hooks']
      .flatMap((dir) => filesUnder(join(root, dir)))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    const orphans = keys.filter(
      (key) => !CONTEXT_KEYS_WITHOUT_COMPONENT_CONSUMER.has(key) && !new RegExp(`\\b${key}\\b`).test(consumers),
    );

    if (orphans.length > 0) {
      fail(
        'context-has-no-dead-state',
        `${orphans.length} context key(s) exposed but consumed by nothing: ${orphans.join(', ')}`,
      );
    } else {
      pass('context-has-no-dead-state', `all ${keys.length} context keys reach a consumer`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5b. The hands-free call's native configuration is locked and honest.
//
//     The call is a user-started microphone/media-playback foreground service,
//     never a carrier/VoIP call. Three things shipped wrong here would each be
//     invisible until a device misbehaved: a missing permission (the service
//     refused to start), a missing `audio` background mode (iOS suspended the
//     call), and a `phoneCall`/boot/sticky declaration (the app opens a
//     microphone without a visible Start, which B5 forbids). Each is a build
//     error rather than a note.
// ---------------------------------------------------------------------------
const CALL_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

const appJsonPath = join(root, 'app.json');
const appJsonText = readFileSync(appJsonPath, 'utf8');
const appJson = JSON.parse(appJsonText) as {
  expo?: {
    android?: { permissions?: string[] };
    ios?: { infoPlist?: { UIBackgroundModes?: string[] } };
  };
};

const declaredPermissions = appJson.expo?.android?.permissions ?? [];
const missingPermissions = CALL_PERMISSIONS.filter((permission) => !declaredPermissions.includes(permission));
if (missingPermissions.length > 0) {
  fail('handsfree-permissions', `app.json is missing: ${missingPermissions.join(', ')}`);
} else {
  pass('handsfree-permissions', `${CALL_PERMISSIONS.length} call permissions declared in app.json`);
}

const backgroundModes = appJson.expo?.ios?.infoPlist?.UIBackgroundModes ?? [];
if (!backgroundModes.includes('audio')) {
  fail('handsfree-ios-background-audio', 'app.json ios.infoPlist.UIBackgroundModes does not include "audio"');
} else {
  pass('handsfree-ios-background-audio', 'ios.infoPlist.UIBackgroundModes includes "audio"');
}

const serviceManifestPath = join(
  root,
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'AndroidManifest.xml',
);
const serviceManifest = existsSync(serviceManifestPath) ? readFileSync(serviceManifestPath, 'utf8') : '';
const serviceSourcePath = join(
  root,
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeCallService.kt',
);
const serviceSource = existsSync(serviceSourcePath) ? readFileSync(serviceSourcePath, 'utf8') : '';

const forbidden: string[] = [];
// Match only an actual attribute/config value naming phoneCall, not the word
// appearing in prose - the manifest's own compliance comment ("No phoneCall
// type...") otherwise trips this check on itself.
if (
  /foregroundServiceType\s*[:=]\s*["'][^"']*\bphoneCall\b/.test(appJsonText) ||
  /android:foregroundServiceType\s*=\s*"[^"]*\bphoneCall\b/.test(serviceManifest)
) {
  forbidden.push('a phoneCall foreground-service type');
}
if (/BOOT_COMPLETED|RECEIVE_BOOT_COMPLETED/.test(serviceManifest)) {
  forbidden.push('a boot receiver or boot permission');
}
if (/android:persistent="true"/.test(serviceManifest)) {
  forbidden.push('a persistent service declaration');
}
if (/START_STICKY|START_REDELIVER_INTENT/.test(serviceSource)) {
  forbidden.push('a sticky service restart (the service must return START_NOT_STICKY)');
}
if (forbidden.length > 0) {
  fail('handsfree-no-forbidden-declarations', `the call config declares ${forbidden.join('; ')}`);
} else {
  pass('handsfree-no-forbidden-declarations', 'no phoneCall, boot or sticky-service declaration');
}

if (serviceManifest.includes('<service')) {
  const serviceProblems: string[] = [];
  if (!/HandsfreeCallService/.test(serviceManifest)) serviceProblems.push('the call service is not declared');
  if (!/android:exported="false"/.test(serviceManifest)) serviceProblems.push('the call service is not non-exported');
  if (!/android:foregroundServiceType="microphone\|mediaPlayback"/.test(serviceManifest)) {
    serviceProblems.push('the call service is not a microphone|mediaPlayback service');
  }
  if (!/android:stopWithTask="true"/.test(serviceManifest)) {
    serviceProblems.push('the call service does not stop with the task');
  }
  if (serviceProblems.length > 0) {
    fail('handsfree-service-attributes', serviceProblems.join('; '));
  } else {
    pass('handsfree-service-attributes', 'service is non-exported, microphone|mediaPlayback, stop-with-task');
  }
}

// ---------------------------------------------------------------------------
// 6. A worklet may only call functions that are themselves worklets.
//
//    `useAnimatedStyle(() => …)` is workletized by the Babel plugin, but a
//    function it calls from ANOTHER module is not — it is captured into the
//    worklet's `__closure` as an ordinary JS function, and invoking one of
//    those on the UI thread takes the whole process down. Nothing else catches
//    this: tsc is happy, lint is happy, and jest runs the helper on the JS
//    thread where it works perfectly. It shipped as a native force-close the
//    instant any chat opened on Android — the one platform whose branch
//    actually reached the call.
// ---------------------------------------------------------------------------
const WORKLET_HOOKS =
  /useAnimatedStyle|useDerivedValue|useAnimatedScrollHandler|useAnimatedReaction|useFrameCallback|runOnUI/;

async function checkWorkletCalls() {
  let babel: typeof import('@babel/core');
  try {
    babel = await import('@babel/core');
  } catch {
    fail('worklets-call-only-worklets', '@babel/core is not resolvable, so worklet bodies cannot be inspected');
    return;
  }

  const compile = (file: string) =>
    babel.transformSync(readFileSync(file, 'utf8'), {
      filename: resolve(file),
      presets: [['babel-preset-expo', {}]],
      // Android is the platform whose branches reach these calls.
      caller: { name: 'metro', platform: 'android', isDev: false, supportsStaticESM: true },
      babelrc: false,
      configFile: false,
    })?.code ?? '';

  const workletized = new Map<string, boolean>();
  const isWorkletModule = (file: string) => {
    const cached = workletized.get(file);
    if (cached !== undefined) return cached;
    const value = /__workletHash/.test(compile(file));
    workletized.set(file, value);
    return value;
  };

  const unsafe: string[] = [];
  let inspected = 0;

  for (const file of filesUnder(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    if (!WORKLET_HOOKS.test(source)) continue;

    const imports = new Map<string, string>();
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (let im = importRe.exec(source); im; im = importRe.exec(source)) {
      for (const part of im[1].split(',')) {
        const local = part.split(' as ').pop()?.trim();
        if (local) imports.set(local, im[2]);
      }
    }
    if (imports.size === 0) continue;

    let compiled: string;
    try {
      compiled = compile(file);
    } catch {
      continue; // a file Babel cannot read is tsc's problem, not this check's
    }

    const initRe = /code:"((?:[^"\\]|\\.)*)"/g;
    for (let m = initRe.exec(compiled); m; m = initRe.exec(compiled)) {
      const body = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      const closure = /const\{([^}]*)\}=this\.__closure;/.exec(body);
      if (!closure) continue;
      for (const raw of closure[1].split(',')) {
        const name = raw.split(':')[0]?.trim();
        if (!name || !imports.has(name)) continue;
        if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;

        inspected += 1;
        const spec = imports.get(name)!;
        if (!spec.startsWith('@/')) continue; // third-party helpers ship their own directives
        const base = join(root, 'src', spec.slice(2));
        const target = ['.ts', '.tsx', '/index.ts', '/index.tsx']
          .map((ext) => base + ext)
          .find((candidate) => existsSync(candidate));
        if (!target) continue;
        if (!isWorkletModule(target)) {
          unsafe.push(`${file.replace(root, '.')} calls ${name}() from '${spec}', which is not a worklet`);
        }
      }
    }
  }

  if (unsafe.length > 0) {
    fail('worklets-call-only-worklets', unsafe.join('; '));
  } else {
    pass('worklets-call-only-worklets', `${inspected} cross-module worklet call(s), all workletized`);
  }
}

await checkWorkletCalls();

console.log('');
if (failures.length > 0) {
  console.error(`verify-config: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('verify-config: all checks passed');
