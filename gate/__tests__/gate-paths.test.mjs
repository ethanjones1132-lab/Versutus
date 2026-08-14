import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveGateHome } from '../core/paths.mjs';

test('Windows default Gate home is outside the checkout', () => {
  assert.equal(
    resolveGateHome({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32'),
    'C:\\Users\\Test\\AppData\\Local\\Versutus\\Gate',
  );
});

test('VERSUTUS_GATE_HOME overrides the platform default', () => {
  assert.equal(
    resolveGateHome({
      VERSUTUS_GATE_HOME: 'D:\\tmp\\gate-home',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    }, 'win32'),
    'D:\\tmp\\gate-home',
  );
});
