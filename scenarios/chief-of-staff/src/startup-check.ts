// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Startup env-validation banner. Runs once at process boot to make
// misconfiguration obvious BEFORE a live demo fails on-stage.
//
// Emits ✅ / ⚠️  / ❌ / ℹ️  per config item so you can see what's live at a glance.

import { describePersistence } from './state/persistentMap';
import { directUserActionsEnabled } from './security-policy';

function line(s: string): void {
  console.log(`[startup] ${s}`);
}

function ok(key: string, value: string, note?: string): void {
  line(`✅ ${key}=${value}${note ? ' — ' + note : ''}`);
}

function warn(key: string, note: string): void {
  line(`⚠️  ${key} not set — ${note}`);
}

function err(key: string, note: string): void {
  line(`❌ ${key} — ${note}`);
}

function info(msg: string): void {
  line(`ℹ️  ${msg}`);
}

function maskGuid(g: string): string {
  return g.length > 10 ? `${g.slice(0, 4)}…${g.slice(-4)}` : g;
}

function maskUpn(u: string): string {
  const at = u.indexOf('@');
  return at > 0 ? `${u.slice(0, Math.min(3, at))}…@…` : maskGuid(u);
}

function shortId(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/**
 * Log a one-time configuration summary. Call this immediately after
 * dotenv has been loaded and before the server starts listening.
 */
export function printStartupBanner(): void {
  line('─── Chief of Staff — Configuration Check ───');

  info(
    directUserActionsEnabled()
      ? 'ALLOW_DIRECT_USER_ACTIONS=true — authenticated direct requests may invoke action tools'
      : 'ALLOW_DIRECT_USER_ACTIONS=false — direct user commands remain data-only'
  );

  // ── Foundry LLM ──
  const foundryEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const foundryKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const foundryModel = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  const foundryApiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim();
  if (foundryEndpoint && foundryKey && foundryModel) {
    ok(
      'AZURE_OPENAI_DEPLOYMENT',
      foundryModel,
      `endpoint=${foundryEndpoint} api-version=${foundryApiVersion ?? '<default>'}`
    );
  } else {
    err(
      'AZURE_OPENAI_*',
      'agent cannot call the LLM — set AZURE_OPENAI_ENDPOINT, _API_KEY, _DEPLOYMENT'
    );
  }

  // ── Agentic identity ──
  const agentId = process.env.agent_id?.trim();
  const clientId = process.env.connections__service_connection__settings__clientId?.trim();
  const tenantId = process.env.connections__service_connection__settings__tenantId?.trim();
  if (agentId && clientId && tenantId) {
    ok('agent_id', maskGuid(agentId), `tenant=${maskGuid(tenantId)}`);
  } else {
    err(
      'agent_id / clientId / tenantId',
      'agentic auth will fail — check connections__service_connection__settings__* + agent_id'
    );
  }

  // ── Leader ──
  const leaderUpn = process.env.LEADER_UPN?.trim();
  const leaderAad = process.env.LEADER_AAD_ID?.trim();
  if (leaderAad) {
    ok('LEADER_AAD_ID', maskGuid(leaderAad));
  } else if (leaderUpn) {
    ok('LEADER_UPN', maskUpn(leaderUpn), 'LEADER_AAD_ID will auto-resolve on first turn');
  } else {
    err(
      'LEADER_UPN',
      'Brief/Escalate/Unblock/TaskComplete will emit "<LEADER_AAD_ID missing>"'
    );
  }

  // ── Planner ──
  const planId = process.env.PLANNER_PLAN_ID?.trim();
  const bucketNew = process.env.PLANNER_BUCKET_NEW?.trim();
  const planName = process.env.PLANNER_PLAN_NAME?.trim();
  const bucketName = process.env.PLANNER_BUCKET_NAME?.trim();
  const teamId = process.env.LEADERSHIP_TEAM_ID?.trim();
  if (planId) {
    ok('PLANNER_PLAN_ID', shortId(planId));
  } else if (teamId) {
    info(
      `PLANNER_PLAN_ID not set — will auto-resolve from LEADERSHIP_TEAM_ID${
        planName ? ` (looking for plan "${planName}")` : ' (expects exactly one plan in the team)'
      } on first Planner call.`
    );
  } else {
    err(
      'PLANNER_PLAN_ID',
      'Neither PLANNER_PLAN_ID nor LEADERSHIP_TEAM_ID is set — capture/brief/followup cannot run.'
    );
  }
  if (bucketNew) {
    ok('PLANNER_BUCKET_NEW', shortId(bucketNew));
  } else if (planId || teamId) {
    info(
      `PLANNER_BUCKET_NEW not set — will auto-resolve bucket "${bucketName ?? 'New'}" from the plan on first capture.`
    );
  } else {
    err(
      'PLANNER_BUCKET_NEW',
      'Capture will not create tasks — set PLANNER_BUCKET_NEW or ensure a bucket named "New" exists in the auto-resolved plan.'
    );
  }

  // ── Team / access control ──
  if (teamId) {
    // Accept a GUID, a channel email, or a display name — peopleTools resolves.
    const looksLikeGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId);
    const display = looksLikeGuid
      ? maskGuid(teamId)
      : teamId.length > 40
        ? `${teamId.slice(0, 20)}…${teamId.slice(-15)}`
        : teamId;
    const kind = looksLikeGuid ? 'GUID' : teamId.includes('@') ? 'channel email — will resolve on first turn' : 'display name — will resolve on first turn';
    ok('LEADERSHIP_TEAM_ID', display, `Recall gated to team members (${kind})`);
  } else {
    warn(
      'LEADERSHIP_TEAM_ID',
      'Recall is open to anyone in the tenant (fine for dev, tighten before pilot)'
    );
  }

  // ── Meeting capture ──
  const cosAgentUpn = process.env.COS_AGENT_UPN?.trim();
  if (cosAgentUpn) {
    ok(
      'COS_AGENT_UPN',
      maskUpn(cosAgentUpn),
      'meetings captured whenever BOTH the leader and this UPN are on the invite (any organizer, including in-progress/upcoming meetings)'
    );
  } else {
    warn(
      'COS_AGENT_UPN',
      'meeting-capture poller will no-op — set the CoS agent\'s inviteable UPN to enable'
    );
  }

  // ── Capture Graph owner mode ──
  const ownerMode = (process.env.CAPTURE_GRAPH_OWNER?.trim() || 'cos-agent').toLowerCase();
  if (ownerMode === 'cos-agent') {
    info(
      `CAPTURE_GRAPH_OWNER=cos-agent — Graph paths use COS_AGENT_UPN. Teams application-access policy must be granted to the CoS agent UPN only (zero per-leader setup).`
    );
  } else if (ownerMode === 'leader') {
    info(
      `CAPTURE_GRAPH_OWNER=leader — Graph paths use LEADER_UPN. Teams application-access policy must be granted to each leader (or -Global).`
    );
  } else {
    warn(
      'CAPTURE_GRAPH_OWNER',
      `unrecognized value "${ownerMode}" — expected "cos-agent" or "leader". Defaulting to cos-agent.`
    );
  }

  // ── Graph auth mode ──
  const graphAppId = process.env.GRAPH_APP_ID?.trim();
  const graphAppSecret = process.env.GRAPH_APP_SECRET?.trim();
  const graphTenantId = process.env.GRAPH_TENANT_ID?.trim();
  if (graphAppId && graphAppSecret && graphTenantId) {
    ok(
      'GRAPH_APP_ID',
      maskGuid(graphAppId),
      'Graph calls use standalone worker app (application permissions)'
    );
  } else {
    err(
      'GRAPH_APP_ID / GRAPH_APP_SECRET / GRAPH_TENANT_ID',
      'required — every Graph call (Planner, people, calendar, transcripts) uses the standalone worker app. Run scripts/bootstrap-graph-app.ps1 (README §3b).'
    );
  }

  // ── Follow-up escalation ──
  const escalateAfter = process.env.FOLLOWUP_ESCALATE_AFTER_HOURS ?? '3';
  info(
    `FOLLOWUP_ESCALATE_AFTER_HOURS=${escalateAfter} — owners are escalated to leader if they don't reply within this window`
  );

  // ── State persistence ──
  info(describePersistence());

  // ── Runtime mode / WorkIQ MCP ──
  info(`NODE_ENV=${process.env.NODE_ENV ?? '<unset>'}`);
  info(
    'WorkIQ MCP servers are read from ToolingManifest.json (deploy it next to dist/) with a per-server agentic token. ' +
      (process.env.SKIP_TOOLING_ON_ERRORS?.trim().toLowerCase() === 'true'
        ? 'SKIP_TOOLING_ON_ERRORS=true — registration failures are logged and the turn continues without those tools.'
        : 'SKIP_TOOLING_ON_ERRORS=false — a registration failure fails the turn.')
  );

  line('─────────────────────────────────────────────');
}
