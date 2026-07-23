// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Auto-resolves the Planner plan ID and bucket ID at runtime from the
// LEADERSHIP_TEAM_ID, so setup only needs the team identifier (not two
// extra Planner GUIDs).
//
// Resolution order for PLAN:
//   1. PLANNER_PLAN_ID env → use directly (backwards compat)
//   2. LEADERSHIP_TEAM_ID → resolve to group ID (GUID / display name /
//      channel email) → GET /groups/{groupId}/planner/plans:
//        - If PLANNER_PLAN_NAME set → match by exact case-insensitive name
//        - Else if exactly one plan → use it
//        - Else → warn + return undefined
//
// Resolution order for BUCKET:
//   1. PLANNER_BUCKET_NEW env → use directly (backwards compat)
//   2. Auto-resolve plan (getPlannerPlanId) → GET /planner/plans/{id}/buckets:
//        - Find bucket named PLANNER_BUCKET_NAME (default "New")
//        - Case-insensitive exact match
//        - Else → warn + return undefined
//
// Both resolutions are memoized after first success. Failures are cached
// negatively for a short window so we don't hammer Graph on every tick.

import axios from 'axios';
import { acquireAppOnlyGraphToken } from './graphAppToken';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEGATIVE_CACHE_MS = 60 * 1000; // don't re-try a known failure for 60s

// Memoized values.
let cachedPlanId: string | undefined;
let cachedBucketId: string | undefined;
let cachedGroupId: string | undefined;
let lastResolveFailureAt = 0;

interface GraphGroup {
  id: string;
  displayName?: string;
}

interface GraphPlan {
  id: string;
  title: string;
}

interface GraphBucket {
  id: string;
  name: string;
}

/**
 * Resolves a LEADERSHIP_TEAM_ID env value (GUID / display name / channel
 * email) to a group Object ID. Uses the standalone Graph worker's app-only
 * token — no TurnContext required, safe to call at boot or from schedulers.
 * Memoized per process.
 */
async function resolveGroupId(rawInput: string): Promise<string | undefined> {
  if (cachedGroupId) return cachedGroupId;
  const raw = rawInput.trim().replace(/^<|>$/g, ''); // tolerate "<name>" copy-paste
  if (!raw) return undefined;

  // Fast path — already a GUID.
  if (GUID_REGEX.test(raw)) {
    cachedGroupId = raw;
    return raw;
  }

  const token = await acquireAppOnlyGraphToken();

  // Channel email path — take the 8-hex-char prefix and scan groups.
  if (raw.includes('@')) {
    const hexPrefix = raw.split('.', 1)[0];
    if (/^[0-9a-f]{8}$/i.test(hexPrefix)) {
      try {
        let url: string | null =
          `${GRAPH_BASE}/groups?$select=id,displayName&$top=200`;
        while (url) {
          const res: { data: { value?: GraphGroup[]; '@odata.nextLink'?: string } } = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          for (const g of (res.data?.value ?? []) as GraphGroup[]) {
            if (g.id?.toLowerCase().startsWith(hexPrefix.toLowerCase())) {
              cachedGroupId = g.id;
              console.log(
                `[plannerConfig] LEADERSHIP_TEAM_ID channel-email "${raw}" → group "${g.displayName ?? g.id}" (${g.id.slice(0, 8)}…)`
              );
              return g.id;
            }
          }
          url = res.data?.['@odata.nextLink'] ?? null;
        }
      } catch (err) {
        console.warn(
          `[plannerConfig] channel-email lookup failed for "${raw}":`,
          (err as any)?.response?.data ?? (err as Error)?.message
        );
      }
      console.warn(
        `[plannerConfig] No group id starts with "${hexPrefix}" — is the channel email correct?`
      );
      return undefined;
    }
    return undefined;
  }

  // Display name path — filter groups by exact name + Team resource kind.
  try {
    const url =
      `${GRAPH_BASE}/groups?$select=id,displayName` +
      `&$filter=displayName eq '${raw.replace(/'/g, "''")}'` +
      ` and resourceProvisioningOptions/Any(x:x eq 'Team')&$top=25`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual',
      },
    });
    const groups = (res.data?.value ?? []) as GraphGroup[];
    if (groups.length === 0) {
      console.warn(
        `[plannerConfig] No Team found with display name "${raw}" — check LEADERSHIP_TEAM_ID`
      );
      return undefined;
    }
    if (groups.length > 1) {
      console.warn(
        `[plannerConfig] Multiple Teams named "${raw}" — using first (${groups[0].id.slice(0, 8)}…)`
      );
    }
    cachedGroupId = groups[0].id;
    console.log(
      `[plannerConfig] LEADERSHIP_TEAM_ID display name "${raw}" → group ${groups[0].id.slice(0, 8)}…`
    );
    return cachedGroupId;
  } catch (err) {
    console.warn(
      `[plannerConfig] display-name lookup failed for "${raw}":`,
      (err as any)?.response?.data ?? (err as Error)?.message
    );
    return undefined;
  }
}

async function autoResolvePlanId(): Promise<string | undefined> {
  const teamId = process.env.LEADERSHIP_TEAM_ID?.trim();
  if (!teamId) {
    console.warn(
      '[plannerConfig] PLANNER_PLAN_ID not set AND LEADERSHIP_TEAM_ID not set — cannot auto-resolve Planner plan.'
    );
    return undefined;
  }
  const groupId = await resolveGroupId(teamId);
  if (!groupId) return undefined;

  try {
    const token = await acquireAppOnlyGraphToken();
    const res = await axios.get(
      `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/planner/plans?$select=id,title&$top=25`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const plans = (res.data?.value ?? []) as GraphPlan[];
    if (plans.length === 0) {
      console.warn(
        `[plannerConfig] No Planner plans found under group ${groupId.slice(0, 8)}… — create one in the Team first`
      );
      return undefined;
    }

    const wantName = process.env.PLANNER_PLAN_NAME?.trim();
    if (wantName) {
      const match = plans.find(
        (p) => p.title?.toLowerCase() === wantName.toLowerCase()
      );
      if (!match) {
        console.warn(
          `[plannerConfig] No plan named "${wantName}" under group ${groupId.slice(0, 8)}… — found: ${plans.map((p) => `"${p.title}"`).join(', ')}`
        );
        return undefined;
      }
      console.log(
        `[plannerConfig] PLANNER_PLAN_NAME="${wantName}" → plan ${match.id} (${plans.length} plan(s) in team)`
      );
      return match.id;
    }

    if (plans.length > 1) {
      console.warn(
        `[plannerConfig] ${plans.length} plans found in team but PLANNER_PLAN_NAME not set — cannot auto-pick. Set PLANNER_PLAN_NAME to one of: ${plans.map((p) => `"${p.title}"`).join(', ')}`
      );
      return undefined;
    }

    const chosen = plans[0];
    console.log(
      `[plannerConfig] Auto-resolved plan: "${chosen.title}" (${chosen.id}) — the only plan in team ${groupId.slice(0, 8)}…`
    );
    return chosen.id;
  } catch (err) {
    console.warn(
      `[plannerConfig] listing plans for group ${groupId} failed:`,
      (err as any)?.response?.data ?? (err as Error)?.message
    );
    return undefined;
  }
}

async function autoResolveBucketId(planId: string): Promise<string | undefined> {
  const wantName = process.env.PLANNER_BUCKET_NAME?.trim() || 'New';
  try {
    const token = await acquireAppOnlyGraphToken();
    const res = await axios.get(
      `${GRAPH_BASE}/planner/plans/${encodeURIComponent(planId)}/buckets`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const buckets = (res.data?.value ?? []) as GraphBucket[];
    if (buckets.length === 0) {
      console.warn(
        `[plannerConfig] No buckets found in plan ${planId} — create one named "New" in the plan`
      );
      return undefined;
    }
    const match = buckets.find(
      (b) => (b.name ?? '').toLowerCase() === wantName.toLowerCase()
    );
    if (!match) {
      console.warn(
        `[plannerConfig] No bucket named "${wantName}" in plan ${planId} — found: ${buckets.map((b) => `"${b.name}"`).join(', ')}. Rename a bucket or set PLANNER_BUCKET_NAME.`
      );
      return undefined;
    }
    console.log(
      `[plannerConfig] Auto-resolved bucket: "${match.name}" (${match.id}) in plan ${planId.slice(0, 8)}…`
    );
    return match.id;
  } catch (err) {
    console.warn(
      `[plannerConfig] listing buckets for plan ${planId} failed:`,
      (err as any)?.response?.data ?? (err as Error)?.message
    );
    return undefined;
  }
}

/**
 * Returns the Planner plan ID to use for all CoS work. Env override wins;
 * otherwise auto-resolves from LEADERSHIP_TEAM_ID + optional PLANNER_PLAN_NAME.
 * Memoized. Negative results are cached for NEGATIVE_CACHE_MS so we don't
 * flood Graph on every scheduler tick when misconfigured.
 */
export async function getPlannerPlanId(): Promise<string | undefined> {
  if (cachedPlanId) return cachedPlanId;

  const explicit = process.env.PLANNER_PLAN_ID?.trim();
  if (explicit) {
    cachedPlanId = explicit;
    return explicit;
  }

  if (Date.now() - lastResolveFailureAt < NEGATIVE_CACHE_MS) return undefined;

  const resolved = await autoResolvePlanId();
  if (resolved) {
    cachedPlanId = resolved;
  } else {
    lastResolveFailureAt = Date.now();
  }
  return resolved;
}

/**
 * Returns the Planner bucket ID to drop new tasks into. Env override wins;
 * otherwise auto-resolves via the plan → find bucket named "New" (or
 * PLANNER_BUCKET_NAME).
 */
export async function getPlannerBucketId(): Promise<string | undefined> {
  if (cachedBucketId) return cachedBucketId;

  const explicit = process.env.PLANNER_BUCKET_NEW?.trim();
  if (explicit) {
    cachedBucketId = explicit;
    return explicit;
  }

  const planId = await getPlannerPlanId();
  if (!planId) return undefined;

  if (Date.now() - lastResolveFailureAt < NEGATIVE_CACHE_MS) return undefined;

  const resolved = await autoResolveBucketId(planId);
  if (resolved) {
    cachedBucketId = resolved;
  } else {
    lastResolveFailureAt = Date.now();
  }
  return resolved;
}

/**
 * Warm the caches at boot. Prints resolution results in the startup banner.
 * Safe to call multiple times — subsequent calls just return the cached
 * values. Failure to resolve is NOT fatal — the flows that need a plan
 * simply skip (same behaviour as before persistence).
 */
export async function warmPlannerConfig(): Promise<{
  planId: string | undefined;
  bucketId: string | undefined;
}> {
  const planId = await getPlannerPlanId();
  const bucketId = await getPlannerBucketId();
  return { planId, bucketId };
}

/** For tests only. */
export function resetPlannerConfigCache(): void {
  cachedPlanId = undefined;
  cachedBucketId = undefined;
  cachedGroupId = undefined;
  lastResolveFailureAt = 0;
}
