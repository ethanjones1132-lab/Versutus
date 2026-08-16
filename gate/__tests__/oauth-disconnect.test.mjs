import { test } from 'node:test';
import assert from 'node:assert/strict';

import { releaseOAuthProfiles } from '../core/providers/oauth/profiles.mjs';

test('xAI consumer OAuth is not a release profile', () => {
  assert.equal(releaseOAuthProfiles.has('xai-consumer'), false);
});
