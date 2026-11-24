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

// Multi-tenant mode (see tenant-registry.ts): every secret whose name starts with
// A365_TENANT_SECRETS_PREFIX is one registered blueprint. Bad entries are skipped and logged by name.
const tenantPrefix = process.env.A365_TENANT_SECRETS_PREFIX?.trim();
if (tenantPrefix) {
  try {
    const { SecretsManagerClient, BatchGetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    type BatchPage = import('@aws-sdk/client-secrets-manager').BatchGetSecretValueCommandOutput;
    const { parseTenantRegistration, applyTenantConnections, resolveDuplicateRegistrations } = await import('./tenant-registry.js');
    const region = secretsArn?.split(':')[3] || process.env.AWS_REGION || undefined;
    const client = new SecretsManagerClient({ region });
    const registrations: import('./tenant-registry.js').TenantRegistration[] = [];
    let nextToken: string | undefined;
    do {
      const page: BatchPage = await client.send(new BatchGetSecretValueCommand({
        Filters: [{ Key: 'name', Values: [tenantPrefix] }],
        MaxResults: 20,
        NextToken: nextToken,
      }));
      for (const s of page.SecretValues ?? []) {
        // The name filter is a prefix match on words; keep only exact prefix matches.
        if (!s.Name?.startsWith(tenantPrefix) || !s.SecretString) continue;
        try {
          registrations.push(parseTenantRegistration(s.SecretString, s.Name, tenantPrefix));
        } catch (e) {
          console.warn(`[Tenants] skipped: ${(e as Error).message}`);
        }
      }
      for (const e of page.Errors ?? []) console.warn(`[Tenants] could not read ${e.SecretId}: ${e.ErrorCode}`);
      nextToken = page.NextToken;
    } while (nextToken);
    // Only blueprints registered more than once are checked: the registration whose credentials can
    // get a token as that blueprint in its tenant is the owner's (Entra rejects anyone else's).
    const authority = 'https://login.microsoftonline.com';
    const resolved = await resolveDuplicateRegistrations(registrations, async (r) => {
      const res = await fetch(`${authority}/${r.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: r.blueprintId,
          client_secret: r.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
        signal: AbortSignal.timeout(4000),
      });
      return res.ok;
    });
    const summary = applyTenantConnections(resolved.registrations, process.env);
    for (const id of [...resolved.conflicts, ...summary.conflicts]) {
      console.warn(`[Tenants] blueprint ${id} has conflicting registrations; skipped`);
    }
    console.log(`[Tenants] ${summary.tenants} tenants, ${summary.blueprints} blueprints routed by audience`);
    if (summary.blueprints === 0) throw new Error('no valid tenant registrations under the configured prefix');
  } catch (err) {
    console.error(`Failed to load tenant registrations from A365_TENANT_SECRETS_PREFIX: ${(err as Error)?.name ?? 'Error'}`);
    throw err;
  }
}
