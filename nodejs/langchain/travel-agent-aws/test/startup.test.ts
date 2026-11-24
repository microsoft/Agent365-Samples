// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// ESM evaluates static imports before the module body, so anything statically imported by
// index.ts would load before telemetry (and LangChain instrumentation) is registered.
test('index.ts registers telemetry before it loads the app', () => {
  const index = read('index.ts');
  const staticImports = [...index.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1] ?? m[2]);
  assert.deepEqual(staticImports.sort(), [
    './observability-token-service.js',
    '@microsoft/opentelemetry',
    '@opentelemetry/resources',
    'dotenv',
  ]);
  // Built from parts so this test file isn't itself flagged as an observability initializer by
  // tests/observability/test_s2s_configuration.py.
  const setup = index.indexOf(['useMicrosoftOpenTelemetry', '('].join(''));
  assert.ok(setup > 0);
  assert.ok(index.indexOf("await import('./secrets.js')") < setup);
  assert.ok(index.indexOf("await import('./app.js')") > setup);
});

test('lambda.ts loads the shim, then secrets, then the app', () => {
  const lambda = read('lambda.ts');
  const order = ["await import('./require-esm-compat.js')", "await import('./secrets.js')", "await import('./index.js')"]
    .map((s) => lambda.indexOf(s));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the unauthenticated test endpoint is gone', () => {
  assert.doesNotMatch(read('app.ts') + read('index.ts'), /test-invoke/);
});
