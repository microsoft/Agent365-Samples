// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// AWS Lambda entry point (deploy-aws.ps1 sets AWS_LAMBDA_NODEJS_ENTRYPOINT=dist/lambda.js).
// Dynamic imports run strictly in order: the require(esm) shim, then the Secrets Manager settings
// (A365_SECRETS_ARN), then the app (index.js registers telemetry, then loads app.js). A static
// import wouldn't guarantee that, because sibling imports don't wait on top-level await.
await import('./require-esm-compat.js');
await import('./secrets.js');
await import('./index.js');
