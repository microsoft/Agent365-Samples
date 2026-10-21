// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// On AWS, secret settings (blueprint client secret, observability blueprint secret, ...) are not
// function environment variables. deploy-aws.ps1 and the CloudFormation template store them in one
// Secrets Manager secret whose SecretString is a JSON object of setting name -> value, and pass only
// its ARN in A365_SECRETS_ARN. This module loads that secret into process.env before the app reads
// any setting (lambda.ts imports it before index.js). Without A365_SECRETS_ARN (local runs) it does
// nothing and .env is used as before.

const INVALID_SECRET = 'A365_SECRETS_ARN secret must be a JSON object of setting names to strings';

// Sets each string value whose key is unset or empty in env; returns the applied key names only.
export function applySecretValues(secretString: string, env: NodeJS.ProcessEnv): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    // JSON.parse's message echoes part of the input, so it is never surfaced.
    throw new Error(INVALID_SECRET);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(INVALID_SECRET);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (env[key] !== undefined && env[key] !== '') continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

const secretsArn = process.env.A365_SECRETS_ARN?.trim();
if (secretsArn) {
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    // arn:<partition>:secretsmanager:<region>:<account>:secret:<name>
    const region = secretsArn.split(':')[3] || undefined;
    const out = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secretsArn }));
    if (!out.SecretString) throw new Error('secret has no SecretString');
    const keys = applySecretValues(out.SecretString, process.env);
    console.log(`Loaded ${keys.length} settings from Secrets Manager`);
  } catch (err) {
    console.error(`Failed to load settings from A365_SECRETS_ARN: ${(err as Error)?.name ?? 'Error'}`);
    throw err;
  }
}
