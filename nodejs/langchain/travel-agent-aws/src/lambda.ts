// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// AWS Lambda entry point (deploy-aws.ps1 sets AWS_LAMBDA_NODEJS_ENTRYPOINT=dist/lambda.js).
// Dynamic imports run strictly in order, so the require(esm) shim finishes before the app loads;
// a static import wouldn't guarantee that, because sibling imports don't wait on top-level await.
await import('./require-esm-compat.js');
await import('./index.js');
