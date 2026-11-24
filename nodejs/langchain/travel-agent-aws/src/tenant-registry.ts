// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Multi-tenant mode: one backend serves agent blueprints from many Microsoft 365 tenants.
//
// register-tenant.ps1 stores each blueprint's credentials in its own Secrets Manager secret named
// <prefix><tenantId>/<blueprintId> (for example travelagent/tenants/<tenantId>/<blueprintId>), with a
// JSON SecretString {"tenantId","blueprintId","clientSecret"}. At cold start secrets.ts loads every
// secret under A365_TENANT_SECRETS_PREFIX and calls applyTenantConnections, which turns them into
// Agents SDK connection settings before the app reads its auth configuration:
//
//   connections__t_<blueprint>__settings__clientId / clientSecret / tenantId
//   connectionsMap__<n>__audience = <blueprintId>, serviceUrl = *, connection = t_<blueprint>
//
// The SDK then accepts an incoming token only if its audience is one of the registered blueprint ids,
// and picks the same connection for replies and agentic user tokens. Because tokens can be issued by
// the Bot Framework rather than the blueprint's tenant, app.ts also checks that the activity's tenant
// is the one registered for that blueprint (activityTenantMismatch). agentic_altBlueprintConnectionName
// is removed because it would pin every agentic token to a single blueprint.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantRegistration {
  tenantId: string;
  blueprintId: string;
  clientSecret: string;
}

// Parses one tenant secret. Error messages name the secret, never its value. The secret's name must be
// exactly <prefix><tenantId>/<blueprintId> for the ids inside, so a registrar allowed to write only
// under <prefix><own tenant>/ can't present a registration for another tenant.
export function parseTenantRegistration(secretString: string, secretName: string, prefix: string): TenantRegistration {
  let parsed: any;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error(`Tenant secret ${secretName} is not valid JSON`);
  }
  const tenantId = typeof parsed?.tenantId === 'string' ? parsed.tenantId.trim().toLowerCase() : '';
  const blueprintId = typeof parsed?.blueprintId === 'string' ? parsed.blueprintId.trim().toLowerCase() : '';
  const clientSecret = typeof parsed?.clientSecret === 'string' ? parsed.clientSecret : '';
  if (!GUID.test(tenantId)) throw new Error(`Tenant secret ${secretName} has no valid tenantId`);
  if (!GUID.test(blueprintId)) throw new Error(`Tenant secret ${secretName} has no valid blueprintId`);
  if (!clientSecret) throw new Error(`Tenant secret ${secretName} has no clientSecret`);
  if (secretName.toLowerCase() !== `${prefix}${tenantId}/${blueprintId}`.toLowerCase()) {
    throw new Error(`Tenant secret ${secretName} does not match its tenantId/blueprintId`);
  }
  return { tenantId, blueprintId, clientSecret };
}

// A blueprint id isn't secret, so two registrations can name the same blueprint (a mistake, or someone
// claiming another tenant's agent). For each such group, keep only the registration whose credentials
// actually work (verify = can acquire a token as that blueprint in that tenant); if not exactly one
// does, drop the whole group. Returns the surviving registrations and the dropped blueprint ids.
export async function resolveDuplicateRegistrations(
  registrations: TenantRegistration[],
  verify: (reg: TenantRegistration) => Promise<boolean>
): Promise<{ registrations: TenantRegistration[]; conflicts: string[] }> {
  const groups = new Map<string, TenantRegistration[]>();
  for (const reg of registrations) groups.set(reg.blueprintId, [...(groups.get(reg.blueprintId) ?? []), reg]);
  const kept: TenantRegistration[] = [];
  const conflicts: string[] = [];
  await Promise.all([...groups].map(async ([blueprintId, group]) => {
    if (group.length === 1) { kept.push(group[0]); return; }
    const verified = (await Promise.all(group.map(async r => ((await verify(r).catch(() => false)) ? r : null))))
      .filter((r): r is TenantRegistration => r !== null);
    if (verified.length === 1) kept.push(verified[0]);
    else conflicts.push(blueprintId);
  }));
  return { registrations: kept, conflicts };
}

export function connectionNameFor(blueprintId: string): string {
  return `t_${blueprintId.toLowerCase().replace(/-/g, '')}`;
}

const CONNECTION_KEY = /^connections__(.+)__settings__clientid$/i;
const MAP_KEY = /^connectionsmap__/i;
const ALT_BLUEPRINT_KEY = /^agentic_(altBlueprintConnectionName|alternateBlueprintConnectionName)$/i;

export interface TenantConnectionsSummary {
  tenants: number;
  blueprints: number;
  connections: string[];
  conflicts: string[];
}

// Rewrites env so every connection (the .env one, if any, plus one per registration) is routed by
// blueprint id. Pass registrations through resolveDuplicateRegistrations first; any blueprint still
// registered more than once is skipped here as a conflict. A registration replaces a .env connection's
// credentials (e.g. a rotated secret) only when both name the same tenant; otherwise it's ignored.
export function applyTenantConnections(
  registrations: TenantRegistration[],
  env: NodeJS.ProcessEnv
): TenantConnectionsSummary {
  const routes: { connection: string; audience: string }[] = [];
  const envConnections = new Map<string, string>(); // blueprint id -> settings key prefix

  for (const key of Object.keys(env)) {
    const m = CONNECTION_KEY.exec(key);
    const clientId = (env[key] ?? '').trim().toLowerCase();
    if (!m || !GUID.test(clientId) || envConnections.has(clientId)) continue;
    envConnections.set(clientId, key.slice(0, key.length - 'clientId'.length));
    routes.push({ connection: m[1], audience: clientId });
  }

  const counts = new Map<string, number>();
  for (const reg of registrations) counts.set(reg.blueprintId, (counts.get(reg.blueprintId) ?? 0) + 1);
  const conflicts = [...counts].filter(([, n]) => n > 1).map(([id]) => id);

  const tenants = new Set<string>();
  for (const reg of registrations) {
    if (conflicts.includes(reg.blueprintId)) continue;
    const existing = envConnections.get(reg.blueprintId);
    if (existing) {
      const envTenant = (env[`${existing}tenantId`] ?? '').trim().toLowerCase();
      if (envTenant !== reg.tenantId) {
        conflicts.push(reg.blueprintId);
        continue;
      }
      env[`${existing}clientSecret`] = reg.clientSecret;
      tenants.add(reg.tenantId);
      continue;
    }
    tenants.add(reg.tenantId);
    const name = connectionNameFor(reg.blueprintId);
    env[`connections__${name}__settings__clientId`] = reg.blueprintId;
    env[`connections__${name}__settings__clientSecret`] = reg.clientSecret;
    env[`connections__${name}__settings__tenantId`] = reg.tenantId;
    routes.push({ connection: name, audience: reg.blueprintId });
  }

  for (const key of Object.keys(env)) {
    if (MAP_KEY.test(key) || ALT_BLUEPRINT_KEY.test(key)) delete env[key];
  }
  routes.forEach((r, i) => {
    env[`connectionsMap__${i}__audience`] = r.audience;
    env[`connectionsMap__${i}__serviceUrl`] = '*';
    env[`connectionsMap__${i}__connection`] = r.connection;
  });

  return { tenants: tenants.size, blueprints: routes.length, connections: routes.map(r => r.connection), conflicts };
}

// Blueprint id -> tenant id for every configured connection with a concrete tenant.
export function tenantsByBlueprint(env: NodeJS.ProcessEnv): Map<string, string> {
  const result = new Map<string, string>();
  for (const key of Object.keys(env)) {
    if (!CONNECTION_KEY.test(key)) continue;
    const clientId = (env[key] ?? '').trim().toLowerCase();
    const tenantId = (env[`${key.slice(0, key.length - 'clientId'.length)}tenantId`] ?? '').trim().toLowerCase();
    if (GUID.test(clientId) && GUID.test(tenantId)) result.set(clientId, tenantId);
  }
  return result;
}

// True when any tenant field of the activity differs from the tenant registered for the token's
// audience (blueprint). All three fields are checked because different code reads different ones
// (identity.ts keys state by conversation.tenantId; the SDK's agentic tenant is recipient.tenantId).
// Activities that carry no tenant, or audiences without a registered tenant, aren't judged here.
export function activityTenantMismatch(
  tenants: Map<string, string>,
  audience: unknown,
  activity: any
): boolean {
  const aud = (Array.isArray(audience) ? audience[0] : audience);
  const expected = typeof aud === 'string' ? tenants.get(aud.toLowerCase()) : undefined;
  if (!expected) return false;
  return [activity?.recipient?.tenantId, activity?.conversation?.tenantId, activity?.channelData?.tenant?.id]
    .some((v) => typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== expected);
}
