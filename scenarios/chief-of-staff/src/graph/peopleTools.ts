// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Graph-backed people/directory tools. Two use-cases:
//
//   graph_list_meeting_attendees — Given a Teams meeting chatId, list every
//     participant with {displayName, email, aadObjectId}. Used by Capture to
//     resolve transcript speaker names ("Alex", "Sam") to AAD Object IDs so
//     Planner assignments succeed.
//
//   graph_find_user — Best-effort directory search by displayName or email.
//     Used by Unblock to resolve stakeholder names mentioned in a blocker
//     message ("finance lead", "Sam Chen") to AAD Object IDs so the agent
//     can invite them to the unblock meeting.
//
// Both use the agent's agentic-user Graph token. Required Graph scopes
// (already granted on this app): Chat.ReadWrite, User.Read.All.

import axios from 'axios';
import { tool } from '@openai/agents';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { acquireAppOnlyGraphToken, isGraphAppConfigured } from './graphAppToken';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export interface PeopleToolOptions {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

// ─── UPN → AAD Object ID resolver (utility, not a tool) ────────────────────
// Called from stage handlers and agent.ts to avoid requiring the caller to
// hard-code AAD Object IDs in env. One Graph call per unique UPN per process
// lifetime — result is cached in-memory.
const upnAadCache = new Map<string, string>();

export async function resolveUpnToAad(
  upn: string | undefined,
  opts: PeopleToolOptions
): Promise<string | null> {
  if (!upn) return null;
  const key = upn.trim().toLowerCase();
  if (!key) return null;
  if (upnAadCache.has(key)) return upnAadCache.get(key)!;
  try {
    const token = await acquireGraphToken(opts);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${encodeURIComponent(key)}?$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const aad = res.data?.id ?? null;
    if (aad) upnAadCache.set(key, aad);
    return aad;
  } catch (err) {
    const e = err as any;
    console.warn(
      `[resolveUpnToAad] Failed to resolve "${key}":`,
      e?.response?.data ?? e?.message ?? String(e)
    );
    return null;
  }
}

// ─── AAD Object ID → UPN resolver (utility, not a tool) ───────────────────
// Inverse of resolveUpnToAad — used by the book_meeting flow so we can put
// the blocker owner on the calendar invite. Deterministic; no LLM.
const aadUpnCache = new Map<string, string>();

export async function resolveAadToUpn(
  aad: string | undefined,
  opts: PeopleToolOptions
): Promise<string | null> {
  if (!aad) return null;
  const key = aad.trim().toLowerCase();
  if (!key) return null;
  if (aadUpnCache.has(key)) return aadUpnCache.get(key)!;
  try {
    const token = await acquireGraphToken(opts);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${encodeURIComponent(key)}?$select=userPrincipalName`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const upn = (res.data?.userPrincipalName ?? '').toString().trim() || null;
    if (upn) aadUpnCache.set(key, upn);
    return upn;
  } catch (err) {
    const e = err as any;
    console.warn(
      `[resolveAadToUpn] Failed to resolve "${key}":`,
      e?.response?.data ?? e?.message ?? String(e)
    );
    return null;
  }
}

// ─── Team membership check (utility, not a tool) ──────────────────────────
// Returns the set of AAD Object IDs that are members of a given team (the
// Team's backing M365 Group). Cached per teamId for the process lifetime, with
// a short TTL so newly-added members are picked up within a few minutes.
interface TeamMembersEntry {
  members: Set<string>;
  fetchedAt: number;
}
const teamMembersCache = new Map<string, TeamMembersEntry>();
const TEAM_MEMBERS_TTL_MS = 5 * 60 * 1000;

// ─── Team identifier resolver (GUID | channel email | display name → GUID) ─
// Env-configured LEADERSHIP_TEAM_ID may be any of:
//   1. A raw M365 Group GUID          e.g. "44db7598-1234-abcd-…"
//   2. A Teams channel email          e.g. "44db7598.contoso.onmicrosoft.com@amer.teams.ms"
//   3. A Team display name            e.g. "Leadership Operations"
// We resolve once at first use and cache for the process lifetime, so no
// per-turn Graph cost after the first hit.
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const teamIdResolveCache = new Map<string, string>();

async function resolveTeamIdentifier(
  input: string,
  opts: PeopleToolOptions
): Promise<string | undefined> {
  let raw = input?.trim();
  if (!raw) return undefined;

  // Tolerate the Outlook "Display Name <email@domain>" copy-paste format —
  // extract what's inside the angle brackets and continue with that.
  const outlookMatch = raw.match(/<([^>]+)>/);
  if (outlookMatch) {
    raw = outlookMatch[1].trim();
  }

  // Fast path: already a GUID
  if (GUID_REGEX.test(raw)) return raw;

  // Cache lookup
  const cacheKey = raw.toLowerCase();
  const cached = teamIdResolveCache.get(cacheKey);
  if (cached) return cached;

  const token = await acquireGraphToken(opts);
  const isEmail = raw.includes('@');

  // Build a filter — for Teams channel emails, the hex prefix (before the
  // first '.') is the first 8 chars of the Group ID. We use that as a
  // startswith hint. For display names we do an exact match, scoped to
  // groups that are actually backed by Teams.
  const groupsUrl = new URL(`${GRAPH_BASE}/groups`);
  groupsUrl.searchParams.set('$select', 'id,displayName,mail');
  groupsUrl.searchParams.set('$top', '25');

  if (isEmail) {
    // Try three tactics in order:
    //   a) mail exactly equals the input (rarely matches for channel emails)
    //   b) proxyAddresses contains SMTP:<input>
    //   c) id startsWith <hex prefix> — recovered from the "44db7598." prefix
    // Graph doesn't allow startsWith on id, so (c) falls back to a filtered scan.
    const hexPrefix = raw.split('.', 1)[0];
    if (GUID_REGEX.test(hexPrefix + '-0000-0000-0000-000000000000')) {
      // hexPrefix is 8 valid hex chars — search groups where the id starts with it.
      try {
        const scanUrl = `${GRAPH_BASE}/groups?$select=id,displayName&$top=200`;
        let url: string | null = scanUrl;
        while (url) {
          const res: any = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
          for (const g of res.data?.value ?? []) {
            if (typeof g.id === 'string' && g.id.toLowerCase().startsWith(hexPrefix.toLowerCase())) {
              teamIdResolveCache.set(cacheKey, g.id);
              console.log(
                `[resolveTeamIdentifier] channel-email prefix "${hexPrefix}" → group "${g.displayName}" (${g.id})`
              );
              return g.id;
            }
          }
          url = res.data?.['@odata.nextLink'] ?? null;
        }
        console.warn(
          `[resolveTeamIdentifier] No group found with id starting "${hexPrefix}" — is the email a Teams channel address?`
        );
        return undefined;
      } catch (err) {
        const e = err as any;
        console.warn(
          `[resolveTeamIdentifier] group scan failed:`,
          e?.response?.data ?? e?.message ?? String(e)
        );
        return undefined;
      }
    }
    return undefined;
  }

  // Display name path
  try {
    groupsUrl.searchParams.set(
      '$filter',
      `displayName eq '${raw.replace(/'/g, "''")}' and resourceProvisioningOptions/Any(x:x eq 'Team')`
    );
    const res: any = await axios.get(groupsUrl.toString(), {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    });
    const groups = res.data?.value ?? [];
    if (groups.length === 0) {
      console.warn(`[resolveTeamIdentifier] No Team matches display name "${raw}"`);
      return undefined;
    }
    if (groups.length > 1) {
      console.warn(
        `[resolveTeamIdentifier] Multiple Teams named "${raw}" — using first (${groups[0].id})`
      );
    }
    const id = groups[0].id as string;
    teamIdResolveCache.set(cacheKey, id);
    console.log(`[resolveTeamIdentifier] display name "${raw}" → ${id}`);
    return id;
  } catch (err) {
    const e = err as any;
    console.warn(
      `[resolveTeamIdentifier] displayName lookup failed for "${raw}":`,
      e?.response?.data ?? e?.message ?? String(e)
    );
    return undefined;
  }
}

async function fetchTeamMemberAads(
  teamId: string,
  opts: PeopleToolOptions
): Promise<Set<string>> {
  const now = Date.now();
  const cached = teamMembersCache.get(teamId);
  if (cached && now - cached.fetchedAt < TEAM_MEMBERS_TTL_MS) {
    return cached.members;
  }
  const token = await acquireGraphToken(opts);
  const members = new Set<string>();
  // Paginate through /groups/{id}/members?$select=id
  let url: string | null =
    `${GRAPH_BASE}/groups/${encodeURIComponent(teamId)}/members?$select=id&$top=100`;
  while (url) {
    const res: any = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    for (const m of res.data?.value ?? []) {
      if (m.id) members.add(String(m.id).toLowerCase());
    }
    url = res.data?.['@odata.nextLink'] ?? null;
  }
  teamMembersCache.set(teamId, { members, fetchedAt: now });
  return members;
}

/**
 * Check whether a user (by AAD Object ID) is a member of a given Team.
 * `teamIdOrIdentifier` may be a GUID, a channel email, or a display name —
 * resolved once and cached.
 * Returns null when teamId is not set or cannot be resolved (caller should
 * treat as "allow all" / "unknown").
 */
export async function isUserInTeam(
  aadObjectId: string | undefined,
  teamIdOrIdentifier: string | undefined,
  opts: PeopleToolOptions
): Promise<boolean | null> {
  const raw = teamIdOrIdentifier?.trim();
  const aad = aadObjectId?.trim().toLowerCase();
  if (!raw) return null;
  if (!aad) return false;
  try {
    const tid = await resolveTeamIdentifier(raw, opts);
    if (!tid) return null; // couldn't resolve → treat as "allow all"
    const members = await fetchTeamMemberAads(tid, opts);
    return members.has(aad);
  } catch (err) {
    const e = err as any;
    console.warn(
      `[isUserInTeam] Failed for input="${raw}":`,
      e?.response?.data ?? e?.message ?? String(e)
    );
    return null;
  }
}

async function acquireGraphToken(opts: PeopleToolOptions): Promise<string> {
  // Preferred path: if a standalone Graph worker app is configured, use
  // application-permission client credentials. Simpler consent, cleaner
  // repro, no dependence on the agentic OBO chain being consented.
  if (isGraphAppConfigured()) {
    return acquireAppOnlyGraphToken();
  }

  // Fallback: agentic on-behalf-of exchange through the blueprint + instance
  // apps. Requires TurnContext + user consent on the instance app.
  const { authorization, context, authHandlerName } = opts;
  if (!authorization || !authHandlerName) {
    throw new Error(
      'No Graph credentials available. Either set GRAPH_APP_ID/GRAPH_APP_SECRET/GRAPH_TENANT_ID for the standalone worker, or provide an agentic auth handler.'
    );
  }
  const tokenObj = await (authorization as any).exchangeToken(context, authHandlerName, {
    scopes: [GRAPH_SCOPE],
  });
  const token = tokenObj?.token;
  if (!token) throw new Error('Graph token exchange returned empty token');
  return token;
}

// Re-exported for pollers / other Graph modules that need a token in the same
// context.
export { acquireGraphToken };

function toolError(name: string, err: unknown): string {
  const e = err as any;
  const msg = e?.response?.data ?? e?.message ?? String(e);
  console.error(`[peopleTools] ${name} failed:`, msg);
  return JSON.stringify({ ok: false, tool: name, error: msg });
}

interface Attendee {
  displayName: string;
  email: string | null;
  aadObjectId: string | null;
}

// ─── graph_list_meeting_attendees ──────────────────────────────────────────
interface ListAttendeesArgs {
  chatId: string;
}

function createListMeetingAttendeesTool(opts: PeopleToolOptions) {
  return tool({
    name: 'graph_list_meeting_attendees',
    description:
      'List every participant of a Teams meeting by looking at the meeting chat members. ' +
      'Returns an array of {displayName, email, aadObjectId}. Use this BEFORE creating Planner ' +
      'tasks from a meeting transcript to resolve speaker names to AAD Object IDs. ' +
      'The chatId is the meeting chat thread id (looks like 19:...@thread.v2 or ' +
      '19:meeting_...@thread.v2) — Power Automate transcript triggers include it in the payload.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: {
          type: 'string',
          description: 'Teams chat thread id for the meeting.',
        },
      },
      required: ['chatId'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as ListAttendeesArgs;
      try {
        if (!args.chatId) return toolError('graph_list_meeting_attendees', 'chatId is required');
        const token = await acquireGraphToken(opts);
        const res = await axios.get(
          `${GRAPH_BASE}/chats/${encodeURIComponent(args.chatId)}/members`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const attendees: Attendee[] = (res.data.value ?? []).map((m: any) => ({
          displayName: m.displayName ?? '',
          email: m.email ?? null,
          aadObjectId: m.userId ?? null,
        }));
        return JSON.stringify({ ok: true, count: attendees.length, attendees });
      } catch (err) {
        return toolError('graph_list_meeting_attendees', err);
      }
    },
  });
}

// ─── graph_find_user ───────────────────────────────────────────────────────
interface FindUserArgs {
  query: string;
}

function createFindUserTool(opts: PeopleToolOptions) {
  return tool({
    name: 'graph_find_user',
    description:
      'Search the Entra directory for users by display name, given name, surname, mail, or UPN. ' +
      'Returns up to 5 matches ranked by relevance, each with {displayName, mail, aadObjectId, ' +
      'jobTitle, department}. Use this to resolve a name mentioned in a message ' +
      '(e.g. "Sam", "finance lead") to an AAD Object ID for Planner assignment or Teams DM. ' +
      'If multiple matches come back, prefer the one whose jobTitle/department best matches the ' +
      'context. If nothing sensible matches, do not fabricate — say so plainly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'A person\'s name, email, or partial name to search for. Case-insensitive, matches ' +
            'against displayName / givenName / surname / mail / userPrincipalName.',
        },
      },
      required: ['query'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as FindUserArgs;
      try {
        const q = (args.query ?? '').trim();
        if (!q) return toolError('graph_find_user', 'query is required');
        const token = await acquireGraphToken(opts);
        // Use $search (needs ConsistencyLevel: eventual) so we can match on multiple fields.
        const escaped = q.replace(/"/g, '\\"');
        const url =
          `${GRAPH_BASE}/users` +
          `?$search=` +
          encodeURIComponent(
            `"displayName:${escaped}" OR "givenName:${escaped}" OR "surname:${escaped}" ` +
              `OR "mail:${escaped}" OR "userPrincipalName:${escaped}"`
          ) +
          `&$select=id,displayName,mail,userPrincipalName,jobTitle,department` +
          `&$top=5`;
        const res = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            ConsistencyLevel: 'eventual',
          },
        });
        const matches = (res.data.value ?? []).map((u: any) => ({
          displayName: u.displayName ?? '',
          mail: u.mail ?? u.userPrincipalName ?? null,
          aadObjectId: u.id ?? null,
          jobTitle: u.jobTitle ?? null,
          department: u.department ?? null,
        }));
        return JSON.stringify({ ok: true, count: matches.length, matches });
      } catch (err) {
        return toolError('graph_find_user', err);
      }
    },
  });
}

// ─── Public factory ────────────────────────────────────────────────────────
export function createPeopleTools(opts: PeopleToolOptions) {
  return [createListMeetingAttendeesTool(opts), createFindUserTool(opts)];
}
