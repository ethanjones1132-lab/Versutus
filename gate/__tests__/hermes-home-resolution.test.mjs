import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHermesHome } from '../core/cli-environments/adapters/hermes.mjs';

// Two Hermes homes exist on a typical host: the real one the operator installed
// into, and the bare `~/.hermes` the CLI creates by default. Only one has
// `profiles/`. Resolving to the wrong one does not fail loudly — it serves ONE
// bot (the implicit default) and 401s with "Invalid gateway API key", because
// that home's .env carries a different key. Observed live 2026-08-25: a Gate
// started without HERMES_HOME took a 14-bot fleet down to one. Observed again
// 2026-08-26 the other way round — a launcher exporting a STALE HERMES_HOME
// did the same damage, which is why the variable no longer wins on its own.

const HOME = 'C:\\Users\\ethan';
const REAL = 'C:\\Users\\ethan\\AppData\\Local\\hermes';
const EMPTY = 'C:\\Users\\ethan\\.hermes';
const EXE = `${REAL}\\hermes-agent\\venv\\Scripts\\hermes.exe`;

/** Only REAL has profiles/ — the shape of the actual host. */
const onlyRealHasProfiles = (dir) => dir === REAL;
/** A fresh install: nothing has profiles yet. */
const nothingHasProfiles = () => false;

test('an explicit HERMES_HOME wins when it is the home holding the profiles', () => {
  assert.equal(
    resolveHermesHome({
      env: { HERMES_HOME: REAL },
      executablePath: '/somewhere/else/hermes',
      homedir: HOME,
      hasProfiles: onlyRealHasProfiles,
    }),
    REAL,
  );
});

test('a stale HERMES_HOME loses to the install that actually has profiles', () => {
  // The 2026-08-26 outage: something restarted the Gate exporting the empty
  // `~/.hermes`, and preferring that claim over the evidence collapsed the
  // roster to one bot and 401d every route. The executable names the real
  // install; a profiles/ directory proves it.
  assert.equal(
    resolveHermesHome({
      env: { HERMES_HOME: EMPTY },
      executablePath: EXE,
      homedir: HOME,
      hasProfiles: onlyRealHasProfiles,
    }),
    REAL,
  );
});

test('without the env var, the configured executable names the install', () => {
  // The environment record already says which Hermes this is. Inferring the
  // home from it beats guessing at the CLI's default, which may be a different
  // install entirely.
  assert.equal(
    resolveHermesHome({ env: {}, executablePath: EXE, homedir: HOME, hasProfiles: onlyRealHasProfiles }),
    REAL,
  );
});

test('a POSIX install resolves the same way', () => {
  assert.equal(
    resolveHermesHome({
      env: {},
      executablePath: '/opt/hermes/hermes-agent/venv/bin/hermes',
      homedir: '/home/ethan',
      hasProfiles: (dir) => dir === '/opt/hermes',
    }),
    '/opt/hermes',
  );
});

test('an executable that says nothing falls back to the CLI default', () => {
  // Never invent a home from a path that does not carry the marker.
  assert.equal(
    resolveHermesHome({
      env: {},
      executablePath: 'C:\\tools\\hermes.exe',
      homedir: HOME,
      hasProfiles: nothingHasProfiles,
    }),
    `${HOME}\\.hermes`,
  );
  assert.equal(
    resolveHermesHome({
      env: {},
      executablePath: undefined,
      homedir: HOME,
      hasProfiles: nothingHasProfiles,
    }),
    `${HOME}\\.hermes`,
  );
});

test('a blank env var is not an answer', () => {
  assert.equal(
    resolveHermesHome({
      env: { HERMES_HOME: '   ' },
      executablePath: EXE,
      homedir: HOME,
      hasProfiles: onlyRealHasProfiles,
    }),
    REAL,
  );
});

test('a fresh install still lands where the operator pointed us', () => {
  // Before the first bot exists no candidate has profiles/. Falling through to
  // the declared order keeps `hermes bot create` writing where it was told,
  // rather than somewhere invented.
  assert.equal(
    resolveHermesHome({
      env: { HERMES_HOME: REAL },
      executablePath: EXE,
      homedir: HOME,
      hasProfiles: nothingHasProfiles,
    }),
    REAL,
  );
  assert.equal(
    resolveHermesHome({
      env: {},
      executablePath: EXE,
      homedir: HOME,
      hasProfiles: nothingHasProfiles,
    }),
    REAL,
  );
});
