// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTenantMismatch,
  applyTenantConnections,
  connectionNameFor,
  parseTenantRegistration,
  resolveDuplicateRegistrations,
  tenantsByBlueprint,
  type TenantRegistration,
} from '../src/tenant-registry.ts';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const B0 = 'aaaaaaaa-0000-0000-0000-000000000000';
const B1 = 'bbbbbbbb-1111-1111-1111-111111111111';
const B2 = 'cccccccc-2222-2222-2222-222222222222';

const reg = (tenantId: string, blueprintId: string): TenantRegistration =>
  ({ tenantId, blueprintId, clientSecret: `secret-${blueprintId.slice(0, 4)}` });

const P = 'travelagent/tenants/';

test('parseTenantRegistration validates ids and never echoes the secret', () => {
  const ok = parseTenantRegistration(JSON.stringify({ tenantId: T1.toUpperCase(), blueprintId: B1, clientSecret: 'S3cr3t' }), `${P}${T1}/${B1}`, P);
  assert.deepEqual(ok, { tenantId: T1, blueprintId: B1, clientSecret: 'S3cr3t' });
  for (const bad of [
    'not json S3cr3t',
    JSON.stringify({ tenantId: 'x', blueprintId: B1, clientSecret: 'S3cr3t' }),
    JSON.stringify({ tenantId: T1, blueprintId: 'nope', clientSecret: 'S3cr3t' }),
    JSON.stringify({ tenantId: T1, blueprintId: B1 }),
  ]) {
    assert.throws(() => parseTenantRegistration(bad, `${P}x`, P), (e: Error) => {
      assert.match(e.message, /travelagent\/tenants\/x/);
      assert.doesNotMatch(e.message, /S3cr3t/);
      return true;
    });
  }
});

test('a registration must be named exactly <prefix><tenantId>/<blueprintId>', () => {
  const body = JSON.stringify({ tenantId: T2, blueprintId: B1, clientSecret: 's' });
  assert.equal(parseTenantRegistration(body, `${P}${T2}/${B1}`, P).blueprintId, B1);
  assert.throws(() => parseTenantRegistration(body, `${P}${T2}/${B2}`, P), /does not match/);
  assert.throws(() => parseTenantRegistration(body, `${P}${T1}/${B1}`, P), /does not match/);
  // A registrar allowed to write only under <prefix><T1>/ can't present a T2 registration.
  assert.throws(() => parseTenantRegistration(body, `${P}${T1}/x${T2}/${B1}`, P), /does not match/);
  assert.throws(() => parseTenantRegistration(body, `other/${T2}/${B1}`, P), /does not match/);
});

test('duplicate registrations keep only the one whose credentials verify', async () => {
  const owner = { ...reg(T1, B1), clientSecret: 'real' };
  const claimant = { ...reg(T2, B1), clientSecret: 'fake' };
  const verify = async (r: TenantRegistration) => r.clientSecret === 'real';
  const one = await resolveDuplicateRegistrations([claimant, owner, reg(T2, B2)], verify);
  assert.deepEqual(one.conflicts, []);
  assert.deepEqual(one.registrations.map(r => `${r.tenantId}/${r.blueprintId}`).sort(), [`${T1}/${B1}`, `${T2}/${B2}`].sort());
  const none = await resolveDuplicateRegistrations([claimant, { ...owner, clientSecret: 'expired' }], verify);
  assert.deepEqual(none, { registrations: [], conflicts: [B1] });
  const throwing = await resolveDuplicateRegistrations([owner, claimant], async () => { throw new Error('network'); });
  assert.deepEqual(throwing.conflicts, [B1]);
});

test('unresolved duplicates are still skipped by applyTenantConnections', () => {
  const env: NodeJS.ProcessEnv = {};
  const summary = applyTenantConnections([reg(T1, B1), reg(T2, B1), reg(T2, B2)], env);
  assert.deepEqual(summary.conflicts, [B1]);
  assert.equal(summary.blueprints, 1);
  assert.equal(env[`connections__${connectionNameFor(B1)}__settings__clientId`], undefined);
  assert.equal(env.connectionsMap__0__audience, B2);
});

test('a registration replaces a .env connection secret only for the same tenant', () => {
  const base = (): NodeJS.ProcessEnv => ({
    connections__service_connection__settings__clientId: B1,
    connections__service_connection__settings__clientSecret: 'old',
    connections__service_connection__settings__tenantId: T1,
  });
  const same = base();
  assert.equal(applyTenantConnections([reg(T1, B1)], same).blueprints, 1);
  assert.equal(same.connections__service_connection__settings__clientSecret, 'secret-bbbb');
  assert.equal(same.connectionsMap__0__connection, 'service_connection');

  const other = base();
  const summary = applyTenantConnections([reg(T2, B1)], other);
  assert.deepEqual(summary.conflicts, [B1]);
  assert.equal(other.connections__service_connection__settings__clientSecret, 'old');
  assert.equal(other.connections__service_connection__settings__tenantId, T1);
});

test('activityTenantMismatch flags any tenant field that differs from the blueprint\'s tenant', () => {
  const env: NodeJS.ProcessEnv = {};
  applyTenantConnections([reg(T1, B1), reg(T2, B2)], env);
  const tenants = tenantsByBlueprint(env);
  assert.equal(activityTenantMismatch(tenants, B1, { recipient: { tenantId: T1 }, conversation: { tenantId: T1 } }), false);
  assert.equal(activityTenantMismatch(tenants, [B1], { conversation: { tenantId: T2.toUpperCase() } }), true);
  assert.equal(activityTenantMismatch(tenants, B2, { channelData: { tenant: { id: T1 } } }), true);
  assert.equal(activityTenantMismatch(tenants, B1, { recipient: { tenantId: T1 }, conversation: { tenantId: T2 } }), true);
  assert.equal(activityTenantMismatch(tenants, B2, {}), false);
  assert.equal(activityTenantMismatch(tenants, B0, { recipient: { tenantId: T1 } }), false);
});
test('applyTenantConnections routes every blueprint by audience and drops the alt blueprint pin', () => {
  const env: NodeJS.ProcessEnv = {
    connections__service_connection__settings__clientId: B0,
    connections__service_connection__settings__clientSecret: 'base',
    connections__service_connection__settings__tenantId: T1,
    connectionsMap__0__serviceUrl: '*',
    connectionsMap__0__connection: 'service_connection',
    agentic_altBlueprintConnectionName: 'service_connection',
  };
  const summary = applyTenantConnections([reg(T1, B1), reg(T2, B2)], env);
  assert.equal(summary.blueprints, 3);
  assert.equal(summary.tenants, 2);
  assert.deepEqual(summary.conflicts, []);
  assert.equal(env.agentic_altBlueprintConnectionName, undefined);
  assert.equal(env[`connections__${connectionNameFor(B2)}__settings__tenantId`], T2);
  assert.equal(env.connectionsMap__0__audience, B0);
  assert.equal(env.connectionsMap__0__connection, 'service_connection');
  assert.equal(env.connectionsMap__2__audience, B2);
  assert.equal(env.connectionsMap__3__audience, undefined);
  // The .env connection keeps its own secret when no registration exists for its blueprint.
  assert.equal(env.connections__service_connection__settings__clientSecret, 'base');
});

test('the Agents SDK picks the connection whose blueprint matches the incoming token audience', async () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (/^(connections|connectionsmap|agentic_|clientid|clientsecret|tenantid)/i.test(k)) delete process.env[k];
    }
    applyTenantConnections([reg(T1, B1), reg(T2, B2)], process.env);
    // The SDK snapshots connection settings from the environment when it is first imported, which is
    // why secrets.ts runs before the app imports it (lambda.ts).
    const { loadAuthConfigFromEnv, MsalConnectionManager } = await import('@microsoft/agents-hosting');
    const config = loadAuthConfigFromEnv();
    const manager = new MsalConnectionManager(config.connections, config.connectionsMap, config);
    const serviceUrl = 'https://smba.trafficmanager.net/amer/';
    assert.equal(manager.getTokenProvider({ aud: B2 } as any, serviceUrl).connectionSettings?.clientId, B2);
    assert.equal(manager.getTokenProvider({ aud: B1 } as any, serviceUrl).connectionSettings?.clientId, B1);
    assert.equal(manager.getTokenProvider({ aud: B2 } as any, serviceUrl).connectionSettings?.tenantId, T2);
    assert.throws(() => manager.getTokenProvider({ aud: B0 } as any, serviceUrl));
    // Incoming-token validation accepts exactly the registered blueprint ids.
    const clientIds = [...(config.connections?.values() ?? [])].map(c => c.clientId).sort();
    assert.deepEqual(clientIds, [B1, B2].sort());
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
