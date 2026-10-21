// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// AWS Lambda's managed Node.js runtimes start Node with --no-experimental-require-module, so
// CommonJS code there can't require() an ESM-only package. jwks-rsa, which
// @microsoft/agents-hosting uses to validate incoming JWTs, calls require('jose'), and jose v6
// ships only ESM. When require(esm) is off, import those packages up front and seed the
// CommonJS module cache, so require() returns the already-loaded module instead of throwing.
// Where require(esm) works (Azure App Service, local Node 22.12+), this does nothing.
// lambda.ts awaits this module before it loads the app.
import Module, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// [CommonJS package that calls require(), ESM-only package it requires]
const ESM_ONLY_REQUIRES: ReadonlyArray<readonly [string, string]> = [['jwks-rsa', 'jose']];

if (!process.features.require_module) {
  const require = createRequire(import.meta.url);
  for (const [requiredBy, dependency] of ESM_ONLY_REQUIRES) {
    let filename: string;
    try {
      // Resolve the exact file the CommonJS caller gets, including a nested copy if it has one.
      filename = createRequire(require.resolve(requiredBy)).resolve(dependency);
    } catch (err) {
      console.warn(
        `[esm-compat] Could not resolve ${dependency} for ${requiredBy}; skipping (a later ERR_REQUIRE_ESM may follow):`,
        (err as Error)?.message?.slice(0, 120),
      );
      continue;
    }
    if (require.cache[filename]) continue;
    const cached = new Module(filename);
    cached.filename = filename;
    cached.exports = await import(pathToFileURL(filename).href);
    cached.loaded = true;
    require.cache[filename] = cached;
  }
}
