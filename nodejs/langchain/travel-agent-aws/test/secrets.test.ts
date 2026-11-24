// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySecretValues } from '../src/secrets.ts';

test('missing and empty keys are set; existing non-empty keys are kept', () => {
  const env: NodeJS.ProcessEnv = { KEEP: 'local', EMPTY: '' };
  const applied = applySecretValues(JSON.stringify({ KEEP: 'remote', EMPTY: 'filled', NEW: 'value' }), env);
  assert.deepEqual(applied.sort(), ['EMPTY', 'NEW']);
  assert.equal(env.KEEP, 'local');
  assert.equal(env.EMPTY, 'filled');
  assert.equal(env.NEW, 'value');
});

test('non-string values are ignored', () => {
  const env: NodeJS.ProcessEnv = {};
  const applied = applySecretValues(JSON.stringify({ A: 1, B: null, C: { x: 'y' }, D: true, E: 's' }), env);
  assert.deepEqual(applied, ['E']);
  assert.deepEqual(Object.keys(env), ['E']);
});

test('invalid JSON, arrays and scalars throw without echoing the secret text', () => {
  const secretText = 'super-secret-value-123';
  for (const input of [`{"k":"${secretText}"`, `["${secretText}"]`, `"${secretText}"`, 'null']) {
    assert.throws(
      () => applySecretValues(input, {}),
      (err: Error) => {
        assert.match(err.message, /must be a JSON object/);
        assert.ok(!err.message.includes(secretText));
        return true;
      },
    );
  }
});
